# dsh-highres-vision
> 大肥鱼出来卖个萌
> 🐳 鲸鱼娘登场喵～ 如果这个小插件帮到了你，记得给仓库点个 ⭐ Star 喵！
> 星星越多，鲸鱼娘越开心，也会更有动力继续维护这个插件喵～ 💙
> （求求啦喵～）

> ⚠️ **只给 DeepSeek 的视觉模型用。**
> 2026-09-10 起视觉模型是 **DeepSeek-V4.1-Flash**（正式名 `deepseek-flash`）；
> 旧名 `deepseek-v4-flash-vision-exp` / `deepseek-v4-flash` 仍被接受，请求同样转由 V4.1-Flash 承接。
> `deepseek-v4-pro` 官方不支持视觉。

DeepSeek Harness 高清识图增强插件 **v0.3.2**（本身也是由 deepseek v4 flash vision exp 开发()）

## 适配内核

| 内核版本 | 状态 |
|---|---|
| 0.1.2-rc.1（DSH Desktop 0.8.1 内置） | ✅ 已实测 |
| 0.1.5-rc.1（npm `latest`） | ✅ 已实测 |
| 0.1.5-rc.2（npm `next`） | ✅ 已实测 |
| ≤ 0.1.1-rc.x | ⚠ 未实测 |

`package.json` 声明：`engines.dsh: ">=0.1.2-rc.1"`，另附 `dsh.compatibility.dshReleases` 逐版本表。

自验：`node verify-kernel.mjs <内核树A> [内核树B] ...` —— 26 项宿主契约逐条对比，退出码 `0` 表示不用改代码。

## 功能

**1. 仅在 DeepSeek 系列模型下启用**
按会话判定当前 provider / model，非 DeepSeek 时对**那个 agent** 屏蔽 `highres_read`，
也不注入 pre-step 提醒（不影响其它会话）。中途切换模型即时生效。
判定：provider 为 `deepseek-official`，或模型名含 `deepseek`（兜住第三方中转）。
判定不出时按 `unknownModelPolicy` 处理，默认 `allow`。

**2. 自动抬升每模型图片预算**
宿主适配器（官方 `dsh-llm-deepseek`）会按每个模型的 `imagePixelBudget` 把图片二次投影，
官方默认值只有 640000 像素（≈800×800）/ 1 MiB。
插件加载时**逐条**判定，只给 **DeepSeek 系列**且已声明 `image` 模态的条目补上
`imagePixelBudget: 1690000`（1300×1300）与 `imageMaxBytes: 8388608`（8 MiB），
**立即生效，无需重启**。

- 写入目标只有 `llm-deepseek` 这一个 settings 命名空间（官方 DeepSeek 适配器自己的模型目录）；
  `ginka-*` / `amd` 等 `llm-pi-ai` provider **结构上不会被碰**
- 逐条白名单：id 或 name 不含 `deepseek` 的条目一律跳过
- 只抬不降、不动纯文本模型、不动显式 `low` 档、只在需要时才写盘

**3. 放宽图片限制**
**源准入 + 规范化是两套独立预算，这里一起放宽**，图片进附件库时不再被降采样。

- **源准入**（超标直接拒收）：单图 32 MiB / 单边 8192px / 单请求 600 张 / inline 总量 64 MiB
- **规范化**（存进附件库的那份）：像素上限 8192×8192（DSH 默认 **2048×2048**）/
  长边 8192px / 编码字节 16 MiB（DSH 默认 4 MiB）
- **适配器**：base64 累计 44 MiB

> ⚠️ 只改源准入是不够的 —— v0.3.0 就栽在这：3840×2160 通过准入后，
> 被规范化默认值砍成 2730×1536（**丢 49.4% 像素**），后面 1300 的分块是在降质源上做的。
> v0.3.1 补上规范化预算后原样入库。

**4. 高清分块识图**
注册 `highres_read` 工具，自动定位当前会话最近一张用户图片，生成
**整图 + ≤1300×1300 高清分块**（overlap 自动 65 / 130 / 195px）后通过宿主 `read_image` 注入模型。
不覆盖宿主 `read_image`。用户发大图且模型未调用该工具时，`agent/pre-step` 会提醒。
工具参数：`tile` / `overlap` / `skipWhole` / `maxTiles`。

## 相对 v0.2.0 的改动

