// dsh-highres-vision  v0.3.2
//
// 整合：
//   0a. 仅 DeepSeek 系列模型启用（lib/model-detect.js，v0.3.0 新增）
//   0b. 自动抬升 DeepSeek 适配器「每模型图片预算」（lib/model-budget.js，v0.3.0 新增）
//   1. 放宽 DSH 本地图片准入到 DeepSeek 官方 API 上限（cordis.patch.yml）
//   2. 提供 highres_read 工具：自动定位会话中的用户图片，
//      生成 整图 + <=tile 高清分块（默认 1300x1300），并通过宿主 read_image 注入模型
//   3. agent/pre-step 提醒：用户发大图（且图片实际大于 tile）后，
//      若模型还未调用 highres_read，提醒先调用本工具。
// 注意：不覆盖宿主 read_image，read_image 保持原样。
// 纯 Node 实现，无外部 Python/Pillow 依赖。
//
// ── v0.3.2（harness 0.1.2-rc.1 内核兼容修复）─────────────────────────────
// findLatestSessionImage() 原读 `session.events`，但 0.1.2-rc.1 的
// @deepseek-ai/dsh-session 里 Session 只暴露 snapshotEvents() / ownEvents() /
// eventAt() / seq，**没有 `events` 属性** → 判定恒为 undefined，
// 「不传参数、自动取会话最近一张用户图」这条最常用的调用路径恒失败
// （返回 file_path/image/attachmentId is required）。
// v0.3.2 改读 session.snapshotEvents()，并保留 `events` 作更旧内核的回退。
// 同时导出 sessionEvents / findLatestSessionImage，供 verify.mjs 回归。
//
// ── 仅 DeepSeek 系列启用（deepseekOnly，默认 true）────────────────────────
// 按 agent 判定当前会话的 provider/model，非 DeepSeek 时对那个 agent 屏蔽
// highres_read（内核 `agent.ctx.tools.restrict({ deny })`，只影响该 agent），
// 同时不注入 pre-step 提醒。判定优先级照抄内核 api-session-controller：
//   modelSelection 投影的 pending → session.requestHeader().config → agentDefaultModel
// 判定不出时按 unknownModelPolicy（默认 allow）处理。
// 详见 lib/model-detect.js。
//
// ── v0.3.0（对齐 DeepSeek-V4.1-Flash，2026-09-10 上线）────────────────────
// v0.2.1 把分块基线抬到 1300 后，还差最后一段：宿主的 dsh-llm-deepseek 会按
// **每个模型**的 imagePixelBudget / imageMaxBytes 把图片再投影一次，内核默认是
// 640000（≈800x800）/ 1 MiB —— 不改它，1300 的分块仍会在请求前被压回 800x800。
//
// v0.3.0 把这一步做进插件：加载时通过 `settings.update('llm-deepseek', ...)`
// 自动给**已声明图片模态**的模型补上/抬高这两个字段。
//   * 走内核给配置界面用的正规写入路径（schema 校验 + revision 冲突检测 + 串行写队列）
//   * 只加字段、只抬不降、不动纯文本模型、不覆盖显式的 `imagePixelBudget: "low"`
//   * 只在真的需要改时才写盘，写完后自身触发的 settings/updated 会自检收敛
//   * 落盘后适配器立刻换源 → **立即生效，无需重启 DSH**
// 详见 lib/model-budget.js 头部注释（含「为什么不能写进 cordis.patch.yml」）。
//
// v0.2.1 相对 v0.2.0 的变更：
//   - cordis.patch.yml：llm-deepseek 的配置键 maxRequestImageBytes
//     → maxInlineRequestImageBytes（harness 0.1.2-rc.1 已改键名，旧键是 no-op）。
//   - 分块基线 800 → 1300：V4.1-Flash 的官方视觉投影把图片缩放到约 1300x1300
//     像素等效、单图 token 上限 1024（旧 V4-Flash-Vision-Exp 是 800x800 / 384）。
//   - tile / overlap / 提醒阈值改为可配置，默认值与方法体一并从 lib/tile.js 取。

