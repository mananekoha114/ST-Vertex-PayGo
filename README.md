# ST Vertex AI PayGo 前端扩展

支持 **SillyTavern（酒馆）、Luker 和 TauriTavern**，为 Google Vertex AI 提供 **Standard / Flex / Priority** 层级选择，为 Google AI Studio 提供 **Standard / Flex** 选择，并按请求用量估算对话费用。

安装同一个前端扩展后，插件会自动识别宿主，复用已有的 Google 认证配置。通过界面选择层级即可，无需手动填写请求参数。

## 主要功能

- **服务层级与 PayGo-only**：按模型展示可用层级；Vertex AI 可单独开启 PayGo-only，或与 Flex / Priority 组合使用。
- **区域同步**：选择 Vertex Flex / Priority 时，可一并将区域切换为所需的 `global`；AI Studio 无需配置区域。
- **连接与预设配置**：保存当前连接的层级设置；TauriTavern 还支持分别配置 Agent 模型目标（Model Target）。
- **对话费用估算**：从魔法棒菜单查看请求用量、缓存命中和费用小计，支持流式与非流式请求、长上下文价格及手动单价覆盖。统计范围取决于宿主，详见下文。
- **单条回复费用**：角色头像下直接显示这一版回复的估算金额；点击打开用量与费用卡片，查看输入、输出、推理、缓存、耗时和观测速率。
- **模型名单与价格更新**：启动后及页面开启期间每 6 小时同步一次，也可在费用页手动更新；离线时使用有效缓存或内置快照。
- **请求校验**：检查模型、层级、区域和参数冲突，不因 Flex 请求失败而自动改用 Standard 重试。
- **诊断日志**：SillyTavern / Luker 管理员可查看或导出前后端合并日志。
- **界面语言**：支持简体中文与繁体中文。

## 安装与版本要求

当前前端版本为 **0.4.0**。不同宿主使用的发送通道如下：

| 宿主 | 版本与环境 | 需要安装的组件 | 请求通道 |
| :--- | :--- | :--- | :--- |
| SillyTavern | ≥ 1.16.0，已通过 1.16 / 1.17 / 1.18 测试；Node.js ≥ 20 | 本前端 + 后端插件 ≥ 0.4.0（协议 v2） | 配套后端代理 |
| Luker | ≥ 2.7.0，release 分支；Node.js ≥ 20 | 本前端 + 后端插件 ≥ 0.4.0（协议 v2） | 配套后端代理 |
| TauriTavern | 按 2.3.0 公开接口适配，构建需开放第三方扩展、原生附加参数及扩展存储接口 | 仅本前端 | 宿主原生认证与发送通道 |

请先在宿主中配置可用的 Google Vertex AI 或 Google AI Studio 认证。Vertex AI 可使用快速模式 API Key 或服务账号；AI Studio Flex 需要已开通付费的 Gemini API 账号。

部分 iOS 分发构建默认关闭第三方扩展或附加参数能力，请以所用构建的权限为准。缺少原生接口时，插件会显示兼容性提示。

### 1. 安装后端（仅 SillyTavern / Luker）

