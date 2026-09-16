# ST Vertex AI PayGo 前端扩展

这是一个为 **SillyTavern（酒馆）** 及 **Luker** 打造的前端扩展，在 Vertex AI 连接设置中提供 **Standard、Flex 和 Priority** 三种 PayGo 服务层级选择，并支持 **Google AI Studio 的 Standard / Flex**。

> ⚠️ **重要提示（必须同时安装后端插件）**  
> 本项目**只是浏览器前端扩展**。如果要正常使用 Flex、Priority 或 PayGo-only 功能，**必须**同时在酒馆中安装配套的 [`ST-Vertex-PayGo-Server`](https://github.com/mananekoha114/ST-Vertex-PayGo-Server) 后端插件。  
> *(注：如果选择 Standard 且未勾选 PayGo-only，会走酒馆原版 Vertex AI 通道，不经过后端插件。)*

> ⛔ **TauriTavern 用户请注意：**  
> **请勿在 TauriTavern 中安装此扩展！**  
> TauriTavern 自带“附加参数”功能，如需使用 PayGo，直接在其自带的自定义请求头中填入官方对应的 Header 即可。

---

## 主要功能

- **无缝集成设置面板**：在酒馆原本的 Vertex AI 配置下方，直接添加 Standard / Flex / Priority 等级切换选项。
- **Google AI Studio Flex**：切换到 Google AI Studio 时复用同一设置面板、连接配置、后端转发和日志，仅显示适用选项，无需重复填写 API Key。
- **PayGo-only 专属开关**：可强制绕过预配吞吐量，完全使用按量计费（PayGo）。
- **智能区域切换提示**：由于 Google 要求 Flex 和 Priority 必须配合 `global` 区域使用，切换层级时扩展会贴心弹窗提示并帮你同步设置。
- **Gemini 原生模型专属保护**：仅针对官方 `gemini-*` 系列模型启用 PayGo，不影响其他 Vertex AI 模型。
- **模型兼容列表自动更新**：启动后从 GitHub 后台获取最新名单，并每 6 小时刷新；断网时自动使用上次成功缓存或内置快照。
- **配置自动保存**：你的 PayGo 偏好设置会自动保存在当前的 Vertex AI 连接配置或 Chat Completion 预设中。
- **状态联动与安全拦截**：自动检测配套后端插件的状态。如果后端插件未就绪或准备代理失败，会直接拦截发送，**防止在不知情的情况下静默回退到默认的原生通道**。
- **前后端合并运行日志**：记录经过筛选的客户端与服务端状态，管理员可在设置面板中直接查看或保存本次启动周期的日志。
- **多语言支持**：跟随酒馆界面语言，支持简体中文与繁体中文。

---

## 版本要求

- **酒馆程序**：SillyTavern ≥ 1.16.0（已测试兼容 1.16/1.17/1.18）或 Luker ≥ 2.7.0 (release 分支)
- **Node.js 版本**：运行酒馆的环境需要 Node.js ≥ 20
- **Vertex 认证**：已经在酒馆中配置好可用的 Vertex AI（无论是快速模式 API Key 还是服务账号 json 均可）
- **配套插件**：已安装 `ST-Vertex-PayGo-Server` 后端插件

---

## 安装教程

本功能由 **后端插件** + **前端扩展** 两部分组成，只需两步即可搞定（均无需安装额外的 npm 依赖）：

### 第一步：安装后端插件
1. 彻底关闭 SillyTavern 或 Luker。
2. 下载并解压 [`ST-Vertex-PayGo-Server`](https://github.com/mananekoha114/ST-Vertex-PayGo-Server) 仓库，放到酒馆根目录的 `plugins` 文件夹中：
   ```text
   <酒馆根目录>/plugins/ST-Vertex-PayGo-Server/
   ```
3. 打开酒馆根目录下的 `config.yaml`，确认里面开启了插件支持：
   ```yaml
   enableServerPlugins: true
   ```

### 第二步：安装前端扩展（本项目）
1. 重新启动 SillyTavern 或 Luker。
2. 打开酒馆页面，点击顶部 **扩展程序（三块积木图标） -> 安装扩展程序**。
3. 在安装输入框中粘贴本仓库的 Git URL 并点击安装。

---

## 使用说明

1. 点击酒馆顶部的 **API 连接设置（插头图标 🔌）**，接口类型选择 **Chat Completion**，服务商选择 **Google Vertex AI**。
2. 配置好你的 Vertex AI 账号、模型和区域，建议先测试一条消息，确保原本的 Vertex AI 能正常连接。
3. 在页面下方新增的 **“Vertex AI PayGo”** 设置栏中，选择你想要使用的服务层级（Standard / Flex / Priority）。
4. 如果选择了 Flex 或 Priority，请按照弹窗提示将区域（Region）改为 `global`。
5. 确认“服务端插件状态”显示为 **就绪（Ready）**，即可开始愉快聊天！
6. 管理员可使用状态下方的“查看日志”或“保存日志”按钮读取本次服务启动周期的合并日志。

---

## 工作模式与路由规则

### Google AI Studio

1. 在 Chat Completion 中选择 **Google AI Studio**，配置已开通付费的 Gemini API Key 和支持 Flex 的模型。
2. 在 **Google AI Studio Flex** 面板选择 **Flex**，确认服务端插件就绪。前后端都需要更新至包含本功能的 `0.3.0` 版本，更新后重启酒馆并刷新页面。
3. **Standard** 继续使用酒馆原生请求；**Flex** 复用后端票据和回环转发，在最终 Google 请求体中设置 `service_tier: "flex"`，支持流式与非流式响应。

AI Studio 无需设置 Vertex 区域，也不会发送 Vertex 的 PayGo-only 或 Shared-Request-Type 标头。已有 PayGo-only 偏好在此来源下不生效；本扩展暂不提供 AI Studio Priority。请求失败会返回错误，不会自动改为 Standard 重试。

[Google 官方 Flex 说明](https://ai.google.dev/gemini-api/docs/generate-content/flex-inference)和[价格表](https://ai.google.dev/gemini-api/docs/pricing)说明了折扣、模型支持和等待时间。扩展负责选择服务层级，实际费用由 Google 结算。

AI Studio 和 Vertex 共用仓库名单的拉取、缓存和定时刷新机制，各自维护独立的日期与模型记录。AI Studio 内置快照（2026-09-10）包含 Gemini 2.5 Pro / Flash / Flash-Lite；未知 Gemini 模型沿用“未验证”提示和 Google 最终校验。

### Vertex AI

不同设置下，你的生成请求会走不同的通道：

| 你选择的设置 | 实际请求走向 | 说明 |
| :--- | :--- | :--- |
| **Standard**（且未开启 PayGo-only） | **酒馆原版 Vertex AI** | 原汁原味，不经过本插件处理。 |
| **Standard**（开启 PayGo-only） | **后端插件** | 注入 PayGo-only 标头，强制绕过预配额，走按量计费。 |
| **Flex** | **后端插件** | 强制要求 `global` 区域，注入 Flex 标头，允许更长的排队等待时间。 |
| **Priority** | **后端插件** | 强制要求 `global` 区域，注入 Priority 高优先级标头。 |

> 💡 **提示**：`PayGo-only` 开关可以与 `Flex` 或 `Priority` 叠加使用。  
> 需要注意的是，选择 `Priority`（高优先级）并不代表 Google 一定会 100% 给你分配高优先级通道；当 Google 机房容量不足或账号配额受限时，Google 会自动降级为 Standard 计费处理。

---

## 模型支持规则

以下规则和自动更新机制适用于 Google Vertex AI 与 Google AI Studio 原生的 **`gemini-*` 系列模型**，各自按对应来源的名单判断：

- **官方支持的模型**：可以切换到名单中明确支持的 PayGo 层级。
- **未来新增的 Gemini 模型**：如果 Google 推出了全新的 Gemini 模型但本扩展尚未更新名单，界面会显示“未验证”黄字提醒，但**依然允许你发送请求**，交由 Google 官方验证。
- **非 Gemini 模型（如 Claude、Llama 等）**：这些模型在 Google 官方并没有开放层级调度，因此会直接走酒馆原本的默认通道，不受本扩展影响。

### 名单更新机制

扩展始终先启用内置安全快照，再从浏览器缓存恢复上次成功获取的名单，因此初始化和发送请求不会依赖 GitHub 是否在线。界面及请求钩子就绪后，扩展会在后台获取 [`data/model-support.json`](data/model-support.json)，并在当前页面存活期间每 6 小时重新检查一次。GitHub 请求设有 5 秒超时；超时、断网、HTTP 错误或数据校验失败时会继续使用当前有效名单。

远端文件是本项目根据 Google 官方 [Flex PayGo](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/flex-paygo)、[Priority PayGo](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/priority-paygo) 与 [AI Studio Flex](https://ai.google.dev/gemini-api/docs/generate-content/flex-inference) 文档维护的机器可读镜像，并不是 Google 官方提供的 GitHub 数据源。载入前会完整校验 schema、日期、模型 ID、文件大小以及历史模型集合，只有整份数据有效时才会一次性替换内存策略并写入缓存。任一来源的名单变化都会触发界面刷新，后续请求也会使用更新后的名单。

维护名单时，按来源修改同一份文件中的对应字段：

| 来源 | 更新日期 | 层级名单 | 历史模型集合 |
| :--- | :--- | :--- | :--- |
| Vertex AI | `updatedAt` | `tiers.flex` / `tiers.priority` | `knownModels` |
| Google AI Studio | `aiStudio.updatedAt` | `aiStudio.tiers.flex` | `aiStudio.knownModels` |

两份 `knownModels` 各自只增不减：模型即使从层级名单下架，也必须留在对应来源的历史集合中，避免被误判为尚未收录的新模型。仅修改 AI Studio 名单时，无需修改 Vertex 的日期或名单。可以将 `aiStudio.tiers.flex` 设为空数组来停用所有已收录模型的 Flex 支持，但仍须保留历史集合。

继续使用 schema v1 和原有缓存键，兼容旧版 Vertex 名单。远端或缓存文件缺少 `aiStudio` 字段时，会保留当前有效的 AI Studio 名单；明确提供但无效、过时或丢失历史模型的 `aiStudio` 数据会导致整份更新被拒绝。成功拉取旧版文件后，缓存也会保留先前取得的 AI Studio 名单。

运行时仍从 `main` 分支拉取 `data/model-support.json`；本地 `0.3.0` 中的名单修改需要发布到 `main` 后，其他客户端才能自动获取。合并名单后会直接影响客户端判定，建议为分支启用保护规则并要求人工审核名单变更。

---

## 运行日志

从 0.3.0 起，前端扩展会把经过筛选的客户端运行状态发送给同源的配套后端插件，与服务端状态一起写入宿主根目录的 `st-vertex-paygo.log`。

- 前端和后端插件都需要升级到 0.3.0。服务端插件每次启动或重新初始化时都会先覆写日志文件；只刷新浏览器不会清空它。
- 日志是 UTF-8 JSON Lines 格式，记录时间、来源（`server` / `client`）、级别、事件名和白名单上下文；文件最大为 5 MiB。客户端事件最多占 2 MiB，prepare 开始/失败及未认证 loopback 事件另有最多 2 MiB 的独立预算，为有效请求的服务端诊断保留空间。
- 日志属于同一服务实例的共享诊断信息，因此只有管理员可以上报客户端事件以及查看或保存日志；普通已登录用户没有日志读写权限。
- “查看日志”会安全地显示读取到的文本；“保存日志”会读取最新快照并下载为 `st-vertex-paygo.log`，不会修改服务端原文件，下载位置由浏览器设置决定。
- 客户端事件使用最多 100 条的内存缓冲队列重试；如果服务端不可用或页面被关闭，少量尚未成功上报的事件仍可能丢失。
- 日志不会记录 Google 鉴权头、API Key、服务账号内容、Ticket、代理 Token、请求 URL、请求体、提示词、模型响应、错误堆栈或其他任意自由文本。

---

## 安全与防坑机制

普通聊天在最终请求序列化完成后才申请 PayGo 票据，以保留 Luker 单次请求覆盖的 `secret_id`。Connection Manager（包括 `/profile-genstream`）按本次指定 profile 的 `vertex-paygo` 字段选择层级；字段缺失时读取本次使用的预设。独立 `ChatCompletionService` 请求按指定预设选择，未指定层级时使用 Standard，不继承当前页面另一个 profile 的层级。找不到指定的 Google 请求预设时会报错，避免猜测计费层级。

AI Studio 的显式密钥 ID 必须存在于当前用户的密钥存储中，不存在时会拦截请求。Vertex Express/Full 暂不支持显式密钥 ID：携带 ID 的 PayGo 请求会明确报错，避免宿主使用默认密钥或默认服务账号。未指定 ID 时保留宿主原有认证方式。

预设写入失败会通知界面保存失败，同时仍尝试保存当前设置；后续预设保存可继续执行。升级这批修复需要更新两端源码、重启酒馆并刷新浏览器页面。

- 🔒 **密钥安全**：扩展不会记录或上传你的 Google Key、服务账号、提示词或模型响应；它只向同源后端提交严格白名单化的结构化运行事件。GitHub 名单请求明确不携带凭据，Vertex 认证仍完全由酒馆本地管理。
- 🚫 **拒绝静默回退（防扣错费）**：如果后端插件未启动、通信失败或模型配置错误，扩展会**直接报错并拦截请求**，绝不会在不知情的情况下悄悄切回原版通道，避免产生意外账单。
- 🛡️ **第三方反代保护**：如果你已经在 Vertex AI 中填写了自定义反代 URL，扩展会自动拒绝生效，防止搞乱你原有的反代设置。

---

## 常见问题 (FAQ)

### Q: “服务端插件状态”一直显示不可用/未就绪？
**A**: 请按以下步骤排查：
1. 确认后端插件文件夹放在了 `<酒馆根目录>/plugins/ST-Vertex-PayGo-Server/` 下。
2. 打开酒馆根目录的 `config.yaml`，确认 `enableServerPlugins: true` 已经开启。
3. 检查酒馆版本是否满足要求（SillyTavern ≥ 1.16.0 / Luker ≥ 2.7.0）。
4. 修改配置或放入文件后，必须**完全关闭并重启酒馆**。

### Q: 为什么 Flex 或 Priority 选项是灰色的，无法选择？
**A**: 
1. 检查当前选择的模型 ID 是否以 `gemini-` 开头。
2. 某些已知不支持特定层级的模型会被禁用该选项。

### Q: 为什么一切换区域（Region），层级就自动变回 Standard 了？
**A**: 因为 Google 官方规定 **Flex 和 Priority 必须绑定 `global` 全局区域**。当你切换到其他具体区域（如 `us-central1`）时，扩展会自动弹窗询问，若离开 `global` 区域则必须退回 Standard 模式。

### Q: 为什么选了 Priority，但在 Google 后台看没有显示优先？
**A**: 插件已经成功向 Google 发送了 Priority 请求标头。但实际能否享受到优先队列，最终取决于你当前 GCP 项目的配额等级以及 Google 服务器当时的负载情况。

### Q: 为什么看不到“查看日志”或“保存日志”？
**A**: 日志读取仅对管理员开放。请确认前端扩展和后端插件都已升级到 0.3.0，并在升级后完整重启酒馆；保存失败时还需确认浏览器允许下载。

### Q: 日志文件在哪里，什么时候会被清空？
**A**: 文件位于 `<酒馆根目录>/st-vertex-paygo.log`。每次启动酒馆或重新初始化服务端插件时都会覆写，刷新浏览器页面不会清空。

---

## 开发者与测试

本项目无需繁琐的打包构建步骤（开箱即用）。如果你需要进行二次开发或运行内置测试集：

```bash
node --test
```

---

## 开源协议

本项目采用 [Mozilla Public License 2.0 (MPL-2.0)](LICENSE) 开源协议。修改并分发本项目代码时，请遵守 MPL 2.0 相关的开源与署名要求。
