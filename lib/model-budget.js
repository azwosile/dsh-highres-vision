// dsh-highres-vision — DeepSeek 适配器「每模型图片预算」自动抬升（v0.3.0 新增）
//
// ── 为什么需要这个模块 ─────────────────────────────────────────────────────
// 宿主的 dsh-llm-deepseek 在发请求前会按「每个模型」的 imagePixelBudget /
// imageMaxBytes 把图片再投影一次（resolveRequestImagePolicy）。模型条目只要
// 不显式声明，内核默认就是 640000（≈800×800）/ 1 MiB —— 那是
// V4-Flash-Vision-Exp 时代的基线。不改它，lib/tile.js 的 1300 分块会在请求前
// 被压回 800×800，分块增强的收益被全部吃掉。
//
// ── 为什么不能写在 cordis.patch.yml 里 ─────────────────────────────────────
//   1) 补丁对目标行的 `config` 是「整块替换」而不是合并
//      （@deepseek-ai/dsh-base 的 cordis.patch.yml 头部注释明确写了这一点），
//      在补丁里写 `models` 会连用户已有的模型条目一起冲掉。
//   2) `models` 是数组，settings 的合并规则 mergeLayers 对非普通对象是「覆盖」，
//      用户层 settings.yaml 的 `llm-deepseek.models` 永远压过补丁层。
//   3) dsh-llm-deepseek 通过 settings.installSection 把配置源指向
//      `settings` 的解析结果（apply() 里的 `setSource((source) => current = source)`），
//      所以在补丁里改 llm-deepseek.config 对 models 也是无效的。
//
// ── 所以走 settings 服务的写入路径 ─────────────────────────────────────────
// settings.update(ns, patch) 是内核给配置界面用的正规写入路径：
//   * 把 patch 合并进该命名空间的 **用户层**（settings.yaml 的 llm-deepseek 段）
//   * 用该命名空间的 schema + validate 校验，校验不过就在落盘前 reject
//   * 带 revision 冲突检测与串行写队列
//   * 落盘后 bump revision + commit，适配器的 setSource 立刻拿到新值
//     → **改完立即生效，不需要重启 DSH**
// 我们只「加字段、只抬不降」，并且只在真的需要改时才写盘。

import { isDeepSeekModelName } from './model-detect.js'

/** DeepSeek 适配器注册的 settings 命名空间（dsh-llm-deepseek 的 NS）。 */
export const DEEPSEEK_SETTINGS_NS = 'llm-deepseek'

/** 目标像素预算：1300 x 1300，对齐 DeepSeek-V4.1-Flash 的官方视觉投影。 */
export const TARGET_PIXEL_BUDGET = 1_690_000

/** 目标单图编码字节上限：8 MiB。必须与像素预算同批抬高，否则大图会被压回来。 */
export const TARGET_MAX_BYTES = 8 * 1024 * 1024

/** 旧基线，仅用于文档与对比。 */
export const LEGACY_PIXEL_BUDGET = 640_000

/**
 * 该模型条目是否声明了图片输入。
 * 与内核 resolveModels 的判定一致：`inputModalities` 缺省为 `["text"]`。
 */
export function declaresImageInput(model) {
  return Array.isArray(model?.inputModalities) && model.inputModalities.includes('image')
}

/**
 * 该模型条目算不算 DeepSeek 系列（按 id 或 name 判）。
 * 用于「只按 deepseek 模型改」的白名单：id 与 name 都不含 deepseek 就跳过。
 */
export function isDeepSeekModelEntry(model, pattern) {
  return isDeepSeekModelName(model?.id, pattern) || isDeepSeekModelName(model?.name, pattern)
}

/** 正整数化，非法值返回 fallback。 */
function positiveInt(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback
}

/**
 * 规划一次预算抬升：纯函数，不改入参，返回新的 models 数组与变更清单。
 *
 * 逐条判定，规则：
 *   1. **只处理 DeepSeek 系列条目**（`deepseekScope !== false` 时默认开启）：
 *      id 或 name 不匹配 `deepseek` 的条目一律跳过并记入 `skipped`。
 *      注意入参本来就来自 `llm-deepseek` 命名空间（官方 DeepSeek 适配器自己的
 *      模型目录），这道白名单是「显式化的第二道保险」，不依赖命名空间本身。
 *   2. 只处理声明了 `image` 模态的条目；纯文本条目原样返回。
 *   3. 显式写了 `imagePixelBudget: "low"` 的条目**跳过**（那是用户主动选的
 *      512x512 低细节档，不去覆盖）。
 *   4. 只抬不降：已有值 >= 目标时保留原值。
 *   5. 对象浅拷贝，其余字段（id/name/contextWindow/description/...）原样保留。
 *
 * @param models - 候选模型条目数组（通常来自 settings 的用户层）。
 * @param options - 目标预算、字节上限、是否限定 DeepSeek、可选模型名正则。
 * @returns 新数组、是否发生变化、逐条变更说明、以及被跳过的条目。
 */