1. 彻底关闭宿主。
2. 下载并解压 [`ST-Vertex-PayGo-Server`](https://github.com/mananekoha114/ST-Vertex-PayGo-Server)，放入 `<酒馆根目录>/plugins/ST-Vertex-PayGo-Server/`。
3. 在宿主根目录的 `config.yaml` 中启用服务端插件：

   ```yaml
   enableServerPlugins: true
   ```

4. 重新启动宿主。后续更新后端插件时，也需要重启。

TauriTavern 直接进行下一步，无需安装此后端或 Node.js。

### 2. 安装前端（所有宿主）

打开宿主的 **扩展程序 → 安装扩展程序**，粘贴[本仓库地址](https://github.com/mananekoha114/ST-Vertex-PayGo)，安装后刷新页面。用户安装无需执行 npm 或额外编译。

## 使用说明

### 选择连接与服务层级

1. 在 **API 连接设置 → Chat Completion** 中选择 **Google Vertex AI** 或 **Google AI Studio**，配置认证、模型以及 Vertex 区域。
2. 打开对应的层级面板：

   | 宿主 | 设置入口 |
   | :--- | :--- |
   | SillyTavern / Luker | API 连接设置中的 **Vertex AI PayGo** 或 **Google AI Studio Flex** 面板 |
   | TauriTavern | **扩展设置 → Vertex AI PayGo · TauriTavern**，点击标题展开默认折叠的面板 |

3. TauriTavern 的“配置对象”默认选择 **当前 Chat Completion 连接**；需要设置 Agent 时，选择对应的 **Agent 模型目标**。主 Agent 和子 Agent 使用各自绑定目标的配置。
4. 选择服务层级；Vertex AI 可按需开启 PayGo-only。Flex / Priority 要求 Vertex 区域为 `global`，选择时可确认同步修改。
5. SillyTavern / Luker 需确认“服务端插件状态”为 **就绪（Ready）**。TauriTavern 使用原生通道，无需此后端状态。
6. 发送请求后，从输入框左侧 **魔法棒 → 对话费用估算** 查看已采集的用量与费用。

### 保存、预设与恢复 Standard

SillyTavern / Luker 的层级设置与当前连接、Profile 和 Chat Completion 预设关联，后台请求按自身配置选择层级。

TauriTavern 将设置写入当前来源的原生附加参数或所选 Model Target，仅修改层级相关字段，保留其他参数。要将当前连接设置随预设复用，请保存原生预设。

恢复默认层级时，选择 **Standard** 并关闭 **PayGo-only**。TauriTavern 的参数已保存在宿主中，禁用或卸载扩展不会自动撤销，卸载前如需恢复默认，应先完成此操作。

### 服务层级规则

| 来源 | 层级 / 选项 | 行为与要求 |
| :--- | :--- | :--- |
| Vertex AI | Standard | 保留原有区域，使用标准层级。 |
| Vertex AI | PayGo-only | 强制请求使用共享按量通道，绕过预配吞吐量；可与其他层级组合。 |
| Vertex AI | Flex | 仅限支持模型，区域必须为 `global`。 |
| Vertex AI | Priority | 仅限支持模型，区域必须为 `global`；实际服务行为以 Google 返回结果为准。 |
| AI Studio | Standard | 使用标准层级，不添加 Flex 参数。 |
| AI Studio | Flex | 仅限支持模型及付费账号；支持流式与非流式，无需配置区域。 |

AI Studio 不使用 Vertex 的 PayGo-only 请求头，本扩展也不提供 AI Studio Priority 选项。Google 官方规则见 [Vertex Flex](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/flex-paygo)、[Vertex Priority](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/priority-paygo) 和 [AI Studio Flex](https://ai.google.dev/gemini-api/docs/generate-content/flex-inference)。

Standard 与其他层级使用相同的宿主通道：SillyTavern / Luker 的 Gemini 请求经过后端代理采集用量；TauriTavern 通过原生附加参数发送，由前端采集可观察到的响应。Flex 的等待超时及移动端后台行为仍受宿主实现约束。

## 对话费用估算

点击 **魔法棒 → 对话费用估算**。窗口显示已估算小计、最近一次费用、请求数、缓存命中，以及待计价和用量不完整的记录。

### 统计范围与准确性

普通聊天及经过兼容前端发送接口的 Google Gemini 请求会记录用量，涵盖流式与非流式。重生成、滑动生成、续写及可采集的后台请求分别记账；非 Gemini 模型不纳入账本。

- **TauriTavern 非流式用量可能缺少思考 Token 等信息，费用估算可能不准确或偏低。** 面板和对应记录会明确提示，并按“部分估算”呈现。
- **TauriTavern 原生 Agent / 子 Agent 模型循环的费用暂未计入账本。** Agent 层级配置可用，但不能将当前小计当作整个 Agent Run 的总成本。
- 中断、缺失用量和未知计价规则会明确标注；缺少用量或价格不会显示为免费。
- 从升级后的请求开始统计，无法补回旧对话的缓存命中和隐藏思考用量；删除消息不会删除已经产生的费用。

金额是本地估算，并非 Google 结算账单。工具调用、非文本模态、预配吞吐量、缓存存储、税费及赠金等不应据此视为已完整计入。查询账本不会额外调用 Google，也不会为统计再次生成回答。

### 单条回复费用

SillyTavern、Luker 和 TauriTavern 的普通聊天中，角色头像下方会显示本条回复的估算金额，例如 **≈ $0.02331**。点击金额即可打开用量与费用卡片，点击外部、关闭按钮或按 Escape 关闭。文档模式隐藏头像时，入口移到消息正文附近；TauriTavern 虚拟化滚动重新挂载消息后会恢复显示。

- 卡片展示输入、输出（含推理）、推理 Token、缓存命中、未缓存输入、模型、服务层级，以及本地估算费用。
- 每个滑动生成的回复版本单独关联用量，切换版本时金额同步切换；续写累计到当前版本。后台与 Quiet 请求不会挂到角色回复上，聊天中不添加历史账本或对话累计列表。
- 生成中显示“费用估算中”；缺价显示“待计价”，缺失用量与中断会标出未知或部分估算。金额含本次请求发送的上下文，不只是回复正文的费用。新功能只关联启用后观察到的生成，不按时间猜测旧消息的费用。
- 用量、价格快照和请求计时随消息元数据保存，刷新后仍可查看。已完成的消息直接读取保存的快照；待完成记录从现有后端用量接口或 TauriTavern 原生扩展存储补取，查询不会调用模型，TauriTavern 无需 Node 后端。
- TauriTavern 非流式响应使用宿主转换后的用量，标为“部分估算”；未报告的推理、缓存及依赖它们的速率显示 `—`，不按零显示。已报告的缓存用量仍可查看。原生 Agent / 子 Agent 模型循环暂不提供单条费用卡片。
- **耗时口径**：从浏览器实际发送生成请求开始，到响应体读取结束；不包含提示词构建与插件预检。首个有效内容耗时仅用于流式响应，忽略只含角色或用量的空帧。续写显示各次请求耗时之和，首内容耗时为首个请求的观测值。
- **速度口径**：端到端速度 =（正文 + 推理 Token）/ 请求耗时；流式生成速度 = 同样的 Token 数 /（响应结束 − 首个有效内容）。它们是客户端观测估算，受网络、缓冲及推理返回方式影响，不代表服务端实际解码速度；缺少计时或用量时显示 `—`。

### 本地化文案

界面跟随宿主的界面语言。英文、简体中文、繁体中文的文案分别位于 `locales/en.json`、`locales/zh-cn.json`、`locales/zh-tw.json`，可独立编辑，无需修改界面 JavaScript。单条费用卡片的键以 `vertex_paygo.message_cost.` 开头，覆盖金额状态、详情、单位、原因提示和无障碍标签。

编辑时保留键名及 `{amount}`、`{count}` 等占位符；保存后重新加载宿主页面。新增语言文件后，在 `manifest.json` 的 `i18n` 中登记宿主使用的语言代码。未登记的语言使用英文文件，缺失翻译或语言文件加载失败时使用 `src/i18n.js` 的英文回退文案。本地自定义文案可能被后续插件更新覆盖，更新前请备份。

### 自动价格与手动设置

- **自动匹配**：随支持名单同步公开付费文本价格，按来源、完整模型 ID 和服务层级匹配，单位为 **USD / 百万 Token**。费用页可查看核验日期和官方来源。
- **手动覆盖**：可填写普通输入、缓存输入和输出单价；长上下文档位需填写阈值及全部对应单价。手动价格优先，在线更新不会覆盖，也可恢复自动价格。
- **适用范围**：Vertex 自动价格采用 Global 基础价，地区差价、免费额度与合同折扣不会自动识别。官方价格参考：[Vertex AI](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing)、[Gemini API](https://ai.google.dev/gemini-api/docs/pricing)。
- **缺价与过期**：未收录或已过期的价格显示待配置，不推测折扣。未配置价格仍会采集用量，补价后可按当前单价补估，并明确标注。
- **历史快照**：每次请求保存当时的有效价格，之后调价或更新目录不会重算已有价格快照的记录。

文本费用按以下公式估算，超过长上下文阈值时使用对应档位的整段单价：

```text
费用 = ((输入总数 − 缓存命中) × 输入价
      + 缓存命中 × 缓存价
      + (回答 Token + 思考 Token) × 输出价) / 1,000,000
```

### 账本、隐私与备份

账本仅保存模型、层级、时间、用量、价格和对话标识，不保存提示词、回答或密钥。并发请求在发起时绑定对话，切换聊天不会将费用记入新聊天；没有活动对话的后台请求不归入任何对话。角色、群聊和分支分别统计，通过宿主重命名对话可保持关联。

| 宿主 | 账本位置 |
| :--- | :--- |
| SillyTavern / Luker | 当前用户目录下的 `vertex-paygo/usage-ledger.jsonl`，不会随诊断日志清空 |
| TauriTavern | 数据目录下的 `_tauritavern/extension-store/vertex-paygo/kv/chat-<对话ID>/`，每次请求一个记录 |

对话 ID 对应关系和手动价格保存在当前账户的扩展设置，自动价格缓存在浏览器。迁移时请同时备份账户设置与账本；TauriTavern 可随其数据目录一起备份。

## 模型支持与动态名单

本扩展仅对 Google Vertex AI 与 Google AI Studio 的官方 **`gemini-*` 原生系列模型** 生效：

- **名单内收录的模型**：按来源允许选择该模型明确支持的服务层级。
- **未来新增的 Gemini 模型**：若 Google 推出新模型而本地规则尚未更新，界面将显示黄色“未验证”警示，但**依然放行请求**，交由 Google 服务端作最终鉴权与处理。
- **非 Gemini 模型（Claude、Llama 等）**：Google 官方不支持对此类模型进行层级调度，因此直接走酒馆原生默认通道，扩展不作干预。

### 名单与价格同步机制

- **离线安全优先**：扩展初始化时优先加载内置支持名单和价格快照，再尝试从浏览器本地存储恢复，完全不阻断弱网或无外网环境下的酒馆启动。
- **后台联合拉取**：就绪后，扩展会在后台拉取 [`data/model-support.json`](data/model-support.json)，并在页面开启期间每 6 小时静默轮询一次（内置 5 秒超时保护）。费用页也可点击“更新支持列表和价格”。请求失败或解析异常时继续使用当前有效名单和价格。
- **校验规范**：远端文件由维护者根据 Google 官方文档维护并托管于 GitHub（非 Google 官方 API，也不实时抓取官方价格页）。更新前会严格校验 Schema、日期、模型 ID、历史集合、价格字段及文件大小；整份数据通过后才一次性替换内存状态并持久化，任一部分无效则保留原数据。
## 诊断与请求保护

### 运行日志（SillyTavern / Luker）

前端扩展与后端插件将经过过滤的运行状态汇总到宿主根目录的 `st-vertex-paygo.log`。管理员可在设置面板中点击“查看日志”或“保存日志”；TauriTavern 不提供此 Node 服务端合并日志。

- **生命周期**：服务端冷启动或插件重载时覆写文件，仅刷新浏览器不会清空。
- **格式与容量**：UTF-8 JSON Lines，包含时间、来源、级别、事件名和元数据；单文件上限 5 MiB，客户端上报配额最多 2 MiB，准备失败和未经认证的探测事件另有 2 MiB 预算。
- **权限与隐私**：仅管理员可上报、查看和导出。不记录 Google 认证头、密钥、服务账号内容、Ticket、完整请求 URL、请求正文、提示词、模型输出或异常调用栈。

### 认证、配置隔离与冲突

各宿主都按请求配置校验模型、层级与区域，不因请求失败而自动改用 Standard 重试。

**SillyTavern / Luker** 使用后端票据和回环代理：

- 在最终生成请求准备完成后申请临时票据，保留单次请求覆盖的 `secret_id`。显式指定的密钥或服务账号必须存在；宿主缺少所需认证接口时明确报错，不改用默认密钥。未指定 ID 时保留宿主认证方式。
- Connection Manager 请求（含 `/profile-genstream`）按当次 Profile 的层级字段或预设取值，未配置时使用 Standard；独立 `ChatCompletionService` 请求也有请求级配置，避免跨连接串用。
- 后端未就绪、回环鉴权失效或层级不兼容时拦截发送。自定义 Google reverse proxy 不能与本插件代理混用。

**TauriTavern** 使用原生认证和附加参数：

- 当前连接、预设及 Model Target 的参数分别保存，后台请求保留自身的配置与对话归属。
- 修改层级时保留其他附加参数；无法解析或相互冲突的参数会报错。例如已有 `exclude_body` 排除 AI Studio 的 `service_tier` 时，会阻止 Flex 请求，避免层级字段被悄悄删除。
- 原生 Agent 使用所绑定 Model Target 的配置；其模型循环不经过普通聊天的费用采集通道。

## 常见问题

### 找不到设置面板，或提示宿主不兼容？

SillyTavern / Luker 的面板位于 API 连接设置，需先选择 Google Vertex AI 或 Google AI Studio。TauriTavern 的面板位于 **扩展设置 → Vertex AI PayGo · TauriTavern**，默认折叠，点击标题展开。若提示缺少原生接口，请更新至兼容版本，并确认所用构建允许第三方扩展及附加参数。

### “服务端插件状态”始终显示未就绪？

此状态仅适用于 SillyTavern / Luker。确认后端位于 `<酒馆根目录>/plugins/ST-Vertex-PayGo-Server/`，`config.yaml` 中已设置 `enableServerPlugins: true`，且前后端版本符合要求。安装或更新后端后需彻底关闭并重启宿主。TauriTavern 无需安装后端。

### 为什么无法选择 Flex 或 Priority？

确认当前模型是官方 `gemini-*` 模型，且支持相应层级。名单中明确不支持的选项会被禁用；AI Studio 不提供 Priority。Vertex Flex / Priority 还需要 `global` 区域，修改区域后请检查面板状态，按提示同步区域或切换 Standard。

### 为什么非流式费用显示“部分估算”，或 Agent 请求没有计入？

TauriTavern 非流式响应可能缺少思考 Token 等计费信息，原生 Agent / 子 Agent 模型循环也暂未纳入账本。详见“统计范围与准确性”，请勿将小计当作完整账单。

### 找不到“查看日志”和“保存日志”按钮？

这两个按钮仅适用于 SillyTavern / Luker 管理员。请确认前后端均已更新至 0.4.0（协议 v2）或兼容版本，并已重启宿主。TauriTavern 没有此服务端日志功能。

### 禁用插件后，为什么 TauriTavern 仍在使用原来的层级？

层级参数保存在宿主的原生设置中。禁用前请选择 Standard 并关闭 PayGo-only；已经禁用时，可重新启用插件完成此操作。

## 开发者与测试

本项目使用原生 ES 模块，无构建编译步骤。开发测试先执行 `npm ci` 安装仅用于测试的 YAML 解析库，再运行：

```bash
node --test
```

用户安装扩展不需要执行 npm，TauriTavern 模式复用宿主 YAML 库。TauriTavern 适配已通过接口契约和模拟宿主集成测试，尚未完成真实 Tauri 应用及付费 API 联调。

### 支持名单维护

| 来源分类 | 更新时间字段 | 支持层级列表 | 历史追踪全集 |
| :--- | :--- | :--- | :--- |
| **Vertex AI** | `updatedAt` | `tiers.flex` / `tiers.priority` | `knownModels` |
| **Google AI Studio** | `aiStudio.updatedAt` | `aiStudio.tiers.flex` | `aiStudio.knownModels` |

*注：`knownModels` 历史集合采取**只增不减**原则。若某模型从支持列表中下架，仍须保留在历史集合中，防止被误判为未收录的全新模型。*

### 价格表维护与兼容

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

## 开源协议

本项目基于 **[Mozilla Public License 2.0 (MPL-2.0)](LICENSE)** 协议开源。修改并分发本项目源文件的衍生作品，必须继续遵守 MPL 2.0，并完整保留原作者署名与版权声明。