| # | 改动 | 说明 |
|---|---|---|
| 1 | **分块基线 800 → 1300** | V4.1-Flash 的等效像素从 ≈800×800 / 384 token 提到 ≈1300×1300 / 1024 token。沿用 800 白丢约 62% 分辨率 |
| 2 | **新增「仅 DeepSeek 系列启用」** | 非 DeepSeek 会话下对该 agent 屏蔽 `highres_read`，切模型即时生效；不碰别的会话 |
| 3 | **新增自动抬升每模型图片预算** | 新增 `lib/model-budget.js`。不抬这段，1300 的分块会在发请求前被压回 800×800 |
| 4 | **修复失效配置键** | `cordis.patch.yml` 里 `maxRequestImageBytes` 在 harness 0.1.2-rc.1 已不存在（静默 no-op），改为 `maxInlineRequestImageBytes` |
| 5 | **修复漏掉的规范化预算**（0.3.1） | 只抬源准入不够：DSH 规范化默认把图压到 2048×2048 以内，3840×2160 入库即丢 49.4% 像素。补上 `normalizedImageMax*` 三个键 |
| 6 | **新增可配置项** | `deepseekOnly` / `unknownModelPolicy` / `modelBudgetScope` / `tile` / `overlap` / `remind` / `remindThreshold` / `autoRaiseModelBudget` / `modelImagePixelBudget` / `modelImageMaxBytes` |
| 7 | **新增离线自检** | `verify.mjs`，不装插件也能跑 |
| 8 | **移除 router-standard 兼容说明** | 上游那套预设已不适配 V4.1-Flash |

> 没变的部分：纯 Node 实现（依赖 `jimp`，不需要 Python / Pillow）、不覆盖宿主 `read_image`、
> 识别后清理本次临时目录而不动附件库。

## 相对 v0.3.1 的改动

| # | 改动 | 说明 |
|---|---|---|
| 1 | **修复「不传参数自动取会话最近一张图」恒失败** | `findLatestSessionImage()` 读的 `session.events` 在 harness 0.1.2-rc.1 的 `Session` 上**不存在**（只有 `snapshotEvents()` / `ownEvents()` / `eventAt()` / `seq`），判定恒为 `undefined` → 不传参数的调用一律返回 `file_path/image/attachmentId is required`。改用 `session.snapshotEvents()`，保留 `events` 作更旧内核回退 |
| 2 | **`verify.mjs` 补上该路径的回归用例** | 之前只测 tile / model-budget / model-detect 三块纯函数，所以这个缺陷从 v0.2.0 一路带到 v0.3.1。现在导出 `sessionEvents` / `findLatestSessionImage` 并直接断言 |
| 3 | **声明适配内核** | `package.json` 加 `engines.dsh: ">=0.1.2-rc.1"` 与 `dsh.compatibility.dshReleases` 逐版本表 |
| 4 | **新增 `verify-kernel.mjs`** | 26 项宿主契约在任意几棵内核树上逐条对比，判断「换内核要不要改代码」 |

> 影响面：带 `file_path` 或 `attachmentId` 的显式调用一直是好的，
> 坏的只有「让插件自己去会话里找最近一张用户附图」这条最省事的路径。

## 配置

```yaml
- id: dsh-highres-vision
  name: dsh-highres-vision
  config:
    deepseekOnly: true               # 只在 DeepSeek 系列模型下启用
    unknownModelPolicy: allow        # 判定不出模型时：allow | deny
    autoRaiseModelBudget: true       # false = 不抬模型预算
    modelBudgetScope: deepseek       # deepseek = 只改 DeepSeek 条目；all = 该命名空间全部
    modelImagePixelBudget: 1690000   # 1300 x 1300
    modelImageMaxBytes: 8388608      # 8 MiB
    tile: 1300                       # 单块最大边长；旧基线可设 800
    overlap: 0                       # 0 = 自动
    remind: true                     # false = 关闭 pre-step 提醒
    remindThreshold: 1300            # 缺省与 tile 一致
```

`modelImagePixelBudget` 需要与 `tile` 同批调整。

> 边界：插件**只抬预算，不改模型名与模态**。模型没写 `inputModalities: [text, image]`
> 时按内核规则视为纯文本而跳过，需要你自行添加。

## 安装

```powershell
git clone https://github.com/azwosile/dsh-highres-vision.git
dsh plugin --profile web add ./dsh-highres-vision
```

装配后重启 DSH Desktop 一次（放宽准入限制的 bundle 补丁只在启动时组合）。
Node >= 18，依赖 `jimp` 安装时自动装好，不需要 Python / Pillow。

自检（不装插件也能跑）：

```powershell
node verify.mjs            # 自包含合成图，预期 112 通过 / 0 失败
node verify.mjs <样本目录>  # 额外跑本地真实图片
node verify-kernel.mjs <内核树A> [内核树B] [...]   # 内核契约对比，退出码 0 = 全部一致
```

## 回滚

```text
dsh plugin --profile web remove dsh-highres-vision
```

（装了超级注入器的话也可以用 `dev_uninject_plugin dsh-highres-vision`）

> 预算抬升写进 `settings.yaml` 后不会随卸载自动撤销，需手动删掉那两个字段或走 Models 页重置。

dsv4fv开发
