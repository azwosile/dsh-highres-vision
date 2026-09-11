// dsh-highres-vision 内核契约探针（v0.3.2 新增）：不安装插件、不联网、不需要 jimp。
//
// 把本插件依赖的每一个宿主契约，在一到多棵「内核 node_modules 树」上各测一遍，
// 用来回答一个问题：**换到另一个 DSH 内核版本，插件还要不要改？**
//
// 用法：
//   node verify-kernel.mjs <内核树1> [内核树2] [...]
//
// 「内核树」= 放着 @deepseek-ai/* 的那个 node_modules 目录。三个常见来源：
//   1) DSH Desktop 自带的内核：
//        "C:\Users\<你>\AppData\Roaming\dsh-desktop\..." → 实际是
//        "<DSH Desktop 安装目录>\resources\app\node_modules"
//   2) npm 上现拉一套新内核（在一个空目录里）：
//        npm i --ignore-scripts --no-audit --no-fund --no-save @deepseek-ai/dsh@0.1.5-rc.1
//        然后传该目录下的 node_modules
//   3) 任意 profile 的 node_modules（含有内核包时）
//
// 第一个树是基线，其余树逐项对比；有任何差异就以非 0 退出。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error('用法: node verify-kernel.mjs <内核树1> [内核树2] [...]');
  process.exit(2);
}

const read = (root, rel) => {
  try { return readFileSync(join(root, rel), 'utf8'); } catch { return null; }
};
const ver = (root, pkg) => {
  try { return JSON.parse(read(root, `${pkg}/package.json`)).version; } catch { return '(缺)'; }
};
const has = (root, pkg) => read(root, `${pkg}/package.json`) !== null;

