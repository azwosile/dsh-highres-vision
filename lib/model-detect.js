// dsh-highres-vision — DeepSeek 模型识别与按会话开关（v0.3.0 新增）
//
// 目的：让本插件只在会话跑 DeepSeek 系列模型时生效；切到 GLM / GPT 等
// 其它 provider 时，`highres_read` 对那个 agent 不可见，pre-step 提醒也不注入。
//
// ── 怎么读「当前会话用的是哪个模型」────────────────────────────────────────
// 照抄内核 @deepseek-ai/dsh-api-session-controller 的 selectionFor(agent) 优先级：
//   1. modelSelection 会话投影的 `pending`（用户刚切换、尚未发起请求）
//   2. agent.session.requestHeader().config（上一次已落库的请求头）
//   3. ctx.agentDefaultModel.currentSelection()（组合层 / 设置里的默认模型）
// 三者都拿不到才视为「未知」。
//
// ── 怎么做到「只对这个 agent 关」──────────────────────────────────────────
// 内核 dsh-tools 提供了 `agent.ctx.tools.restrict({ deny })`：
//   「Restrict global tools for the calling agent scope.」
// 它按 agent scope 屏蔽**全局**工具，作用域内注册的其它工具不受影响，
// 且 `dispose()` 即可解除。所以本插件全局注册一次 `highres_read`，
// 再对「非 DeepSeek」的 agent 挂一条 deny 限制 —— 不用反复注册/注销。

/** 官方 DeepSeek 适配器的 provider id（dsh-llm-deepseek 的 PROVIDER 常量）。 */
export const DEEPSEEK_PROVIDER_IDS = ['deepseek-official']

/** 模型名匹配：兜住经第三方中转（llm-pi-ai）的 DeepSeek 模型。 */
export const DEEPSEEK_MODEL_PATTERN = /deepseek/i

/** 无法判定模型时的策略。 */
export const UNKNOWN_POLICY_ALLOW = 'allow'
export const UNKNOWN_POLICY_DENY = 'deny'

/**
 * 这个名字是不是 DeepSeek 系列（只看名字，不看 provider）。
 * 预算抬升用它做逐条白名单：拼错 id 的非 DeepSeek 条目不会被误改。
 *
 * @param value - 模型 id 或显示名。
 * @param pattern - 可选正则覆盖。
 * @returns 是否像 DeepSeek 模型。
 */
export function isDeepSeekModelName(value, pattern) {
  const p = pattern instanceof RegExp ? pattern : DEEPSEEK_MODEL_PATTERN
  return typeof value === 'string' && value.length > 0 && p.test(value)
}

/**
 * 这个选择是不是 DeepSeek 系列。
 * provider 命中官方 id，或模型名命中 `deepseek` 即算。
 *
 * @param selection - `{ provider, model }`，允许缺字段。
 * @param options - 可选覆盖 providers / modelPattern。
 * @returns 是否属于 DeepSeek 系列。
 */
export function isDeepSeekSelection(selection, options = {}) {
  if (!selection || typeof selection !== 'object') return false
  const providers = Array.isArray(options.providers) ? options.providers : DEEPSEEK_PROVIDER_IDS
  const pattern = options.modelPattern instanceof RegExp ? options.modelPattern : DEEPSEEK_MODEL_PATTERN
  if (typeof selection.provider === 'string' && providers.includes(selection.provider)) return true
  if (typeof selection.model === 'string' && selection.model.length > 0 && pattern.test(selection.model)) return true
  return false
}

/** 把任意来源的选择规范化成 `{provider, model, reasoningEffort?}`，取不到返回 undefined。 */
function normalize(selection) {
  if (!selection || typeof selection !== 'object') return undefined
  const provider = selection.provider
  const model = selection.model
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  return {
    provider,
    model,
    ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
  }
}

/**
 * 解析一个 agent 当前的模型选择。
 *
 * 与内核 `api-session-controller.selectionFor()` 同一优先级。
 * 任何一步抛错都吞掉并继续往下走 —— 判定失败应当是「未知」，不是崩溃。
 *
 * @param ctx - 插件上下文（用 ctx.get 取服务，缺失即跳过该来源）。
 * @param agent - 目标 agent。
 * @returns `{provider, model, reasoningEffort?}`，或 undefined。
 */
export function resolveAgentSelection(ctx, agent) {
  // 1) 会话投影：用户刚切换但还没发请求时的选择
  try {
    const state = ctx.get('sessionProjections')?.stateOf(agent?.session, 'modelSelection')
    const pending = normalize(state?.pending)
    if (pending !== undefined) return pending
  } catch { /* 投影未注册 / 读取失败 → 换下一个来源 */ }

  // 2) 上一次已落库的请求头
  try {
    const header = agent?.session?.requestHeader?.()
    const logged = normalize(header?.config)
    if (logged !== undefined) return logged
  } catch { /* 忽略 */ }

  // 3) 组合层 / 设置里的默认模型
  try {
    const fallback = normalize(ctx.get('agentDefaultModel')?.currentSelection?.())
    if (fallback !== undefined) return fallback
  } catch { /* 忽略 */ }

  return undefined
}

/**
 * 综合判定：这个 agent 现在该不该开本插件。
 *
 * @param ctx - 插件上下文。
 * @param agent - 目标 agent。
 * @param options - `{ enabled, unknownPolicy, providers, modelPattern }`。
 * @returns `{ allowed, selection, reason }`。
 *   reason ∈ `disabled` | `deepseek` | `other-model` | `unknown-allowed` | `unknown-denied`
 */
export function decideAgentGate(ctx, agent, options = {}) {
  if (options.enabled === false) {
    return { allowed: true, selection: undefined, reason: 'disabled' }
  }
  const selection = resolveAgentSelection(ctx, agent)
  if (selection === undefined) {
    const allowUnknown = options.unknownPolicy !== UNKNOWN_POLICY_DENY
    return {
      allowed: allowUnknown,
      selection: undefined,
      reason: allowUnknown ? 'unknown-allowed' : 'unknown-denied',
    }
  }
  const hit = isDeepSeekSelection(selection, options)
  return {
    allowed: hit,
    selection,
    reason: hit ? 'deepseek' : 'other-model',
  }
}
