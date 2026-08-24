[README.md](https://github.com/user-attachments/files/31385017/README.md)
# dsh-highres-vision
> 大肥鱼出来卖个萌
> 🐳 鲸鱼娘登场喵～ 如果这个小插件帮到了你，记得给仓库点个 ⭐ Star 喵！
> 星星越多，鲸鱼娘越开心，也会更有动力继续维护这个插件喵～ 💙
> （求求啦喵～）

> ⚠️ **本插件专供 `deepseek-v4-flash-vision-exp` 模型使用。**
> 该模型是 DeepSeek 的视觉多模态模型，支持图片输入；
> 本插件针对它的 800×800 等效缩放、单图 32MiB / 8192px 上限做了高清分块增强。
> **其他模型通常不支持图片输入，或无法获得同样的高清识图效果。**

DeepSeek Harness 高清识图增强插件。
（本身也是由deepseek v4 flash vision exp开发()）
整合两个能力：

1. **放宽图片限制**
   - 单图 32 MiB
   - 单边 8192px
   - 单请求 600 张
   - inline 总量 64 MiB
   - base64 累计 44 MiB

2. **高清分块识图**
   - 注册 `highres_read` 工具
   - 自动定位当前会话最近一张用户图片
   - 生成整图 + ≤800×800 高清分块（overlap 自动：40/80/120px）
   - 通过宿主 `read_image` 把整图和每个分块注入模型
   - **不覆盖宿主 `read_image`**，`read_image` 保持原样
   - `agent/pre-step` 强制提醒：用户发图后，若模型未调用 `highres_read`，会在每个请求前提示

## 文件结构

```text
dsh-highres-vision/
├── package.json
├── cordis.patch.yml          # 放宽限制 + 挂载插件
├── lib/index.js              # highres_read 工具 / pre-step 提醒
├── scripts/tile_image.py     # 切块脚本（支持 --overlap 0 自动重叠）
├── README.md
├── LICENSE
└── .gitignore
```

## 分块逻辑（完整版）

1. **定位原图**
   - 优先自动定位当前会话最近一张用户图片；
   - 也支持传入 `file_path` / `attachmentId`。

2. **判断是否需要分块**
   - 宽和高都 ≤ 800×800：只返回整图，不分块；
   - 任意一边 > 800×800：生成整图缩略图 + 多个子块。

3. **子块生成规则**
   - `tile = 800px`
   - `overlap` 自动：
     | 原图最大边 | 自动 overlap |
     |---|---|
     | ≤ 1600px | 40px |
     | 1600 ~ 3000px | 80px |
     | > 3000px | 120px |
   - 相邻块至少重叠指定像素，最后一块贴原图边缘；
   - 每块尽量接近 800×800，避免边缘细节被切丢。

4. **注入模型**
   - 先 `read_image` 整图缩略图；
   - 再逐块 `read_image` 所有子块；
   - 模型基于“整图 + 全部分块”输出完整识别结果。

5. **清理**
   - 识别完成后清理本次临时目录；
   - **不清理附件库**。

### 示例

| 原图尺寸 | 自动 overlap | 子块数 |
|---|---|---|
| 1280×720 | 40px | 2 块 + 整图 |
| 2560×1600 | 80px | 12 块 + 整图 |
| 3840×2160 | 120px | 18 块 + 整图 |
| 5120×2880 | 120px | 40 块 + 整图 |

> 以上块数为按当前算法的大致结果，实际以脚本输出为准。

## ⚠️ Token 消耗提示

- `highres_read` 会把 **1 张整图 + N 张子块** 全部注入模型；
- 每张图片都会消耗视觉 token，所以**总消耗远高于直接识别一张原图**；
- 图片越大，子块越多，消耗越大：
  - 3840×2160 约 19 张图（整图 + 18 子块）
  - 5120×2880 约 41 张图（整图 + 40 子块）
- 如果用户只需要**粗略描述/整体判断**，可以直接用模型视觉能力，不需要调用本工具；
- 只有需要 **OCR、小字、局部细节** 时才建议使用；
- 可用 `max_tiles` 限制最多读取的子块数，降低耗时与成本。

## 安装

在 DSH 环境中安装（路径按你的实际仓库替换）：

```text
dev_install_package /path/to/dsh-highres-vision
```

或：

```text
dev_inject_plugin /path/to/dsh-highres-vision
```

重启 DSH Desktop 后，限制 patch 与 router 首轮工具配置完全生效。

## ⚠️ 兼容性说明（风神插件）

如果你使用 `router-standard`（风神插件），它的“RL 接口还原”会在**第一轮只暴露极少数工具**。

如果没有把 `highres_read` 加进 `preserveTools`：

- 模型第一轮**看不到也调不了** `highres_read`；
- pre-step 提醒会提示它调用，但工具不可见，等于没用；
- 第一次调用工具也会因此失败/不可见。

**需要手动加：**

```yaml
# <profile>/.agent-presets/router-standard/agent.cordis.yml
preserveTools:
  - infinite_gen1_profile
  - skill
  - highres_read
```

或改用不收敛首轮工具面的预设（如标准 preset / 全工具 preset）。

> 简单说：**未改动的 router-standard 不兼容本插件的首轮工具调用**，装好后务必按上面配置。

## 使用

模型识图时：

```text
用户上传图片
  ↓
pre-step 提醒：请先调用 highres_read
  ↓
highres_read()
  ↓
自动定位附件 → 切块 → 返回整图 + tiles
  ↓
模型基于整图和分块输出完整识别结果
```

## 回滚

```text
dev_uninject_plugin dsh-highres-vision
```

dsv4fv开发