import { join, isAbsolute } from 'node:path'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tileImage, TILE_SIZE } from './tile.js'
import {
  DEEPSEEK_SETTINGS_NS,
  TARGET_PIXEL_BUDGET,
  TARGET_MAX_BYTES,
  applyModelBudgetRaise,
} from './model-budget.js'
import {
  UNKNOWN_POLICY_DENY,
  decideAgentGate,
} from './model-detect.js'

export const name = 'dsh-highres-vision'
export const inject = ['tools', 'agents']

/** 工具名：注册、按 agent 屏蔽、pre-step 判定都要用同一份。 */
const TOOL_NAME = 'highres_read'
/** 默认分块边长：V4.1-Flash 约 1300x1300 的等效像素预算。 */
const DEFAULT_TILE = TILE_SIZE
/** 默认提醒阈值：与分块边长一致（超过就值得分块）。 */
const DEFAULT_REMIND_THRESHOLD = DEFAULT_TILE

/** 解析本次调用真正使用的分块边长：显式参数 > 插件配置 > 默认值。 */
function resolveTile(args, config) {
  const raw = args?.tile ?? config?.tile ?? DEFAULT_TILE
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_TILE
}

/** 解析提醒阈值：显式配置 > 2% 余量于分块边长。 */
function resolveRemindThreshold(config, tile) {
  const raw = config?.remindThreshold
  if (raw !== undefined && raw !== null) {
    const n = Number(raw)
    if (Number.isFinite(n) && n > 0) return Math.round(n)
  }
  return tile > 0 ? tile : DEFAULT_REMIND_THRESHOLD
}

/** 正整数化，非法值返回 fallback。 */
function positiveInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback
}

/** 解析模型预算抬升的配置。 */
function resolveBudgetOptions(config) {
  return {
    enabled: config?.autoRaiseModelBudget !== false,
    pixelBudget: positiveInt(config?.modelImagePixelBudget, TARGET_PIXEL_BUDGET),
    maxBytes: positiveInt(config?.modelImageMaxBytes, TARGET_MAX_BYTES),
    // 默认只改 DeepSeek 系列条目；modelBudgetScope: 'all' 放开为「该命名空间下所有视觉模型」。
    deepseekScope: config?.modelBudgetScope !== 'all',
  }
}

/** 解析「仅 DeepSeek 系列启用」的配置。 */
function resolveGateOptions(config) {
  return {
    enabled: config?.deepseekOnly !== false,
    unknownPolicy: config?.unknownModelPolicy === UNKNOWN_POLICY_DENY ? UNKNOWN_POLICY_DENY : 'allow',
  }
}

/**
 * 装配「仅 DeepSeek 系列模型启用」的按会话开关。
 *
 * 做法：`highres_read` 照常全局注册一次，再对判定为「非 DeepSeek」的 agent
 * 挂一条 `agent.ctx.tools.restrict({ deny: ['highres_read'] })` —— 内核明确
 * 支持按 agent scope 屏蔽全局工具（见 lib/model-detect.js 头部说明），
 * 解除只需 dispose。不用反复注册/注销，也不会影响别的 agent。
 *
 * 重新判定时机：
 *   - agent/created           新会话
 *   - session/event(model/selection)  用户切换模型
 *   - agent/pre-step          兜底（每个 model step 前重算一次）
 *
 * @param ctx - 插件上下文。
 * @param options - enabled / unknownPolicy。
 * @returns `isAllowed(agent)` 判定函数，供 pre-step 与工具执行复用。
 */
