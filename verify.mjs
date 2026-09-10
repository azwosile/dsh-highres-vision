// dsh-highres-vision 离线自检（v0.3.0）：不安装、不联网。
// 覆盖三块：分块引擎纯函数、模型预算规划、端到端分块产物。
//
// 用法（在插件目录下，先让它能解析到 jimp）：
//   npm install                                  # 或软链一个已有的 node_modules
//   node verify.mjs                              # 用内置合成图
//   node verify.mjs <样本目录>                    # 额外跑本地真实图片
//   HRV_SAMPLES=<样本目录> node verify.mjs
//
// Windows 上借用 DSH 已有的依赖也行：
//   cmd /c mklink /J node_modules "%DSH_HOME%\profiles\web\node_modules"
//   node verify.mjs
//   cmd /c rmdir node_modules
//
// 纯函数断言（tile / model-budget 两节）不需要 jimp；端到端那节需要。
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const { tileImage, autoOverlap, splitAxis, splitTiles, TILE_SIZE, LEGACY_TILE_SIZE } =
  await import(new URL('./lib/tile.js', import.meta.url).href)
const MB = await import(new URL('./lib/model-budget.js', import.meta.url).href)
const MD = await import(new URL('./lib/model-detect.js', import.meta.url).href)

let pass = 0
let fail = 0
function check(label, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) { pass++; console.log(`  ✅ ${label}: ${a}`) }
  else { fail++; console.log(`  ❌ ${label}: 实际 ${a} / 期望 ${e}`) }
}

console.log(`\n== 常量 ==`)
check('TILE_SIZE', TILE_SIZE, 1300)
check('LEGACY_TILE_SIZE', LEGACY_TILE_SIZE, 800)

console.log(`\n== autoOverlap 向后兼容（tile=800 必须等于旧版 40/80/120）==`)
check('maxSide 1250 @800', autoOverlap(1250, 1250, 800), 40)
check('maxSide 1600 @800', autoOverlap(1600, 900, 800), 40)
check('maxSide 2560 @800', autoOverlap(2560, 1600, 800), 80)
check('maxSide 3000 @800', autoOverlap(3000, 1000, 800), 80)
check('maxSide 3840 @800', autoOverlap(3840, 2160, 800), 120)

console.log(`\n== autoOverlap 新基线（tile=1300）==`)
check('maxSide 1506 @1300', autoOverlap(1072, 1506, 1300), 65)
check('maxSide 2560 @1300', autoOverlap(2560, 1600, 1300), 65)
check('maxSide 3840 @1300', autoOverlap(3840, 2160, 1300), 130)
check('maxSide 5120 @1300', autoOverlap(5120, 2880, 1300), 195)

console.log(`\n== splitAxis / splitTiles ==`)
check('1072x1506 @1300 cols', splitAxis(1072, 1300, 65), [0])
check('1072x1506 @1300 rows', splitAxis(1506, 1300, 65), [0, 206])
check('2560x1600 @1300 cols', splitAxis(2560, 1300, 65), [0, 630, 1260])
check('2560x1600 @1300 rows', splitAxis(1600, 1300, 65), [0, 300])
check('3840x2160 @1300 cols', splitAxis(3840, 1300, 130), [0, 847, 1693, 2540])
check('3840x2160 @1300 rows', splitAxis(2160, 1300, 130), [0, 860])
check('5120x2880 @1300 cols', splitAxis(5120, 1300, 195), [0, 955, 1910, 2865, 3820])
check('5120x2880 @1300 rows', splitAxis(2880, 1300, 195), [0, 790, 1580])
// 注意：splitTiles 只负责切，不判断「要不要切」——那是 tileImage 的 needSplit 职责，
// 所以两边都 <= tile 时它仍返回 1 格。这里显式断言这个契约。
check('1280x720 @1300 needSplit=false', 1280 > 1300 || 720 > 1300, false)
check('1280x720 @1300 splitTiles 至少 1 格', splitTiles(1280, 720, 1300, 0).length, 1)

console.log(`\n== 块数（整图 + 子块，已计入 needSplit）==`)
for (const [w, h, expTiles] of [[1280, 720, 0], [1920, 1080, 2], [2560, 1600, 6], [3840, 2160, 8], [5120, 2880, 15]]) {
  const ov = autoOverlap(w, h, 1300)
  const need = w > 1300 || h > 1300
  check(`${w}x${h} @1300`, need ? splitTiles(w, h, 1300, ov).length : 0, expTiles)
}