export function planModelBudgetRaise(models, options = {}) {
  const pixelBudget = positiveInt(options.pixelBudget, TARGET_PIXEL_BUDGET)
  const maxBytes = positiveInt(options.maxBytes, TARGET_MAX_BYTES)
  const deepseekScope = options.deepseekScope !== false
  const pattern = options.modelPattern
  const list = Array.isArray(models) ? models : []
  const changes = []
  const skipped = []

  const next = list.map((model) => {
    if (!model || typeof model !== 'object') return model
    if (deepseekScope && !isDeepSeekModelEntry(model, pattern)) {
      skipped.push({ id: model.id ?? '(no-id)', reason: 'not-deepseek' })
      return model
    }
    if (!declaresImageInput(model)) {
      skipped.push({ id: model.id ?? '(no-id)', reason: 'text-only' })
      return model
    }
    // 显式低细节档：尊重用户选择，不动。
    if (model.imagePixelBudget === 'low') {
      skipped.push({ id: model.id ?? '(no-id)', reason: 'low-detail' })
      return model
    }

    const patch = {}
    const currentPixels = model.imagePixelBudget
    if (!(typeof currentPixels === 'number' && currentPixels >= pixelBudget)) {
      patch.imagePixelBudget = pixelBudget
    }
    const currentBytes = model.imageMaxBytes
    if (!(typeof currentBytes === 'number' && currentBytes >= maxBytes)) {
      patch.imageMaxBytes = maxBytes
    }
    if (Object.keys(patch).length === 0) return model

    changes.push({
      id: model.id ?? '(no-id)',
      from: {
        ...(currentPixels === undefined ? {} : { imagePixelBudget: currentPixels }),
        ...(currentBytes === undefined ? {} : { imageMaxBytes: currentBytes }),
      },
      to: patch,
    })
    return { ...model, ...patch }
  })

  return { changed: changes.length > 0, models: next, changes, skipped }
}

/**
 * 在 settings 服务上执行一次预算抬升。
 *
 * 取值优先级：用户层 `section.models` > 解析后的 `get().models`。
 * 优先用用户层，是为了把用户自己写的条目形状原样保留，只往里补两个字段。
 *
 * 任何失败都收敛成结果对象，绝不抛给调用方（插件加载不能被它带崩）。
 *
 * @param settings - ctx.settings 服务实例。
 * @param options - ns / 目标值 / deepseekScope / logger。
 * @returns `{ ok, changed, reason, changes, skipped }`。
 */
export async function applyModelBudgetRaise(settings, options = {}) {
  const ns = options.ns ?? DEEPSEEK_SETTINGS_NS
  const logger = options.logger

  if (!settings || typeof settings.update !== 'function') {
    return { ok: false, changed: false, reason: 'no-settings-service', changes: [], skipped: [] }
  }

  let section
  let resolved
  try {
    section = typeof settings.section === 'function' ? settings.section(ns) : undefined
    resolved = typeof settings.get === 'function' ? settings.get(ns) : undefined
  } catch (error) {
    return { ok: false, changed: false, reason: 'section-unreadable', error, changes: [], skipped: [] }
  }

  const userModels = Array.isArray(section?.models) && section.models.length > 0 ? section.models : undefined
  const source = userModels ?? (Array.isArray(resolved?.models) ? resolved.models : undefined)
  if (!source || source.length === 0) {
    return { ok: false, changed: false, reason: 'no-models', changes: [], skipped: [] }
  }

  const plan = planModelBudgetRaise(source, {
    pixelBudget: options.pixelBudget,
    maxBytes: options.maxBytes,
    deepseekScope: options.deepseekScope,
    modelPattern: options.modelPattern,
  })
  if (!plan.changed) {
    return { ok: true, changed: false, reason: 'already-at-target', changes: [], skipped: plan.skipped }
  }

  try {
    await settings.update(ns, { models: plan.models })
  } catch (error) {
    // 只读 provider、命名空间未注册、校验不过、冲突……都在这里收敛。
    logger?.warn?.(
      `dsh-highres-vision: 抬升 ${ns} 模型图片预算失败（${error?.message ?? String(error)}）；`
      + '请在 DSH 设置的 Models 页手动给视觉模型加 imagePixelBudget / imageMaxBytes。',
    )
    return { ok: false, changed: false, reason: 'write-failed', error, changes: [], skipped: plan.skipped }
  }

  return {
    ok: true,
    changed: true,
    reason: 'raised',
    changes: plan.changes,
    skipped: plan.skipped,
    source: userModels ? 'user-section' : 'resolved',
  }
}