function installModelGate(ctx, options) {
  const restrictions = new Map()
  const sessionOwners = new Map()

  const apply = (agent) => {
    const decision = decideAgentGate(ctx, agent, options)
    const held = restrictions.get(agent)
    if (decision.allowed) {
      if (held !== undefined) {
        try { held.dispose() } catch { /* 已解除 */ }
        restrictions.delete(agent)
      }
      return decision
    }
    if (held === undefined) {
      try {
        const dispose = agent.ctx.tools.restrict({ deny: [TOOL_NAME] })
        restrictions.set(agent, dispose)
      } catch (error) {
        // restrict 失败不该带崩别的功能：退化成「工具可见但执行时拒绝」。
        ctx.logger?.warn?.(
          `dsh-highres-vision: 无法为 agent ${agent?.id ?? '?'} 屏蔽 ${TOOL_NAME}（${error?.message ?? String(error)}）；`
          + '将退化为执行时校验',
        )
      }
    }
    return decision
  }

  /** 供 pre-step 与工具执行使用：读当前判定，不再重复挂限制。 */
  const isAllowed = (agent) => {
    if (options.enabled === false) return true
    if (restrictions.has(agent)) return false
    return apply(agent).allowed
  }

  if (options.enabled) {
    ctx.on('agent/created', ({ agent }) => {
      if (agent?.session !== undefined) sessionOwners.set(agent.session, agent)
      apply(agent)
    })
    ctx.on('agent/disposed', ({ agent }) => {
      if (agent?.session !== undefined) sessionOwners.delete(agent.session)
      const held = restrictions.get(agent)
      if (held !== undefined) {
        try { held.dispose() } catch { /* 已解除 */ }
        restrictions.delete(agent)
      }
    })
    ctx.on('session/event', (session, event) => {
      if (event?.type !== 'model/selection') return
      const agent = sessionOwners.get(session)
      if (agent !== undefined) apply(agent)
    })
  }

  return { isAllowed, apply }
}

/**
 * 装配「每模型图片预算自动抬升」。
 *
 * 用 ctx.inject 做软依赖：settings 服务缺失（非 web 宿主、裁剪部署）时
 * 本插件其余功能照常工作，只是不做预算抬升。
 *
 * 收敛性：我们自己的写入会触发 settings/updated，监听器随即自检；
 * 此时目标已达成 → 不再写 → 事件链自然终止。再加一个 inFlight 闸门
 * 防止并发重入。
 *
 * @param ctx - 插件上下文。
 * @param options - enabled / pixelBudget / maxBytes / deepseekScope。
 */
function installModelBudget(ctx, options) {
  if (!options.enabled) return

  let inFlight = false
  const attempt = (settings, trigger) => {
    if (inFlight) return
    inFlight = true
    applyModelBudgetRaise(settings, {
      ns: DEEPSEEK_SETTINGS_NS,
      pixelBudget: options.pixelBudget,
      maxBytes: options.maxBytes,
      deepseekScope: options.deepseekScope,
      logger: ctx.logger,
    }).then((result) => {
      if (result.changed) {
        const detail = result.changes
          .map((c) => `${c.id} → imagePixelBudget=${c.to.imagePixelBudget ?? c.from.imagePixelBudget}, imageMaxBytes=${c.to.imageMaxBytes ?? c.from.imageMaxBytes}`)
          .join('; ')
        const scope = options.deepseekScope ? '仅 DeepSeek 条目' : '全部条目'
        ctx.logger?.info?.(
          `dsh-highres-vision: 已抬升 ${DEEPSEEK_SETTINGS_NS} 模型图片预算（${trigger}，${scope}）：${detail}`,
        )
      } else if (!result.ok && result.reason !== 'no-models') {
        ctx.logger?.warn?.(
          `dsh-highres-vision: 模型图片预算未抬升（${trigger}，原因 ${result.reason}）。`,
        )
      }
    }).catch((error) => {
      ctx.logger?.warn?.('dsh-highres-vision: 模型图片预算抬升异常', error)
    }).finally(() => { inFlight = false })
  }

  ctx.inject(['settings'], (settingsCtx) => {
    attempt(settingsCtx.settings, 'load')
    settingsCtx.on('settings/updated', (ns) => {
      if (ns !== DEEPSEEK_SETTINGS_NS) return
      attempt(settingsCtx.settings, 'settings/updated')
    })
  })
}

