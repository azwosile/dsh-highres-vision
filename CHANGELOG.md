# CHANGELOG

## 0.3.1 — 2026-09-10

**修复 v0.3.0 漏掉的最上游一层：附件规范化预算。**

### 修复

- **`cordis.patch.yml` 补上 `normalizedImageMaxPixels` / `normalizedImageMaxDimension` /
  `normalizedImageMaxBytes`。**

  `dsh-attachment-local` 有**两套独立预算**，v0.3.0 只设了第一套：

  | 预算 | v0.3.0 | 默认值 | 作用 |
  |---|---|---|---|
  | `maxImageBytes` / `maxImagePixels` / `maxImageDimension` | ✅ 已设 | 20 MiB / 64M / 8192 | **源准入**：收不收 |
  | `normalizedImageMaxPixels` | ❌ 漏了 | **2048×2048 = 4,194,304** | **规范化**：存进附件库的那份 |
  | `normalizedImageMaxDimension` | ❌ 漏了 | 8192 | 同上 |
  | `normalizedImageMaxBytes` | ❌ 漏了 | 4 MiB | 同上 |

  实测症状：上传 3840×2160 的图，源准入通过，但规范化把它缩成 **2730×1536**
  （`requestImageDimensions(3840,2160,4194304) === 2730x1536`，逐位吻合），
  **进附件库时已丢 49.4% 像素**。`highres_read` 读的是规范化副本，
  所以 1300 的分块是在一个降质源上做的 —— 插件修好了最后一公里，漏了第一公里。

  修复后的降采样损失：

  | 原图 | 旧（丢像素） | 新 |
  |---|---|---|
  | 3840×2160 | 2730×1536（−49.4%） | 3840×2160 |
  | 5120×2880 | 2730×1536（−71.6%） | 5120×2880 |
  | 8192×8192 | 2048×2048（−93.8%） | 8192×8192 |

  约束核对（`dsh-tool-fs` 文档）：规范化字节预算不得高于 `maxImageBytes`，
  否则 `read_image` 读规范化对象路径会被拒。此处 16 MiB < 32 MiB ✓

### 代价

- `attachments/v1/objects` 磁盘占用上升（内容寻址，**不会自动清理**）。
- 最终视觉 token 不变（仍由 1300 的请求投影像素预算决定），多出的只是磁盘与 I/O。

### 注意

- 修复只影响**新上传**的图片；已存进附件库的对象是内容寻址的，不会回溯重做。
  想验证请重新上传同一张图。

---

## 0.3.0 — 2026-09-10

**把「每模型图片预算」和「仅 DeepSeek 系列启用」做进插件，装完即用，不再需要手工改设置。**

### 新增

- **`lib/model-detect.js`：按会话识别 DeepSeek 系列模型并开关本插件。**
  判定优先级照抄内核 `dsh-api-session-controller.selectionFor(agent)`：
  `modelSelection` 投影的 `pending` → `session.requestHeader().config` → `agentDefaultModel.currentSelection()`。
  provider 为 `deepseek-official` 或模型名含 `deepseek`（兜住第三方中转）即算 DeepSeek 系列。

  关闭方式用内核的按 scope 工具屏蔽，而不是反复注册 / 注销：

  ```
  agent.ctx.tools.restrict({ deny: ['highres_read'] })
  ```

  内核原话是「Restrict global tools for the calling agent scope」——只影响该 agent，
  `dispose()` 即解除，其它会话完全不受影响。

  重新判定时机：`agent/created` / `session/event`(`model/selection`) / `agent/pre-step`（兜底）。
  `agent/disposed` 时清理限制。

  配置：`deepseekOnly`（默认 `true`）、`unknownModelPolicy`（`allow` | `deny`，默认 `allow`）。