// ── lib/model-budget.js：纯规划函数 ─────────────────────────────────────────
console.log(`\n== model-budget: 常量 ==`)
check('DEEPSEEK_SETTINGS_NS', MB.DEEPSEEK_SETTINGS_NS, 'llm-deepseek')
check('TARGET_PIXEL_BUDGET', MB.TARGET_PIXEL_BUDGET, 1690000)
check('TARGET_MAX_BYTES', MB.TARGET_MAX_BYTES, 8388608)

console.log(`\n== model-budget: declaresImageInput ==`)
check('image 模态', MB.declaresImageInput({ inputModalities: ['text', 'image'] }), true)
check('纯文本', MB.declaresImageInput({ inputModalities: ['text'] }), false)
check('缺省 = 纯文本', MB.declaresImageInput({ id: 'x' }), false)
check('null 安全', MB.declaresImageInput(null), false)

console.log(`\n== model-budget: planModelBudgetRaise ==`)
const VISION = { id: 'deepseek-flash', name: 'V', inputModalities: ['text', 'image'] }
const TEXT_ONLY = { id: 'deepseek-v4-pro', name: 'P', inputModalities: ['text'] }

{
  // 1) 纯文本原样、图片模型补齐
  const input = [TEXT_ONLY, VISION]
  const r = MB.planModelBudgetRaise(input)
  check('changed', r.changed, true)
  check('纯文本未动', r.models[0], TEXT_ONLY)
  check('图片模型补齐 budget', [r.models[1].imagePixelBudget, r.models[1].imageMaxBytes], [1690000, 8388608])
  check('变更清单', r.changes.length, 1)
  check('未改动入参数组', input[1].imagePixelBudget, undefined)
}
{
  // 2) 旧基线 640000 / 1MiB → 抬到目标
  const r = MB.planModelBudgetRaise([{ ...VISION, imagePixelBudget: 640000, imageMaxBytes: 1048576 }])
  check('抬升旧基线', [r.models[0].imagePixelBudget, r.models[0].imageMaxBytes], [1690000, 8388608])
}
{
  // 3) 已达标 → 不动、changed=false
  const r = MB.planModelBudgetRaise([{ ...VISION, imagePixelBudget: 1690000, imageMaxBytes: 8388608 }])
  check('已达标 changed', r.changed, false)
}
{
  // 4) 只抬不降：用户设了更大的值
  const r = MB.planModelBudgetRaise([{ ...VISION, imagePixelBudget: 4000000, imageMaxBytes: 20971520 }])
  check('只抬不降', r.changed, false)
}
{
  // 5) 显式 low 档被尊重
  const r = MB.planModelBudgetRaise([{ ...VISION, imagePixelBudget: 'low' }])
  check('low 档跳过', r.changed, false)
  check('low 档保留原值', r.models[0].imagePixelBudget, 'low')
}
{
  // 6) 其余字段完整保留
  const rich = { id: 'a', name: 'n', description: 'd', contextWindow: 1000000, maxTokens: 256000, inputModalities: ['image'] }
  const r = MB.planModelBudgetRaise([rich])
  check('保留 contextWindow', r.models[0].contextWindow, 1000000)
  check('保留 maxTokens', r.models[0].maxTokens, 256000)
  check('保留 description', r.models[0].description, 'd')
}
{
  // 7) 自定义目标
  const r = MB.planModelBudgetRaise([{ ...VISION }], { pixelBudget: 640000, maxBytes: 1048576 })
  check('自定义目标', [r.models[0].imagePixelBudget, r.models[0].imageMaxBytes], [640000, 1048576])
}
{
  // 8) 非数组 / 脏数据安全
  check('非数组', MB.planModelBudgetRaise(undefined).changed, false)
  check('null 条目', MB.planModelBudgetRaise([null]).changed, false)
}