/**
 * 取会话事件序列（内核版本适配）。
 *
 * harness 0.1.2-rc.1 的 Session 只暴露 snapshotEvents() / ownEvents() /
 * eventAt() / seq，**没有** `events` 属性（见 @deepseek-ai/dsh-session 的
 * Session 类定义）。v0.3.1 及更早版本这里直接读 `session.events`，于是在
 * 0.1.2-rc.1 上「无参数自动取会话最近一张用户图」这条路径恒为 undefined，
 * highres_read 会以 “file_path/image/attachmentId is required” 直接失败。
 *
 * 按内核现行 API 读快照，并保留 `events` 作为更旧内核的回退。
 *
 * 导出（v0.3.2 起）唯一目的是让 verify.mjs 能直接回归这条路径 ——
 * 它此前只在 highres_read 的执行链里被间接用到，自检覆盖不到。
 */
export function sessionEvents(session) {
  if (!session) return undefined
  try {
    if (typeof session.snapshotEvents === 'function') {
      const snapshot = session.snapshotEvents()
      if (Array.isArray(snapshot)) return snapshot
    }
  } catch { /* 内核实现异常 → 走回退 */ }
  return Array.isArray(session.events) ? session.events : undefined
}

/** 同 sessionEvents：导出供 verify.mjs 回归（v0.3.2 起）。 */
export function findLatestSessionImage(exec) {
  const events = sessionEvents(exec?.agent?.session)
  if (!Array.isArray(events)) return undefined
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'user/message') continue
    const content = event?.data?.content ?? []
    for (let j = content.length - 1; j >= 0; j--) {
      const block = content[j]
      if (block?.type === 'image' && block.attachment?.attachmentId) {
        return {
          attachmentId: block.attachment.attachmentId,
          mediaType: block.attachment.mediaType,
          width: block.attachment.width,
          height: block.attachment.height,
          name: block.attachment.name,
        }
      }
    }
  }
  return undefined
}

function renderValue(value) {
  if (!value || typeof value !== 'object') {
    return [{ type: 'text', text: String(value ?? '') }]
  }
  if (value.ok === false) {
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  }
  const items = Array.isArray(value.items) ? value.items : []
  if (items.length === 0) {
    return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  }
  const blocks = []
  for (const item of items) {
    blocks.push({
      type: 'text',
      text: `${item.label}\n<path>${item.path}</path>\n${item.image?.mediaType ?? ''} ${item.image?.width}x${item.image?.height} px`,
    })
    if (item.image) {
      blocks.push({
        type: 'image',
        attachment: {
          attachmentId: item.image.attachmentId,
          mediaType: item.image.mediaType,
          bytes: item.image.bytes,
          width: item.image.width,
          height: item.image.height,
          ...(item.image.name ? { name: item.image.name } : {}),
        },
      })
    }
  }
  return blocks
}

/** 极简工具构造器，替代 @deepseek-ai/dsh-tools 的 defineTool。 */
function buildTool(spec) {
  return {
    ...spec,
    parameters: toJsonSchema(spec.parameters),
    output: spec.output,
  }
}