- **`lib/model-budget.js`：DeepSeek 适配器每模型图片预算自动抬升。**
  按每个模型**逐条**判定，只给 **DeepSeek 系列**且声明了 `image` 模态的条目
  补上 / 抬高 `imagePixelBudget` 与 `imageMaxBytes`。

  作用域（两道）：
  1. 写入目标只有 `llm-deepseek` 这一个 settings 命名空间 —— 官方 DeepSeek 适配器
     自己的模型目录。`ginka-*` / `amd` 等 `llm-pi-ai` provider 结构上不会被碰。
  2. 逐条白名单：条目的 `id` 或 `name` 不含 `deepseek` 就跳过并记入 `skipped`
     （`modelBudgetScope: 'all'` 可放开）。
  插件加载时通过 `ctx.inject(['settings'], …)` 拿到 settings 服务，调用
  `settings.update('llm-deepseek', { models: [...] })`，给**已声明 `image` 模态**的
  模型补上 / 抬高 `imagePixelBudget` 与 `imageMaxBytes`。

  为什么必须是这条路径（而不是补丁）：

  1. 补丁对目标行的 `config` 是**整块替换**而不是合并 —— `@deepseek-ai/dsh-base`
     的 `cordis.patch.yml` 头部注释明确写了这一点。在补丁里写 `models` 会把用户
     已有的模型条目整批冲掉。
  2. `models` 是数组，settings 的 `mergeLayers` 对非普通对象是**覆盖**语义；
     且 `dsh-llm-deepseek` 通过 `settings.installSection` 把配置源指向 settings 的
     解析结果（`apply()` 内 `setSource((source) => current = source)`），
     补丁层的 `models` 会被用户层 `settings.yaml` 永久压过。
  3. `settings.update` 是内核给配置界面（Web Models 页）用的正规写入路径：
     带 schema 校验、revision 冲突检测、串行写队列；**校验不过就在落盘前 reject**。
     落盘后适配器立刻换源 → **立即生效，无需重启 DSH**。

  行为约定：

  - 只处理声明了 `image` 模态的条目，纯文本模型完全不碰。
  - **只抬不降**：已有值 ≥ 目标时保留原值。
  - 跳过显式 `imagePixelBudget: "low"`（那是用户主动选的 512×512 低细节档）。
  - 对象浅拷贝，`id` / `name` / `contextWindow` / `maxTokens` / `description` 等原样保留。
  - **只在真的需要改时才写盘**；写入自身触发的 `settings/updated` 会自检并收敛
    （实测只写 1 次，不会循环）。
  - settings 服务缺失、命名空间未注册、provider 只读、写入被拒 —— 全部收敛成
    一条 warn，**绝不影响插件其余功能**。
  - 优先读用户层 `settings.section('llm-deepseek').models`，把用户自己写的条目形状
    原样保留，只往里补两个字段；用户层没有 `models` 时才回退到解析后的值。

- **新配置项**（写在本插件的 patch/config 行上）：
  - `deepseekOnly`：默认 `true`；`false` = 不做模型判定，所有会话都启用
  - `unknownModelPolicy`：`allow` | `deny`，默认 `allow`
  - `autoRaiseModelBudget`：默认 `true`；`false` = 完全不做预算抬升
  - `modelBudgetScope`：`deepseek`（默认）| `all`
  - `modelImagePixelBudget`：默认 `1690000`（1300×1300）
  - `modelImageMaxBytes`：默认 `8388608`（8 MiB）

- **`./model-detect` 与 `./model-budget` 子路径导出**，便于单独复用。

### 变更

- `cordis.patch.yml` 第 4 节从「手工改 settings.yaml 的说明」改为「由插件自动处理」
  的说明，并记录上面两条硬约束的原因。
- **README 移除「兼容性说明（风神插件 / router-standard）」一节。**
  该预设所属的 `dsh-routing-suite` 已不适配 DeepSeek-V4.1-Flash，
  `preserveTools` 那套配置不再有维护价值。
- **`verify.mjs` 改为自包含**：不再引用本机绝对路径，默认用 `jimp` 现造合成图，
  可选传入样本目录（`node verify.mjs <dir>` 或 `HRV_SAMPLES=<dir>`）。
  并补齐 `npm install` 这一种依赖获取方式。
- **补回 `package-lock.json`**（lockfileVersion 3，根版本 0.3.0，jimp 1.6.1）。
  上游仓库带此文件；本工作目录源自 v0.1.0，缺失它会让提交diff 显示为「删除」。

### 已知边界

- 只抬预算，**不改模型名与模态**。若某个模型在设置里没写 `inputModalities: [text, image]`，
  本插件按内核规则视为纯文本而跳过它 —— 需要用户自己加。同理，模型 id 从
  `deepseek-v4-flash-vision-exp` 迁到正式名 `deepseek-flash` 也属于用户设置范畴。
- 内核 `dsh-llm-deepseek` 的 **token 计价**常量仍是旧基线
  （`MAX_IMAGE_TOKENS = 384`、`MIN_PIXELS = 384×384`），本插件不负责也无法影响它，
  属宿主侧滞后。

---

## 0.2.1 — 2026-09-10