console.log(`\n== model-budget: 只按 DeepSeek 条目改（默认 deepseekScope）==`)
{
  // 混入一个非 DeepSeek 的视觉条目：必须原样跳过
  const alien = { id: 'glm-5.3-vision', name: 'GLM Vision', inputModalities: ['text', 'image'] }
  const r = MB.planModelBudgetRaise([{ ...VISION }, alien])
  check('只改了 DeepSeek 条目', r.changes.map((c) => c.id), ['deepseek-flash'])
  check('非 DeepSeek 条目原样', r.models[1], alien)
  check('非 DeepSeek 记入 skipped', r.skipped.map((s) => `${s.id}:${s.reason}`), ['glm-5.3-vision:not-deepseek'])
}
{
  // 纯文本 DeepSeek 条目：跳过并记为 text-only
  const r = MB.planModelBudgetRaise([{ ...TEXT_ONLY }])
  check('纯文本 DeepSeek 记为 text-only', r.skipped.map((s) => s.reason), ['text-only'])
}
{
  // low 档记为 low-detail
  const r = MB.planModelBudgetRaise([{ ...VISION, imagePixelBudget: 'low' }])
  check('low 档记为 low-detail', r.skipped.map((s) => s.reason), ['low-detail'])
}
{
  // 按 name 命中也算 DeepSeek
  const byName = { id: 'my-relay-vision', name: 'DeepSeek V4.1 Flash', inputModalities: ['image'] }
  const r = MB.planModelBudgetRaise([byName])
  check('按 name 命中 deepseek', r.changes.length, 1)
}
{
  // deepseekScope:false 才放开
  const alien = { id: 'glm-5.3-vision', inputModalities: ['image'] }
  const r = MB.planModelBudgetRaise([alien], { deepseekScope: false })
  check('deepseekScope:false 放开', r.changes.map((c) => c.id), ['glm-5.3-vision'])
}
{
  // 用户 settings 里那四个真实条目：只有两个视觉的会被改
  const REAL = [
    { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' },
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek-V4-Flash-Vision-Exp', inputModalities: ['text', 'image'] },
    { id: 'deepseek-v4.1-flash-expires-on-0910', name: 'Deepseek-V4.1-Flash-expires-on-0910', inputModalities: ['text', 'image'] },
  ]
  const r = MB.planModelBudgetRaise(REAL)
  check('真实条目：改的就是那两个视觉的', r.changes.map((c) => c.id), ['deepseek-v4-flash-vision-exp', 'deepseek-v4.1-flash-expires-on-0910'])
  check('真实条目：纯文本两个被跳过', r.skipped.map((s) => `${s.id}:${s.reason}`), ['deepseek-v4-flash:text-only', 'deepseek-v4-pro:text-only'])
  check('真实条目：每个都拿到相同目标值', r.changes.every((c) => c.to.imagePixelBudget === 1690000 && c.to.imageMaxBytes === 8388608), true)
}
{
  // applyModelBudgetRaise 也透传 deepseekScope，且只写 DeepSeek 条目
  let written = null
  const models = [{ id: 'deepseek-v4-flash-vision-exp', inputModalities: ['text', 'image'] }, { id: 'glm-5.3', inputModalities: ['image'] }]
  const s = { section: () => ({ models }), get: () => ({}), update: async (ns, p) => { written = p } }
  const r = await MB.applyModelBudgetRaise(s, {})
  check('apply 写入 2 条但只改 1 条', written?.models?.length, 2)
  check('apply：GLM 条目未被改', written?.models?.[1].imagePixelBudget, undefined)
  check('apply：DeepSeek 条目被改', written?.models?.[0].imagePixelBudget, 1690000)
  check('apply：skipped 透传', r.skipped.map((x) => x.reason), ['not-deepseek'])
}

// ── lib/model-budget.js：settings 写入路径（假 settings） ───────────────────
console.log(`\n== model-budget: applyModelBudgetRaise ==`)
const fakeSettings = ({ section, resolved, onUpdate } = {}) => ({
  section: () => section,
  get: () => resolved,
  update: async (ns, patch) => { onUpdate?.(ns, patch); return {} },
})

{
  const r = await MB.applyModelBudgetRaise(undefined, {})
  check('无 settings 服务', [r.ok, r.reason], [false, 'no-settings-service'])
}
{
  let seen
  const s = fakeSettings({ section: { models: [{ ...VISION }] }, onUpdate: (ns, p) => { seen = { ns, p } } })
  const r = await MB.applyModelBudgetRaise(s, {})
  check('用户层抬升 ok', [r.ok, r.changed, r.source], [true, true, 'user-section'])
  check('写入了正确 ns', seen?.ns, 'llm-deepseek')
  check('写入值', [seen?.p.models[0].imagePixelBudget, seen?.p.models[0].imageMaxBytes], [1690000, 8388608])
}
{
  let called = false
  const s = fakeSettings({ section: { models: [{ ...VISION, imagePixelBudget: 1690000, imageMaxBytes: 8388608 }] }, onUpdate: () => { called = true } })
  const r = await MB.applyModelBudgetRaise(s, {})
  check('已达标不写盘', [r.ok, r.changed, r.reason, called], [true, false, 'already-at-target', false])
}
{
  const s = fakeSettings({ section: {}, resolved: { models: [{ ...VISION }] } })
  const r = await MB.applyModelBudgetRaise(s, {})
  check('回退到 resolved', [r.ok, r.changed, r.source], [true, true, 'resolved'])
}
{
  const s = fakeSettings({ section: {}, resolved: {} })
  const r = await MB.applyModelBudgetRaise(s, {})
  check('无模型', [r.ok, r.reason], [false, 'no-models'])
}
{
  const s = { section: () => ({}), get: () => ({ models: [{ ...VISION }] }), update: async () => { throw new Error('read-only provider') } }
  const r = await MB.applyModelBudgetRaise(s, {})
  check('写入被拒 → 收敛不抛', [r.ok, r.reason], [false, 'write-failed'])
}
{
  const s = { section: () => { throw new TypeError('settings section "llm-deepseek" must be an object of keys') }, get: () => undefined, update: async () => {} }
  const r = await MB.applyModelBudgetRaise(s, {})
  check('section 抛错 → 收敛不抛', [r.ok, r.reason], [false, 'section-unreadable'])
}
{
  const warned = []
  const s = { section: () => ({}), get: () => ({ models: [{ ...VISION }] }), update: async () => { throw new Error('nope') } }
  await MB.applyModelBudgetRaise(s, { logger: { warn: (m) => warned.push(m) } })
  check('失败有 warn 提示', warned.length > 0 && /read-only|手动|预算/.test(warned[0]), true)
}

// ── lib/model-detect.js：DeepSeek 识别与按会话开关 ─────────────────────────
console.log(`\n== model-detect: isDeepSeekSelection ==`)
const DS = { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' }
const RELAY = { provider: 'ginka-deepseek-015x', model: 'deepseek-v4-flash' }
const GLM = { provider: 'ginka-api-glm', model: 'glm-5.3' }
const GPT = { provider: 'ginka-gpt-020x', model: 'gpt-5.6-terra' }
check('官方 provider', MD.isDeepSeekSelection(DS), true)
check('中转 provider + deepseek 模型名', MD.isDeepSeekSelection(RELAY), true)
check('GLM', MD.isDeepSeekSelection(GLM), false)
check('GPT', MD.isDeepSeekSelection(GPT), false)
check('null 安全', MD.isDeepSeekSelection(null), false)
check('空对象', MD.isDeepSeekSelection({}), false)
check('只给 model', MD.isDeepSeekSelection({ model: 'DeepSeek-V4-Flash' }), true)
check('只给 provider', MD.isDeepSeekSelection({ provider: 'deepseek-official' }), true)
check('大小写不敏感', MD.isDeepSeekSelection({ model: 'DEEPSEEK-V4-PRO' }), true)

console.log(`\n== model-detect: resolveAgentSelection 优先级 ==`)
const fakeCtx = ({ projection, header, fallback } = {}) => ({
  get: (name) => {
    if (name === 'sessionProjections') return { stateOf: () => projection }
    if (name === 'agentDefaultModel') return { currentSelection: () => fallback }
    return undefined
  },
})
const fakeAgent = (header) => ({ session: { requestHeader: () => header } })

{
  // pending 优先于 header 与 default
  const ctx = fakeCtx({ projection: { pending: GLM, lastUsed: DS }, header: { config: DS }, fallback: DS })
  check('pending 优先', MD.resolveAgentSelection(ctx, fakeAgent({ config: DS })), GLM)
}
{
  // pending 为空 → 用 header
  const ctx = fakeCtx({ projection: { pending: null, lastUsed: DS }, header: { config: GPT }, fallback: DS })
  check('pending 空 → header', MD.resolveAgentSelection(ctx, fakeAgent({ config: GPT })), { provider: 'ginka-gpt-020x', model: 'gpt-5.6-terra' })
}
{
  // 无投影、无 header → 用默认模型
  const ctx = fakeCtx({ projection: undefined, header: undefined, fallback: DS })
  check('兜底到 agentDefaultModel', MD.resolveAgentSelection(ctx, fakeAgent(undefined)), DS)
}
{
  // 全都拿不到 → undefined
  const ctx = fakeCtx({})
  check('全空 → undefined', MD.resolveAgentSelection(ctx, fakeAgent(undefined)), undefined)
}
{
  // 服务抛错也不崩
  const ctx = { get: () => { throw new Error('service gone') } }
  check('服务抛错不崩', MD.resolveAgentSelection(ctx, fakeAgent(undefined)), undefined)
}

console.log(`\n== model-detect: decideAgentGate ==`)
{
  const ctx = fakeCtx({ projection: { pending: DS }, fallback: DS })
  const r = MD.decideAgentGate(ctx, fakeAgent(undefined), { enabled: true })
  check('DeepSeek → allow', [r.allowed, r.reason], [true, 'deepseek'])
}
{
  const ctx = fakeCtx({ projection: { pending: GLM }, fallback: DS })
  const r = MD.decideAgentGate(ctx, fakeAgent(undefined), { enabled: true })
  check('GLM → deny', [r.allowed, r.reason], [false, 'other-model'])
}
{
  const ctx = fakeCtx({})
  check('未知 + 默认策略 → allow', MD.decideAgentGate(ctx, fakeAgent(undefined), { enabled: true }).reason, 'unknown-allowed')
  check('未知 + deny 策略 → deny', MD.decideAgentGate(ctx, fakeAgent(undefined), { enabled: true, unknownPolicy: 'deny' }).reason, 'unknown-denied')
}
{
  const ctx = fakeCtx({ projection: { pending: GLM } })
  const r = MD.decideAgentGate(ctx, fakeAgent(undefined), { enabled: false })
  check('deepseekOnly=false → 恒 allow', [r.allowed, r.reason], [true, 'disabled'])
}

console.log(`\n== 端到端分块（jimp）==`)

// 自包含：用 jimp 现造图片，不依赖任何本机样本。
// 可选用真实样本：node verify.mjs <样本目录>，或设 HRV_SAMPLES=<样本目录>。
const { Jimp } = await import('jimp')

const work = await mkdtemp(join(tmpdir(), 'hrv-e2e-'))
const SAMPLE_DIR = process.argv[2] ?? process.env.HRV_SAMPLES ?? join(here, 'samples')

const cases = []
for (const [w, h] of [[2560, 1600], [1280, 720], [3840, 2160]]) {
  const file = join(work, `synthetic-${w}x${h}.png`)
  await new Jimp({ width: w, height: h, color: 0x3366ccff }).write(file)
  cases.push({ label: `合成 ${w}x${h}`, file, w, h })
}
try {
  for (const name of await readdir(SAMPLE_DIR)) {
    if (!/\.(png|jpe?g|webp|bmp|gif)$/i.test(name)) continue
    const file = join(SAMPLE_DIR, name)
    const img = await Jimp.read(file)
    cases.push({ label: `样本 ${name}`, file, w: img.bitmap.width, h: img.bitmap.height })
  }
} catch {
  // 没有 samples 目录就用合成用例，正常情况
}

for (const { label, file, w, h } of cases) {
  for (const tile of [1300, 800]) {
    const dir = await mkdtemp(join(tmpdir(), 'hrv-'))
    try {
      const plan = await tileImage(file, { emitDir: dir, tile, overlap: 0 })
      const files = await readdir(dir)
      const whole = plan.whole ? 1 : 0
      const need = w > tile || h > tile
      const checks = {
        产物齐全: plan.tiles.length === files.length - whole,
        块不超限: plan.tiles.every((t) => t.size[0] <= tile && t.size[1] <= tile),
        计数一致: plan.tileCount === plan.tiles.length,
        分块判定: need ? plan.tiles.length > 0 : plan.tiles.length === 0,
        整图存在: whole === 1,
      }
      const bad = Object.entries(checks).filter(([, v]) => !v).map(([k]) => k)
      console.log(
        `  ${bad.length === 0 ? '✅' : '❌'} ${label} ${w}x${h} tile=${tile}`
        + ` → 整图 ${plan.whole ? plan.whole.size.join('x') : '无'}`
        + ` + ${plan.tiles.length} 块 (overlap ${plan.overlap})`
        + (bad.length ? `  ！失败项: ${bad.join(', ')}` : ''),
      )
      if (bad.length === 0) pass++; else fail++
    } catch (err) {
      fail++
      console.log(`  ❌ ${label} tile=${tile} 抛错: ${err.message}`)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
}
await rm(work, { recursive: true, force: true })

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`)
process.exit(fail === 0 ? 0 : 1)
