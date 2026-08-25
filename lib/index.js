// dsh-highres-vision  v0.2.0
//
// 整合：
//   1. 放宽 DSH 本地图片准入到 DeepSeek 官方 API 上限（cordis.patch.yml）
//   2. 提供 highres_read 工具：自动定位会话中的用户图片，
//      生成 整图 + <=800x800 高清分块，并通过宿主 read_image 注入模型
//   3. agent/pre-step 提醒：用户发图（且图片实际大于 800×800）后，
//      若模型还未调用 highres_read，提醒先调用本工具。
// 注意：不覆盖宿主 read_image，read_image 保持原样。
// 纯 Node 实现，无外部 Python/Pillow 依赖。

import { join, isAbsolute } from 'node:path'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tileImage } from './tile.js'

export const name = 'dsh-highres-vision'
export const inject = ['tools', 'agents']

function findLatestSessionImage(exec) {
  const session = exec?.agent?.session
  if (!session || !Array.isArray(session.events)) return undefined
  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i]
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
 * 是否有“值得分块”的大图：宽或高 > 800px。
 * 尺寸信息缺失时保守返回 true（宁可提醒一次，也不漏掉大图）。
 */
function hasLargeImageInMessages(messages) {
  if (!Array.isArray(messages)) return false
  for (const message of messages) {
    if (message?.role !== 'user') continue
    const content = message?.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type !== 'image') continue
      const w = block.attachment?.width ?? block.width ?? 0
      const h = block.attachment?.height ?? block.height ?? 0
      if (w > 800 || h > 800) return true
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
    if (content.some((block) => block?.type === 'tool-call' && block?.name === 'highres_read')) return true
  }
  return false
}

export function apply(ctx, config = {}) {
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
      const readTool = exec?.agent ? ctx.tools.get('read_image', exec.agent) : undefined
      if (!readTool) {
        return { ok: false, error: 'read_image tool not available for this agent.' }
      }

      const workspace = exec?.agent?.session?.header?.cwd ?? process.cwd()
      emitDir = join(workspace, '.dsh-highres-vision', String(Date.now()))
      await mkdir(emitDir, { recursive: true })

      const inputPath = await resolveInputPath(args, emitDir, exec)

      const plan = await tileImage(inputPath, {
        emitDir,
        tile: args.tile ?? config.tile ?? 800,
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
      for (const tile of plan.tiles ?? []) {
        metas.push({ label: `块${tile.index}`, path: tile.path, box: tile.box })
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
    name: 'highres_read',
    description:
      '高清分块识图工具。识别/OCR/分析用户上传的大图时，必须先调用本工具。' +
      '它会自动定位当前会话最近一张用户图片，生成 整图 + <=800x800 高清分块，' +
      '并把整图和每个分块作为图片返回，避免模型只看到被压缩到 800x800 的单张原图。' +
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
        description: '单块最大边长，默认 800；超过该值自动分块。',
      },
      overlap: {
        type: 'number',
        description: '块间重叠像素；0=自动（按原图分辨率选 40/80/120px）。',
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

  // 2) pre-step 提醒：只有出现 >800x800 的大图且尚未调用 highres_read 时才提示
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    signal.throwIfAborted()

    if (!hasImageInMessages(messages)) return decision
    if (!hasLargeImageInMessages(messages)) return decision
    if (hasCalledHighresTool(messages)) return decision

    const injected = makeUserMessage(
      '检测到大图（超过 800x800）识别请求：请先调用 highres_read 工具。不要只靠内置视觉直接回答；该工具会返回整图 + 高清分块，避免 800x800 压缩导致细节丢失。',
    )

    return {
      kind: 'enter',
      messages: [...decision.messages, injected],
    }
  })
}
