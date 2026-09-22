# ST Vertex AI PayGo 前端扩展

这是一个为 **SillyTavern（酒馆）** 及 **Luker** 打造的前端扩展，在 Vertex AI 连接设置中提供 **Standard、Flex 和 Priority** 三种 PayGo 服务层级选择，并支持 **Google AI Studio 的 Standard / Flex** 弹性调度。

> ⚠️ **重要提示（必须同时安装后端插件）**  
> 本项目**仅为浏览器前端 UI 扩展**。Gemini Standard、Flex、Priority、PayGo-only 及费用统计功能，**必须**同时在酒馆中安装配套的 [`ST-Vertex-PayGo-Server`](https://github.com/mananekoha114/ST-Vertex-PayGo-Server) 后端插件。\
> 前后端请一起升级至 **0.4.0（协议 v2）**，重启酒馆并刷新前端页面。Standard 也经过本地代理采集用量，但不会自动启用 PayGo-only；非 Gemini 模型仍走酒馆原生 Standard 通道。

> ⛔ **TauriTavern 用户请注意：**  
> **请勿在 TauriTavern 中安装此扩展！**  
> 扩展检测到 TauriTavern 后，会弹出不可用说明与 Service Tier 切换指引，并停止初始化，不会接管请求或访问配套后端。每次页面加载只提示一次；可在扩展程序中禁用或卸载本扩展。TauriTavern 用户请使用下方的原生设置方法。

### 在 TauriTavern 中切换 Service Tier

适用于 **TauriTavern 2.1.0 及以上**（已核对 2.3.0 源码）。在 **API 连接设置 → Chat Completion** 中先选择对应 API 来源，再点击连接按钮旁的 **附加参数（Additional Parameters）**。这些设置按来源分别保存，输入会自动保存，编辑后关闭弹窗即可。保留已有的其他参数。

**Google Vertex AI**：选择支持相应层级的 Gemini 模型，Flex / Priority 将 **Region 设为 `global`**。在 **Include Request Headers（包含请求头）** 中填入 YAML：

```yaml
X-Vertex-AI-LLM-Request-Type: shared
X-Vertex-AI-LLM-Shared-Request-Type: flex
```

- **Flex**：使用上面的两行。
- **Priority**：将第二行的 `flex` 改为 `priority`。
- **Standard**：删除第二行；若不需要强制 PayGo（绕过预配吞吐量），也删除第一行。仅需 Standard PayGo 时保留第一行。

**Google AI Studio**：先切换至该来源，使用已开通付费的 Gemini API 账号和支持 Flex 的模型，在 **Include Body Parameters（包含请求体参数）** 中填入 YAML：

```yaml
service_tier: flex
```

恢复 **Standard** 时删除 `service_tier` 字段。AI Studio 不使用上述 Vertex 请求头，也无需设置 Vertex 区域。找不到附加参数入口时，请更新 TauriTavern 至 2.1.0 或更新版本。

核验依据：[TauriTavern 2.1.0 更新说明](https://github.com/Darkatse/TauriTavern/releases/tag/v2.1.0)、[附加参数字段](https://github.com/Darkatse/TauriTavern/blob/v2.3.0/src/scripts/templates/customEndpointAdditionalParameters.html)、[按来源保存逻辑](https://github.com/Darkatse/TauriTavern/blob/v2.3.0/src/scripts/openai.js#L7454-L7471)、[Vertex Flex](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/flex-paygo)、[Vertex Priority](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/priority-paygo)、[AI Studio Flex](https://ai.google.dev/gemini-api/docs/generate-content/flex-inference)。

---

## 主要功能

- **原生无缝集成**：在酒馆原有的 Vertex AI 设置面板中直接嵌入 Standard / Flex / Priority 等级切换控件，开箱即用。
- **Google AI Studio 弹性降本（Flex）**：切换到 Google AI Studio 时复用同一交互面板、后端转发链路与日志系统，按需展示可用选项，无需重复填写 API Key。
- **PayGo-only 专属开关**：强制请求绕过预配吞吐量（Provisioned Throughput），确保纯按量计费。
- **智能区域同步提醒**：Flex 与 Priority 依赖 `global` 全局区域，切换层级时提供弹窗指引并支持一键同步修正。
- **Gemini 原生模型防护**：仅对官方 `gemini-*` 系列模型生效，杜绝误影响 Claude、Llama 等第三方模型。
- **模型名单与价格同步更新**：后台获取 GitHub 支持名单和公开文本价格，每 6 小时自动刷新，也可在费用页立即更新；离线时使用有效缓存或内置快照。
- **配置与预设自动持久化**：层级设置自动随当前连接配置或 Chat Completion 预设保存，切换无缝。
- **安全拦截与防静默回退**：实时监测后端插件运行状态。若插件未就绪或代理异常，**直接硬拦截发送，绝不在用户不知情时静默切回原版高价通道**。
- **前后端合并运行诊断日志**：汇总经过白名单筛选的客户端与服务端关键事件，管理员可直接在面板内预览或导出当次运行日志。
- **对话费用估算**：从输入框左侧魔法棒菜单打开，按实际用量估算费用，支持缓存命中、思考 Token、长上下文价格和单个模型的手动价格覆盖。
- **多语言适配**：自适应酒馆界面语言，完整支持简体中文与繁体中文。

---

## 版本要求

- **宿主程序**：SillyTavern ≥ 1.16.0（已通过 1.16/1.17/1.18 测试）或 Luker ≥ 2.7.0 (release 分支)
- **Node.js 环境**：酒馆服务端运行环境需 Node.js ≥ 20
- **前置认证**：酒馆内已成功配置 Vertex AI（快速模式 API Key 或服务账号 JSON 均可）
- **配套组件**：前端扩展与 `ST-Vertex-PayGo-Server` 后端插件均更新至 0.4.0（协议 v2）

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
7. 点击输入框左侧 **魔法棒 → 对话费用估算**，查看当前对话的请求用量、缓存命中与费用小计。

---

## 对话费用估算（0.4.0）

点击输入框左侧 **魔法棒 → 对话费用估算**。窗口显示已估算小计、最近一次费用、请求数、缓存命中，以及待计价和用量不完整的记录。

### 自动价格与手动设置

- **自动匹配**：随支持名单同步公开付费文本价格，按来源、完整模型 ID 和服务层级匹配，单位为 **USD / 百万 Token**。价格设置中可查看核验日期和官方来源。
- **手动覆盖**：可为单个模型与层级填写普通输入、缓存输入和输出价格；长上下文档位需填写阈值及全部对应单价。手动价格优先，在线更新不会覆盖，也可点击“恢复自动价格”。
- **适用范围**：Vertex 自动价格采用 **Global 基础价**。地区差价、免费额度与合同折扣不会自动识别，请按实际情况调整。官方价格参考：[Vertex AI](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing)、[Gemini API](https://ai.google.dev/gemini-api/docs/pricing)。
- **缺价与过期**：未收录或已过期的价格显示待配置，不推测折扣，也不将其当作免费请求。未配置价格仍会采集 Token；补充价格后可按当前单价补估，并明确标注。
- **历史快照**：每次请求保存当时的有效价格，之后修改价格或更新目录不会重算已有价格快照的记录。

### 用量与费用记录

文本费用按以下公式估算，超过长上下文阈值时使用对应档位的整段单价：

```text
费用 = ((输入总数 − 缓存命中) × 输入价
      + 缓存命中 × 缓存价
      + (回答 Token + 思考 Token) × 输出价) / 1,000,000
```

- **统计起点**：从升级后的请求开始，无法补回旧对话的缓存命中和隐藏思考用量。重生成、滑动生成、续写及该对话发起的后台 Google 请求分别记账；删除消息不会删除已经产生的费用。没有活动对话的后台请求不归入任何对话。
- **计价边界**：中断、缺失用量和未知计价规则会明确标注。工具费用、非文本模态、预配吞吐量、缓存存储费、税费及赠金不应据此当作完整账单。
- **持久化**：账本保存在当前酒馆用户目录的 `vertex-paygo/usage-ledger.jsonl`，不会随诊断日志清空。仅记录模型、层级、时间、用量、价格与随机对话 ID，不保存提示词、回答或密钥；用户只能读取自己的账本。
- **对话隔离**：不同角色、群聊和分支分别统计，使用酒馆重命名操作可保持关联。并发请求在发起时绑定对话，切换聊天不会将费用归到新聊天。
- **设置与备份**：对话 ID 对应关系和手动价格保存在当前账户的扩展设置，自动价格缓存在浏览器。迁移时应同时备份账户设置与账本。

金额是本地估算，并非 Google 结算账单。查询账本不会额外调用 Google，也不会为了统计再次生成回答。Gemini Standard 在 Vertex AI 与 AI Studio 均经过插件；非 Gemini 模型不纳入账本。自定义 Google reverse proxy 与本插件代理不能同时启用。

---

## 工作模式与路由规则

### Google AI Studio
1. 在 Chat Completion 中切换为 **Google AI Studio**，填入已绑定结算账户的 Gemini API Key，并选择支持 Flex 的模型。
2. 在 **Google AI Studio Flex** 面板中勾选 **Flex**，并确认后端插件状态为就绪。（*注：两端均需更新至 0.4.0（协议 v2），更新后请重启酒馆并刷新前端页面*）。
3. **调度差异**：
   - **Standard**：经过后端代理采集实际用量，保持 Standard 层级，不注入 Flex 参数。
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
| **Standard**（未勾选 PayGo-only） | **后端插件代理** | 采集用量，保持原有区域、认证与 Standard 层级；不注入 PayGo-only 标头。 |
| **Standard**（勾选 PayGo-only） | **后端插件代理** | 注入 `PayGo-only` 标头，强制绕过预配额，走纯按量计费。 |
| **Flex** | **后端插件代理** | 强制要求 `global` 区域，注入 `Flex` 标头，享受官方折扣但允许等待排队。 |
| **Priority** | **后端插件代理** | 强制要求 `global` 区域，注入 `Priority` 高优先级抢占标头。 |

> 💡 **提示**：`PayGo-only` 开关可与 `Flex` 或 `Priority` 叠加生效。\
> ⚠️ **关于 Priority 的特别提醒**：配置 Priority 并不保证 Google 必然 100% 分配高优先级资源；当机房容量极度饱和或项目配额不足时，Google 服务端可能会按其策略以 Standard 费率降级处理。

---

## 模型支持与动态名单

本扩展仅对 Google Vertex AI 与 Google AI Studio 的官方 **`gemini-*` 原生系列模型** 生效：

- **白名单内收录的模型**：允许自由切换至该模型明确支持的 PayGo / Flex 层级。
- **未来新增的 Gemini 模型**：若 Google 推出新模型而本地规则尚未更新，界面将显示黄色“未验证”警示，但**依然放行请求**，交由 Google 服务端作最终鉴权与处理。
- **非 Gemini 模型（Claude、Llama 等）**：Google 官方不支持对此类模型进行层级调度，因此直接走酒馆原生默认通道，扩展不作干预。

### 名单与价格同步机制

- **离线安全优先**：扩展初始化时优先加载内置支持名单和价格快照，再尝试从浏览器本地存储恢复，完全不阻断弱网或无外网环境下的酒馆启动。
- **后台联合拉取**：就绪后，扩展会在后台拉取 [`data/model-support.json`](data/model-support.json)，并在页面开启期间每 6 小时静默轮询一次（内置 5 秒超时保护）。费用页也可点击“更新支持列表和价格”。请求失败或解析异常时继续使用当前有效名单和价格。
- **校验规范**：远端文件由维护者根据 Google 官方文档维护并托管于 GitHub（非 Google 官方 API，也不实时抓取官方价格页）。更新前会严格校验 Schema、日期、模型 ID、历史集合、价格字段及文件大小；整份数据通过后才一次性替换内存状态并持久化，任一部分无效则保留原数据。
- **维护原则（针对贡献者）**：

  | 来源分类 | 更新时间字段 | 支持层级列表 | 历史追踪全集 |
  | :--- | :--- | :--- | :--- |
  | **Vertex AI** | `updatedAt` | `tiers.flex` / `tiers.priority` | `knownModels` |
  | **Google AI Studio** | `aiStudio.updatedAt` | `aiStudio.tiers.flex` | `aiStudio.knownModels` |

  *注：`knownModels` 历史集合采取**只增不减**原则。若某模型从支持列表中下架，仍须保留在历史集合中，防止被误判为未收录的全新模型。*

### 价格表维护与兼容（针对贡献者）

继续使用 schema v1 和原有缓存键，在同一 JSON 中增加可选 `pricing` 字段：

| 字段 | 含义 |
| :--- | :--- |
| `pricing.updatedAt` | 独立核验日期；拒绝旧于当前价格快照或异常未来日期的更新 |
| `pricing.currency` / `pricing.unit` | 固定为 `USD` / `per_million_tokens` |
| `pricing.entries` | 按 `source`、精确 `model`、`tier` 唯一匹配的价格条目 |
| `input` / `cachedInput` / `output` | 普通输入、缓存输入、输出单价 |
| `longContextThreshold` / `longInput` / `longCachedInput` / `longOutput` | 可选长上下文阈值及完整档位单价 |
| `sourceUrl` / `validUntil` | 官方来源及可选有效截止日期；限时价到该 UTC 日期结束后停止用于新请求 |

旧文件缺少 `aiStudio` 或 `pricing` 时，保留对应的当前有效数据并写回缓存；明确提供但无效的内容会导致整份更新被拒绝。空 `pricing.entries` 可撤回自动价格，用户手动覆盖不受影响。价格条目不代表模型支持该层级，支持判断仍以对应名单为准。

维护价格时须同步更新 `data/model-support.json` 与 `src/bundled-pricing.js`，测试会检查两者一致。数据发布至仓库 `main` 后，已安装客户端才能通过原地址自动获取；本地文件修改不会直接更新远端目录。

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
  - Vertex Express/Full 按显式密钥 ID 读取对应 API Key 或服务账号；指定密钥不存在，或宿主缺少所需认证接口时会明确报错，不回退到默认密钥或其他服务账号。未指定 ID 时保留宿主原有认证方式。
- ⚙️ **多 Profile 与预设隔离**：
  - 连接管理器（含 `/profile-genstream`）严格按照当次请求所绑定的 Profile 中的 `vertex-paygo` 字段提取调度层级；缺失时读取预设，未配置则默认按 Standard 处理，绝不跨 Profile 产生状态污染；
  - 独立 `ChatCompletionService` 请求若未显式指定，亦默认使用 Standard，防止盲目猜度计费层级。
- 🚫 **拒绝隐式静默回退**：若后端无响应、回环鉴权失效或层级不兼容，插件**直接中断链路并弹窗告警**，杜绝“因故障自动切回原生通道导致天价账单”的隐患。
- 🛡️ **第三方反向代理防护**：若 Gemini 请求配置了自定义 Google 反代 URL，扩展会报错并拦截发送，避免与本插件代理混用。

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
**A**: 日志查看与导出接口**仅限酒馆管理员权限**使用。此外请确保前后端插件均已更新到 0.4.0（协议 v2）并已重启酒馆。

---

## 开发者与测试

本项目为原生 ES 模块设计，无构建编译步骤。在项目根目录下可直接执行本地自动化测试：

```bash
node --test
```

---

## 开源协议

本项目基于 **[Mozilla Public License 2.0 (MPL-2.0)](LICENSE)** 协议开源。凡修改并分发本项目源文件的衍生作品，必须继续遵从 MPL 2.0 开源并完整保留原作者署名与版权声明。