对齐当天上线的 **DeepSeek-V4.1-Flash**（正式模型名 `deepseek-flash`；旧名
`deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 仍被接受，但对应模型已下线，
请求转由 V4.1-Flash 承接）。

### 修复

- **`cordis.patch.yml`：`llm-deepseek` 的配置键失效。**
  v0.2.0 及更早写的是 `maxRequestImageBytes`，该键在 harness 0.1.2-rc.1 的
  `dsh-llm-deepseek` 里已不存在，现行键名是 `maxInlineRequestImageBytes`（默认 20 MiB）。
  实测 Schemastery 3.18.2 既不剥离未知键也不报错，所以旧键是**静默 no-op**：
  附件准入被抬到 32 MiB，适配器却仍在 20 MiB 处卸载内联图，
  20–32 MiB 的图会被静默替换成文本占位。现已改为正确键名（44 MiB）。

  > 约束：`inlineImageOffloadByteQuantum`（内核默认 10 MiB）必须
  > `<= maxInlineRequestImageBytes`，否则 `resolveAdapterOptions` 直接抛错。

### 变更

- **分块基线 800 → 1300（`lib/tile.js` 的 `TILE_SIZE`）。**
  官方视觉投影目标从「约 800×800 等效像素 / 单图 384 token」变为
  「约 **1300×1300** 等效像素 / 单图 **1024** token」，像素预算涨 2.64×。
  用 800 分块等于白丢约 62% 的可用分辨率。
- **`autoOverlap()` 的阈值随 tile 等比缩放。**
  原先硬编码 1600 / 3000 两档，现在改为 `tile × 2` / `tile × 3.75`，
  重叠量取 `tile` 的 5% / 10% / 15%，下限 `max(24, tile × 3%)`。
  tile=800 时结果与旧版 40 / 80 / 120 **完全一致**（向后兼容），
  tile=1300 时为 65 / 130 / 195。
- **`LEGACY_TILE_SIZE = 800` 常量导出**，便于需要回退旧基线的场景。

### 新增

- **可配置项**（写在本插件的 patch/config 行上）：
  - `tile`：单块最大边长，默认 1300
  - `overlap`：块间重叠像素，0 = 自动
  - `remind`：`false` 关闭 `agent/pre-step` 提醒
  - `remindThreshold`：提醒阈值，缺省与 `tile` 一致
- **`./tile` 子路径导出**，方便单独复用分块引擎。
- **README 增加「生效前提：必须同时抬 `imagePixelBudget`」章节。**

### 已知事项 / 未在本次修复

- 宿主 `dsh-llm-deepseek` 仍按**每个模型**的 `imagePixelBudget` 二次投影，
  内核默认值是 `640000`（≈800×800）/ `imageMaxBytes = 1 MiB`。
  **只改本插件不改设置，1300 分块会在请求前被压回 800×800。**
  修复方式写在 `cordis.patch.yml` 第 4 节与 README 里 ——
  必须改 `settings.yaml` 的 `llm-deepseek.models`（数组整体替换语义，
  不能在插件 patch 里覆盖，否则会冲掉用户已有的模型条目）。
- 内核 `dsh-llm-deepseek` 的 token 计价常量仍是旧基线
  （`MAX_IMAGE_TOKENS = 384`、`MIN_PIXELS = 384×384`），
  在官方上游更新前，本插件无法影响该计价，属宿主侧滞后。
- **移除 `scripts/tile_image.py`**（v0.1.0 的 Python 分块实现，390 行）。
  上游早在 `fe96d7c Delete scripts directory` 就删掉了它；本工作目录源自 v0.1.0
  所以又带上了它，提交到仓库会显示成「重新加回一个已删除的文件」。
  它已无任何代码引用，且自带一个直接读 `DEEPSEEK_API_KEY` 打 DeepSeek API 的 CLI，
  与本插件「纯 Node、不需要 Python / Pillow」的定位矛盾。
  旧版源码保留在工作区备份 `_archive/dsh-highres-vision-v0.1.0-backup-20260910/`。

---

## 0.2.0 — 2026-08-26

- 分块引擎从 `scripts/tile_image.py` 改为 `lib/tile.js`（基于 `jimp`），
  不再依赖系统 Python 与 Pillow。
- 新增 `engines.node >= 18` 与 `dependencies.jimp`。

## 0.1.0 — 2026-08-23

- 首个版本：`highres_read` 工具 + `agent/pre-step` 提醒 + 放宽附件准入 patch。
- 分块由外部 Python 脚本 `scripts/tile_image.py` 完成。
