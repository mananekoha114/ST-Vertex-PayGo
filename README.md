# ST Vertex AI PayGo 前端扩展

这是一个为 **SillyTavern（酒馆）** 及 **Luker** 打造的前端扩展，在 Vertex AI 连接设置中提供 **Standard、Flex 和 Priority** 三种 PayGo 服务层级选择，并支持 **Google AI Studio 的 Standard / Flex** 弹性调度。

> ⚠️ **重要提示（必须同时安装后端插件）**  
> 本项目**仅为浏览器前端 UI 扩展**。如需正常使用 Flex、Priority 或 PayGo-only 功能，**必须**同时在酒馆中安装配套的 [`ST-Vertex-PayGo-Server`](https://github.com/mananekoha114/ST-Vertex-PayGo-Server) 后端插件。  
> *(注：若选择 Standard 且未勾选 PayGo-only，将走酒馆原版 Vertex AI 通道，完全不经过后端插件。)*

> ⛔ **TauriTavern 用户请注意：**  
> **请勿在 TauriTavern 中安装此扩展！**  
> TauriTavern 原生自带“附加参数”功能，如需启用 PayGo，直接在其自定义请求头中填入 Google 官方对应的 Header 即可。

---

## 主要功能

- **原生无缝集成**：在酒馆原有的 Vertex AI 设置面板中直接嵌入 Standard / Flex / Priority 等级切换控件，开箱即用。
- **Google AI Studio 弹性降本（Flex）**：切换到 Google AI Studio 时复用同一交互面板、后端转发链路与日志系统，按需展示可用选项，无需重复填写 API Key。
- **PayGo-only 专属开关**：强制请求绕过预配吞吐量（Provisioned Throughput），确保纯按量计费。
- **智能区域同步提醒**：Flex 与 Priority 依赖 `global` 全局区域，切换层级时提供弹窗指引并支持一键同步修正。
- **Gemini 原生模型防护**：仅对官方 `gemini-*` 系列模型生效，杜绝误影响 Claude、Llama 等第三方模型。
- **模型兼容名单动态更新**：后台静默获取 GitHub 规则源并每 6 小时自动刷新；离线时无缝切换至本地安全快照或缓存。
- **配置与预设自动持久化**：层级设置自动随当前连接配置或 Chat Completion 预设保存，切换无缝。
- **安全拦截与防静默回退**：实时监测后端插件运行状态。若插件未就绪或代理异常，**直接硬拦截发送，绝不在用户不知情时静默切回原版高价通道**。
- **前后端合并运行诊断日志**：汇总经过白名单筛选的客户端与服务端关键事件，管理员可直接在面板内预览或导出当次运行日志。
- **多语言适配**：自适应酒馆界面语言，完整支持简体中文与繁体中文。

---

## 版本要求

- **宿主程序**：SillyTavern ≥ 1.16.0（已通过 1.16/1.17/1.18 测试）或 Luker ≥ 2.7.0 (release 分支)
- **Node.js 环境**：酒馆服务端运行环境需 Node.js ≥ 20
- **前置认证**：酒馆内已成功配置 Vertex AI（快速模式 API Key 或服务账号 JSON 均可）
- **配套组件**：已安装同版本的 `ST-Vertex-PayGo-Server` 后端插件

---

## 安装教程

本功能由 **后端插件** + **前端扩展** 配合运作，均无需安装额外的 npm 依赖包：

### 第一步：安装后端插件
1. 彻底关闭 SillyTavern 或 Luker。
2. 下载并解压 [`ST-Vertex-PayGo-Server`](https://github.com/mananekoha114/ST-Vertex-PayGo-Server) 仓库，放入酒馆根目录的 `plugins` 文件夹下：
   ```text
   <酒馆根目录>/plugins/ST-Vertex-PayGo-Server/
   ```
3. 打开酒馆根目录下的 `config.yaml`，确认服务端插件已启用：
   ```yaml
   enableServerPlugins: true
   ```

### 第二步：安装前端扩展（本项目）
1. 启动 SillyTavern 或 Luker 服务端。
2. 打开酒馆 Web 页面，点击顶部导航栏 **扩展程序（三块积木图标） -> 安装扩展程序**。
3. 粘贴本仓库的 Git URL，点击安装并确认加载。

---

## 使用说明

1. 点击酒馆顶部的 **API 连接设置（插头图标 🔌）**，接口类型选择 **Chat Completion**，服务商切换为 **Google Vertex AI**。
2. 配置好 Vertex AI 账号、模型与区域，建议先成功发送一条测试消息，验证原生链路畅通。
3. 在下方新增的 **“Vertex AI PayGo”** 面板中，选择需要的服务层级（Standard / Flex / Priority）。
4. 若选择 Flex 或 Priority，按照弹窗指引将区域（Region）改为 `global`。
5. 确认面板内的“服务端插件状态”显示为 **就绪（Ready）** 即可开始使用。
6. *(管理员专享)* 可使用状态指示栏下方的“查看日志”或“保存日志”按钮调取本次运行周期的合并排错日志。

---

## 工作模式与路由规则

### Google AI Studio
1. 在 Chat Completion 中切换为 **Google AI Studio**，填入已绑定结算账户的 Gemini API Key，并选择支持 Flex 的模型。
2. 在 **Google AI Studio Flex** 面板中勾选 **Flex**，并确认后端插件状态为就绪。（*注：两端均需更新至 ≥ 0.3.0 版本，更新后请重启酒馆并刷新前端页面*）。
3. **调度差异**：
   - **Standard**：完全沿用酒馆原生请求管道。
   - **Flex**：经由后端票据验证与本地回环代理，在发送给 Google 的最终请求体中注入顶层字段 `service_tier: "flex"`，同时支持流式与非流式传输。
4. **特性约束**：
   - AI Studio 模式无需调整区域，亦不会发送 Vertex 专用的 `PayGo-only` 或 `Shared-Request-Type` 请求头；
   - 本扩展暂不支持 AI Studio 的 Priority 模式；
   - 若遇到资源不足或排队失败，将直接向上层抛出明确错误，**绝不擅自降级为 Standard 费率重试**；
   - 更多详情参考 [Google 官方 Flex 说明](https://ai.google.dev/gemini-api/docs/generate-content/flex-inference) 与 [价格表](https://ai.google.dev/gemini-api/docs/pricing)。

### Vertex AI
不同配置选项下，请求的具体走向如下：

| 你选择的设置 | 实际请求走向 | 说明 |
| :--- | :--- | :--- |
| **Standard**（未勾选 PayGo-only） | **酒馆原版 Vertex AI 通道** | 原生直接请求，完全不经过本扩展与后端插件。 |
| **Standard**（勾选 PayGo-only） | **后端插件代理** | 注入 `PayGo-only` 标头，强制绕过预配额，走纯按量计费。 |
| **Flex** | **后端插件代理** | 强制要求 `global` 区域，注入 `Flex` 标头，享受官方折扣但允许等待排队。 |
| **Priority** | **后端插件代理** | 强制要求 `global` 区域，注入 `Priority` 高优先级抢占标头。 |

> 💡 **提示**：`PayGo-only` 开关可与 `Flex` 或 `Priority` 叠加生效。  
> ⚠️ **关于 Priority 的特别提醒**：配置 Priority 并不保证 Google 必然 100% 分配高优先级资源；当机房容量极度饱和或项目配额不足时，Google 服务端可能会按其策略以 Standard 费率降级处理。

---

## 模型支持与动态名单

本扩展仅对 Google Vertex AI 与 Google AI Studio 的官方 **`gemini-*` 原生系列模型** 生效：

- **白名单内收录的模型**：允许自由切换至该模型明确支持的 PayGo / Flex 层级。
- **未来新增的 Gemini 模型**：若 Google 推出新模型而本地规则尚未更新，界面将显示黄色“未验证”警示，但**依然放行请求**，交由 Google 服务端作最终鉴权与处理。
- **非 Gemini 模型（Claude、Llama 等）**：Google 官方不支持对此类模型进行层级调度，因此直接走酒馆原生默认通道，扩展不作干预。

### 名单同步与更新机制

- **离线安全优先**：扩展初始化时优先加载内置安全快照，再尝试从浏览器本地存储恢复，完全不阻断弱网或无外网环境下的酒馆启动。
- **后台增量拉取**：就绪后，扩展会在后台拉取 [`data/model-support.json`](data/model-support.json)，并在页面开启期间每 6 小时静默轮询一次（内置 5 秒超时保护）。请求失败或解析异常时平滑继续使用当前有效缓存。
- **校验规范**：远端文件由维护者根据 Google 官方文档生成并托管于 GitHub（非 Google 官方 API）。更新入库前会严格校验 Schema、更新时间戳、模型 ID 格式及历史集合完整度，校验通过后一次性热替换内存状态并持久化。
- **维护原则（针对贡献者）**：
  
  | 来源分类 | 更新时间字段 | 支持层级列表 | 历史追踪全集 |
  | :--- | :--- | :--- | :--- |
  | **Vertex AI** | `updatedAt` | `tiers.flex` / `tiers.priority` | `knownModels` |
  | **Google AI Studio** | `aiStudio.updatedAt` | `aiStudio.tiers.flex` | `aiStudio.knownModels` |

  *注：`knownModels` 历史集合采取**只增不减**原则。若某模型从支持列表中下架，仍须保留在历史集合中，防止被误判为未收录的全新模型。*

---

## 运行日志系统

自 0.3.0 版本起，前端扩展与后端插件建立了统一的安全审计通道：

- **集中式写入**：前端将过滤后的客户端运行状态异步上报给后端，统一写入宿主根目录下的 `st-vertex-paygo.log`。
- **生命周期机制**：服务端每次冷启动或插件重载时自动覆写该文件（仅刷新浏览器不会清空）。
- **格式与配额预算**：
  - 标准 UTF-8 JSON Lines 格式（包含时间戳、来源 `server`/`client`、级别、事件名与上下文元数据）；
  - 单文件容量硬上限为 **5 MiB**；
  - 客户端上报事件配额最多占 **2 MiB**；准备阶段（prepare）失败与未经认证的探测事件享有独立的 2 MiB 预算，耗尽后只丢弃低级噪声，优先保障关键业务诊断日志的完整性。
- **权限与隐私保护**：
  - **仅管理员可用**：出于安全隔离考量，仅具备管理员权限的会话允许上报、查看和导出日志；
  - **绝不落盘敏感数据**：系统严禁收集任何 Google 鉴权 Header、API Key、服务账号内容、Ticket 凭证、请求完整 URL、请求 Payload、提示词内容、模型输出或异常调用栈。

---

## 安全与防坑设计

- 🔒 **密钥生命周期安全**：
  - 扩展会在最终生成请求序列化完成后，才向服务端申请换取临时 PayGo 票据，以此保证 Luker 在单次请求中所覆盖的 `secret_id` 不会丢失；
  - AI Studio 请求中携带的显式密钥 ID 必须存在于当前用户的密钥库中，校验失败即时拦截；
  - 针对 Vertex AI 模式，若请求显式指定了密钥 ID，扩展会明确报错拦截，坚决杜绝宿主误用默认密钥或回退到全局服务账号。
- ⚙️ **多 Profile 与预设隔离**：
  - 连接管理器（含 `/profile-genstream`）严格按照当次请求所绑定的 Profile 中的 `vertex-paygo` 字段提取调度层级；缺失时读取预设，未配置则默认按 Standard 处理，绝不跨 Profile 产生状态污染；
  - 独立 `ChatCompletionService` 请求若未显式指定，亦默认使用 Standard，防止盲目猜度计费层级。
- 🚫 **拒绝隐式静默回退**：若后端无响应、回环鉴权失效或层级不兼容，插件**直接中断链路并弹窗告警**，杜绝“因故障自动切回原生通道导致天价账单”的隐患。
- 🛡️ **第三方反向代理防护**：若检测到 Vertex AI 连接中配置了第三方代理 URL，扩展将自动停用并拒绝拦截，确保原有代理环境不受干扰。

---

## 常见问题 (FAQ)

### Q: “服务端插件状态”始终显示未就绪？
**A**: 请依序检查：
1. 确认后端插件目录完整存放于 `<酒馆根目录>/plugins/ST-Vertex-PayGo-Server/`；
2. 检查酒馆根目录 `config.yaml` 中是否已将 `enableServerPlugins` 设为 `true`；
3. 确认酒馆内核满足版本限制（SillyTavern ≥ 1.16.0 / Luker ≥ 2.7.0）；
4. 文件放入或配置改动后，**必须彻底关闭进程并重新启动酒馆**。

### Q: 为什么无法勾选 Flex 或 Priority 选项？
**A**:
1. 请确认当前选中的模型是否为官方 `gemini-*` 系列；
2. 若当前模型在远端名单中明确被标注为不支持相应特性，对应控件将自动置灰禁用。

### Q: 为什么切换区域（Region）后，层级选项会自动跌回 Standard？
**A**: Google 官方规范强制要求 **Flex 与 Priority 调度必须在 `global` 全局区域下运行**。一旦将区域切换为具体机房（如 `us-central1`），扩展会触发防护，自动回退到 Standard 模式以防调用失败。

### Q: 勾选了 Priority，但在 Google 控制台里看似乎不是优先调度？
**A**: 插件已规范注入 `X-Vertex-AI-LLM-Shared-Request-Type: priority` 请求标头。但实际是否获得抢占调度，最终取决于你的 GCP 结算账户等级、项目专属配额及该区域 Google 算力集群的实时排队状况。

### Q: 设置面板中找不到“查看日志”与“保存日志”按钮？
**A**: 日志查看与导出接口**仅限酒馆管理员权限**使用。此外请确保前后端插件均已更新到 0.3.0 及以上版本并已重启酒馆。

---

## 开发者与测试

本项目为原生 ES 模块设计，无构建编译步骤。在项目根目录下可直接执行本地自动化测试：

```bash
node --test
```

---

## 开源协议

本项目基于 **[Mozilla Public License 2.0 (MPL-2.0)](LICENSE)** 协议开源。凡修改并分发本项目源文件的衍生作品，必须继续遵从 MPL 2.0 开源并完整保留原作者署名与版权声明。