const probes = [
  {
    group: 'lib/index.js → Session 事件读取',
    name: 'Session.prototype.snapshotEvents() 存在',
    fn: async (root) => {
      const { Session } = await import(pathToFileURL(join(root, '@deepseek-ai/dsh-session/lib/index.js')).href);
      return typeof Session.create('probe').snapshotEvents === 'function';
    },
  },
  {
    group: 'lib/index.js → Session 事件读取',
    name: "Session 上是否存在 events 属性（v0.3.1 及更早的读法）",
    fn: async (root) => {
      const { Session } = await import(pathToFileURL(join(root, '@deepseek-ai/dsh-session/lib/index.js')).href);
      return 'events' in Session.create('probe');
    },
  },
  {
    group: 'lib/index.js → Session 事件读取',
    name: 'ownEvents() / eventAt() / requestHeader() / deriveMessages()',
    fn: async (root) => {
      const { Session } = await import(pathToFileURL(join(root, '@deepseek-ai/dsh-session/lib/index.js')).href);
      const s = Session.create('probe');
      return ['ownEvents', 'eventAt', 'requestHeader', 'deriveMessages'].every((k) => typeof s[k] === 'function');
    },
  },
  {
    group: 'lib/index.js → 路径与工作区',
    name: 'session.header.cwd（源码级）',
    fn: async (root) => /header cwd must be an absolute path|record\.cwd/.test(read(root, '@deepseek-ai/dsh-session/lib/index.js') ?? ''),
  },
  {
    group: 'lib/model-budget.js → settings 写入',
    name: 'settings.section(ns) / get(ns) / update(ns, patch)',
    fn: async (root) => {
      const t = read(root, '@deepseek-ai/dsh-settings/lib/index.js') ?? '';
      return /section\(ns\)/.test(t) && /\n\tget\(ns\)/.test(t) && /async update\(ns, patch, expectedRevision\)/.test(t);
    },
  },
  {
    group: 'lib/model-budget.js → settings 写入',
    name: 'settings/updated 事件',
    fn: async (root) => /"settings\/updated"/.test(read(root, '@deepseek-ai/dsh-settings/lib/index.js') ?? ''),
  },
  {
    group: 'lib/model-detect.js → 模型判定',
    name: 'modelSelection 投影 key',
    fn: async (root) => /key: "modelSelection"/.test(read(root, '@deepseek-ai/dsh-api-session-controller/lib/index.js') ?? ''),
  },
  {
    group: 'lib/model-detect.js → 模型判定',
    name: 'modelSelection 状态含 pending 字段',
    fn: async (root) => /pending: modelSelectionSchema\.nullable\(\)/.test(read(root, '@deepseek-ai/dsh-api-session-controller/lib/index.js') ?? ''),
  },
  {
    group: 'lib/model-detect.js → 模型判定',
    name: 'agentDefaultModel.currentSelection()',
    fn: async (root) => /currentSelection\(\) \{/.test(read(root, '@deepseek-ai/dsh-agent-default-model/lib/index.js') ?? ''),
  },
  {
    group: 'lib/index.js → 按 agent 屏蔽工具',
    name: 'tools.restrict({ allow / deny }) 只吃 agent.ctx 作用域',
    fn: async (root) => /requires a scoped context \(agent\.ctx\)/.test(read(root, '@deepseek-ai/dsh-tools/lib/index.js') ?? ''),
  },
  {
    group: 'lib/index.js → 工具注册契约',
    name: 'tools.register(definition) 要求 output { schema, render }',
    fn: async (root) => /must declare output \{ schema, render/.test(read(root, '@deepseek-ai/dsh-tools/lib/index.js') ?? ''),
  },
  {
    group: 'lib/index.js → 工具注册契约',
    name: 'tools.get(name, scope)',
    fn: async (root) => /\n\tget\(name, scope\) \{/.test(read(root, '@deepseek-ai/dsh-tools/lib/index.js') ?? ''),
  },
  {
    group: 'lib/index.js → 工具注册契约',
    name: '输入 schema 仍读 definition.parameters',
    fn: async (root) => /const \{ name, description, parameters \} = definition;/.test(read(root, '@deepseek-ai/dsh-tools/lib/index.js') ?? ''),
  },
  {
    group: 'lib/index.js → 工具注册契约',
    name: 'JSON Schema 允许子集未收紧（type/oneOf/properties/required/additionalProperties/items/enum/const + description）',
    fn: async (root) => {
      const t = read(root, '@deepseek-ai/dsh-tools/lib/index.js') ?? '';
      const c = /const CONSTRAINT_KEYWORDS = new Set\(\[([\s\S]*?)\]\);/.exec(t);
      const a = /const ANNOTATION_KEYWORDS = new Set\(\[([\s\S]*?)\]\);/.exec(t);
      if (c === null || a === null) return false;
      const norm = (s) => [...s.matchAll(/"([a-zA-Z]+)"/g)].map((m) => m[1]).sort().join(',');
      return norm(c[1]) === 'additionalProperties,const,enum,items,oneOf,properties,required,type'
        && norm(a[1]).includes('description');
    },
  },
  {
    group: 'lib/index.js → pre-step 提醒',
    name: "agent/pre-step 决策 kind: 'enter' / 'reject'",
    fn: async (root) => {
      const t = read(root, '@deepseek-ai/dsh-agent-loop/lib/index.js') ?? '';
      return /kind: "enter"/.test(t) && /decision\.kind === "reject"/.test(t);
    },
  },
  {
    group: 'lib/index.js → pre-step 提醒',
    name: 'pre-step payload 含 { agent, messages, signal }',
    fn: async (root) => {
      const t = read(root, '@deepseek-ai/dsh-agent-loop/lib/index.js') ?? '';
      return /waterfall\("agent\/pre-step", \{/.test(t) && /messages: claimed/.test(t);
    },
  },
  {
    group: 'lib/index.js → 注入消息形状',
    name: 'user/message 的 data 是消息本体（含 content 数组）',
    fn: async (root) => {
      const t = read(root, '@deepseek-ai/dsh-session/lib/index.js') ?? '';
      return /const message = type === "user\/message" \? record : record\?\.\["message"\]/.test(t)
        || /const message = type === 'user\/message' \? record : record\?\.\['message'\]/.test(t);
    },
  },
  {
    group: 'cordis.patch.yml → attachment-local 键',
    name: 'maxImageBytes / maxImageDimension / maxImagePixels',
    fn: async (root) => ['maxImageBytes', 'maxImageDimension', 'maxImagePixels']
      .every((k) => new RegExp(`${k}: z\\.number`).test(read(root, '@deepseek-ai/dsh-attachment-local/lib/index.js') ?? '')),
  },
  {
    group: 'cordis.patch.yml → attachment-local 键',
    name: 'maxImagesPerMessage / maxMessageImageBytes',
    fn: async (root) => ['maxImagesPerMessage', 'maxMessageImageBytes']
      .every((k) => new RegExp(`${k}: z\\.number`).test(read(root, '@deepseek-ai/dsh-attachment-local/lib/index.js') ?? '')),
  },
  {
    group: 'cordis.patch.yml → attachment-local 键',
    name: 'normalizedImageMax{Pixels,Dimension,Bytes}',
    fn: async (root) => ['normalizedImageMaxPixels', 'normalizedImageMaxDimension', 'normalizedImageMaxBytes']
      .every((k) => new RegExp(`${k}: z\\.number`).test(read(root, '@deepseek-ai/dsh-attachment-local/lib/index.js') ?? '')),
  },
  {
    group: 'cordis.patch.yml → llm-deepseek 键',
    name: 'maxInlineRequestImageBytes',
    fn: async (root) => /maxInlineRequestImageBytes: z\.number/.test(read(root, '@deepseek-ai/dsh-llm-deepseek/lib/index.js') ?? ''),
  },
  {
    group: 'cordis.patch.yml → llm-deepseek 键',
    name: 'inlineImageOffloadByteQuantum <= maxInlineRequestImageBytes 约束仍在',
    fn: async (root) => /inlineImageOffloadByteQuantum must not exceed maxInlineRequestImageBytes/.test(read(root, '@deepseek-ai/dsh-llm-deepseek/lib/index.js') ?? ''),
  },
  {
    group: 'cordis.patch.yml → llm-deepseek 键',
    name: '每模型 imagePixelBudget / imageMaxBytes',
    fn: async (root) => {
      const t = read(root, '@deepseek-ai/dsh-llm-deepseek/lib/index.js') ?? '';
      return /imagePixelBudget/.test(t) && /imageMaxBytes/.test(t);
    },
  },
  {
    group: 'cordis.patch.yml → 装配行',
    name: 'dsh-base 的 patch 里仍有 attachment-local / llm-deepseek 两行',
    fn: async (root) => {
      const t = read(root, '@deepseek-ai/dsh-base/cordis.patch.yml') ?? '';
      return /^\s*-?\s*id:\s*attachment-local\s*$/m.test(t) && /^\s*-?\s*id:\s*llm-deepseek\s*$/m.test(t);
    },
  },
  {
    group: 'highres_read → 宿主 read_image',
    name: 'read_image 返回 { path, image: { attachmentId, mediaType, bytes, width, height, name } }',
    fn: async (root) => {
      const t = read(root, '@deepseek-ai/dsh-tool-fs/lib/index.js') ?? '';
      return /attachmentId: ref\.attachmentId/.test(t) && /mediaType: ref\.mediaType/.test(t) && /width: ref\.width/.test(t);
    },
  },
  {
    group: 'highres_read → 宿主 read_image',
    name: 'read_image 走附件库（attachments.saveImage）',
    fn: async (root) => /attachments\.saveImage\(\{/.test(read(root, '@deepseek-ai/dsh-tool-fs/lib/index.js') ?? ''),
  },
];

console.log('='.repeat(100));
console.log('内核树（第一个为基线）：');
for (const [i, root] of roots.entries()) {
  console.log(`  [${i}] ${root}`);
  console.log(`      dsh-session=${ver(root, '@deepseek-ai/dsh-session')}  dsh-tools=${ver(root, '@deepseek-ai/dsh-tools')}  dsh-llm-deepseek=${ver(root, '@deepseek-ai/dsh-llm-deepseek')}`);
}
const missing = roots.find((r) => !has(r, '@deepseek-ai/dsh-session') || !has(r, '@deepseek-ai/dsh-tools'));
if (missing !== undefined) {
  console.error(`\n✗ ${missing} 里找不到 @deepseek-ai/dsh-session / @deepseek-ai/dsh-tools —— 这不是一棵内核树。`);
  process.exit(2);
}
console.log('='.repeat(100));

const labels = roots.map((_, i) => (i === 0 ? 'baseline' : `tree${i}`));
let diffs = 0;
let total = 0;
let lastGroup = '';
for (const probe of probes) {
  if (probe.group !== lastGroup) {
    console.log(`\n── ${probe.group}`);
    lastGroup = probe.group;
  }
  const results = [];
  for (const root of roots) {
    try { results.push(await probe.fn(root)); } catch (e) { results.push(`ERR:${e.code ?? e.name}`); }
  }
  total += 1;
  const allSame = results.every((r) => JSON.stringify(r) === JSON.stringify(results[0]));
  if (!allSame) diffs += 1;
  const mark = !allSame ? '⚠ 有差异' : (results[0] === true ? '✅ 一致' : '· 一致');
  console.log(`  ${mark.padEnd(9)} ${probe.name}`);
  console.log(`      ${results.map((r, i) => `${labels[i]}=${JSON.stringify(r)}`).join('   ')}`);
}

console.log(`\n${'='.repeat(100)}`);
if (diffs === 0) {
  console.log(`结论：${total} 项宿主契约在所有 ${roots.length} 棵内核树上一致 —— 插件无需改写即可适配。`);
} else {
  console.log(`结论：${total} 项里有 ${diffs} 项存在差异（见上面的 ⚠）—— 需要核查对应内核版本。`);
}
console.log('='.repeat(100));
process.exit(diffs === 0 ? 0 : 1);