/** 极简 JSON Schema 编译，替代 @deepseek-ai/dsh-tools 的 defineTool。 */
function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec || {})) {
    properties[key] = { type: meta.type }
    if (meta.description) properties[key].description = meta.description
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/** 极简用户消息构造，替代 @deepseek-ai/dsh-llm 的 createUserMessage。 */
function makeUserMessage(text) {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-highres-vision' },
    id: `highres-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  }
}

function hasImageInMessages(messages) {
  if (!Array.isArray(messages)) return false
  for (const message of messages) {
    if (message?.role !== 'user') continue
    const content = message?.content
    if (!Array.isArray(content)) continue
    if (content.some((block) => block?.type === 'image')) return true
  }
  return false
}

/**
 * 是否有“值得分块”的大图：宽或高 > threshold（默认 1300）。
 * 尺寸信息缺失时保守返回 true（宁可提醒一次，也不漏掉大图）。
 */
function hasLargeImageInMessages(messages, threshold = DEFAULT_REMIND_THRESHOLD) {
  if (!Array.isArray(messages)) return false
  for (const message of messages) {
    if (message?.role !== 'user') continue
    const content = message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type !== 'image') continue
      const w = block.attachment?.width ?? block.width ?? 0
      const h = block.attachment?.height ?? block.height ?? 0
      if (w > threshold || h > threshold) return true
      if (!w && !h) return true // 未知尺寸，保守提醒
    }
  }
  return false
}

function hasCalledHighresTool(messages) {
  if (!Array.isArray(messages)) return false
  for (const message of messages) {
    if (message?.role !== 'assistant') continue
    const content = message?.content
    if (!Array.isArray(content)) continue
    if (content.some((block) => block?.type === 'tool-call' && block?.name === TOOL_NAME)) return true
  }
  return false
}

export function apply(ctx, config = {}) {
  const configuredTile = resolveTile({}, config)
  const remindThreshold = resolveRemindThreshold(config, configuredTile)
  const remindEnabled = config?.remind !== false

  // 0a) 按会话判定「是否 DeepSeek 系列」，非 DeepSeek 时对那个 agent 屏蔽本工具
  const gate = installModelGate(ctx, resolveGateOptions(config))
  const allowedFor = (agent) => gate.isAllowed(agent)

  // 0b) 抬升 DeepSeek 适配器的每模型图片预算（默认开启；settings 是软依赖）
  installModelBudget(ctx, resolveBudgetOptions(config))

  async function resolveInputPath(args, emitDir, exec) {
    if (args.attachmentId) {
      const id = String(args.attachmentId).replace(/^sha256:/i, '').trim().toLowerCase()
      if (!/^[a-f0-9]{64}$/.test(id)) {
        throw new Error('attachmentId must be a 64-char hex hash')
      }
      const dshHome = process.env.DSH_HOME ?? ''
      if (!dshHome) {
        throw new Error('cannot resolve attachmentId: DSH_HOME is not set')
      }
      const objectPath = join(dshHome, 'attachments', 'v1', 'objects', id.slice(0, 2), id)
      const bytes = await readFile(objectPath)
      const inputPath = join(emitDir, 'input.img')
      await writeFile(inputPath, bytes)
      return inputPath
    }
    const workspace = exec?.agent?.session?.header?.cwd ?? process.cwd()
    const filePath = args.file_path ?? args.image
    if (filePath) return isAbsolute(filePath) ? filePath : join(workspace, filePath)

    // 无参数时自动使用当前会话最近一张用户附件图片
    const latest = findLatestSessionImage(exec)
    if (!latest) {
      throw new Error('file_path/image/attachmentId is required, or attach an image in this session')
    }
    const dshHome = process.env.DSH_HOME ?? ''
    if (!dshHome) {
      throw new Error('cannot resolve session image: DSH_HOME is not set')
    }
    const id = String(latest.attachmentId).replace(/^sha256:/i, '').trim().toLowerCase()
    const objectPath = join(dshHome, 'attachments', 'v1', 'objects', id.slice(0, 2), id)
    const bytes = await readFile(objectPath)
    const inputPath = join(emitDir, 'input.img')
    await writeFile(inputPath, bytes)
    return inputPath
  }

  async function runHighresRead(exec, args) {
    let emitDir
    try {
      // 兜底校验：正常情况下非 DeepSeek 会话里本工具已被 restrict 屏蔽，
      // 这里再挡一次，覆盖 agent/created 早于本插件装配等边界。
      const agent = exec?.agent
      if (agent !== undefined && !allowedFor(agent)) {
        return {
          ok: false,
          tool: TOOL_NAME,
          error: 'highres_read 仅在 DeepSeek 系列模型下可用（可用 deepseekOnly: false 关闭该限制）。',
        }
      }

      const readTool = agent ? ctx.tools.get('read_image', agent) : undefined
      if (!readTool) {
        return { ok: false, error: 'read_image tool not available for this agent.' }
      }

      const workspace = agent?.session?.header?.cwd ?? process.cwd()
      emitDir = join(workspace, '.dsh-highres-vision', String(Date.now()))
      await mkdir(emitDir, { recursive: true })

      const inputPath = await resolveInputPath(args, emitDir, exec)
      const tile = resolveTile(args, config)

      const plan = await tileImage(inputPath, {
        emitDir,
        tile,
        overlap: args.overlap ?? config.overlap ?? 0,
        skipWhole: Boolean(args.skipWhole),
        maxTiles: args.maxTiles && args.maxTiles > 0 ? args.maxTiles : 0,
      })
      if (!plan.ok) {
        return { ok: false, error: plan.error ?? 'tile generation failed' }
      }

      const metas = []
      if (plan.whole?.path) {
        metas.push({ label: '整图', path: plan.whole.path, box: plan.whole.box })
      }
      for (const tileMeta of plan.tiles ?? []) {
        metas.push({ label: `块${tileMeta.index}`, path: tileMeta.path, box: tileMeta.box })
      }

      const items = []
      for (const meta of metas) {
        const result = await readTool.execute({ file_path: meta.path }, exec)
        if (!result || !result.image) {
          throw new Error(`read_image failed for ${meta.path}`)
        }
        items.push({ ...meta, image: result.image })
      }

      await rm(emitDir, { recursive: true, force: true })

      return {
        ok: true,
        originalSize: plan.originalSize ?? null,
        strategy: plan.strategy ?? null,
        tileSize: plan.tileSize ?? null,
        overlap: plan.overlap ?? null,
        tileCount: plan.tileCount ?? items.length,
        items,
      }
    } catch (err) {
      if (emitDir) {
        try { await rm(emitDir, { recursive: true, force: true }) } catch {}
      }
      return {
        tool: 'highres_read',
        ok: false,
        error: err?.message ?? String(err),
      }
    }
  }

  // 1) 注册 highres_read 工具
  ctx.effect(() => ctx.tools.register(buildTool({
    name: TOOL_NAME,
    description:
      '高清分块识图工具。识别/OCR/分析用户上传的大图时，必须先调用本工具。' +
      `它会自动定位当前会话最近一张用户图片，生成 整图 + <=${configuredTile}x${configuredTile} 高清分块，` +
      `并把整图和每个分块作为图片返回，避免模型只看到被压缩到 ${configuredTile}px 的单张原图。` +
      '不传参数时自动使用当前会话最近一张用户附件图片。',
    parameters: {
      file_path: {
        type: 'string',
        description: '要识别的图片本地路径（png/jpg/jpeg/webp/bmp 等）；与 attachmentId 二选一。',
      },
      attachmentId: {
        type: 'string',
        description: 'DSH 附件服务中的 attachmentId（64 位 hex 哈希，可带 sha256: 前缀）。',
      },
      tile: {
        type: 'number',
        description: `单块最大边长，默认 ${configuredTile}（对齐 DeepSeek-V4.1-Flash 约 ${configuredTile}px 的等效像素预算）；超过该值自动分块。`,
      },
      overlap: {
        type: 'number',
        description: '块间重叠像素；0=自动（按原图分辨率与分块边长选 5%/10%/15%）。',
      },
      skipWhole: {
        type: 'boolean',
        description: '设为 true 时不返回整图，只返回分块。',
      },
      maxTiles: {
        type: 'number',
        description: '最多返回多少个子块，0 表示不限。',
      },
    },
    timeoutMs: 600_000,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => renderValue(value),
    },
    async execute(args, exec) {
      return runHighresRead(exec, args)
    },
  })), 'dsh-highres-vision: register highres_read tool')

  // 2) pre-step 提醒：只有出现大于提醒阈值的大图且尚未调用 highres_read 时才提示
  //    注意：ctx.on 自身就是 ctx 生命周期托管的注册（返回 disposable），
  //    与 v0.2.0 一致，不要再包一层 ctx.effect。
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    signal.throwIfAborted()

    if (!remindEnabled) return decision
    if (!allowedFor(agent)) return decision
    if (!hasImageInMessages(messages)) return decision
    if (!hasLargeImageInMessages(messages, remindThreshold)) return decision
    if (hasCalledHighresTool(messages)) return decision

    const injected = makeUserMessage(
      `检测到大图（超过 ${remindThreshold}x${remindThreshold}）识别请求：请先调用 highres_read 工具。` +
      `不要只靠内置视觉直接回答；该工具会返回整图 + 高清分块，避免 ${remindThreshold}px 压缩导致细节丢失。`,
    )

    return {
      kind: 'enter',
      messages: [...decision.messages, injected],
    }
  })
}
