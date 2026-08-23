# ST Vertex AI PayGo

为 SillyTavern 的 Google Vertex AI 连接补充 Standard、Flex 和 Priority PayGo 服务层级选择。

本仓库是浏览器端扩展，必须与独立的 `ST-Vertex-PayGo-Server` Server Plugin 配套使用，才能发送 Flex、Priority 或 PayGo-only 请求。Standard 且未启用 PayGo-only 时仍使用 SillyTavern 原生 Vertex AI 请求，不经过 Server Plugin。

> 当前版本兼容 SillyTavern 1.18.x。它是非官方扩展，与 SillyTavern、Google 或 Google Cloud 没有隶属或认可关系。

## 功能

- 在 SillyTavern 的 Vertex AI 设置下增加 Standard、Flex 和 Priority 选择。
- 提供 PayGo-only 开关，用于绕过预配吞吐量并仅使用 PayGo。
- Flex 和 Priority 要求使用 `global`；切换层级或区域时会通过确认框保持配置一致。
- 仅对原生 `gemini-*` 模型启用 PayGo 路由，不影响其他 Vertex AI 模型。
- 内置截至 2026-08-22 的模型支持快照。未知的新 Gemini 模型会显示警告，但仍交由 Vertex AI 做最终验证。
- 设置会随当前 Vertex AI 连接配置（Connection Profile）保存；没有活动连接配置时，保存到当前 Chat Completion 预设。
- 跟随 SillyTavern 界面语言，当前提供简体中文和繁体中文。
- 检查配套 Server Plugin 的状态，并在准备代理失败时拦截请求，避免静默退回原生 Vertex AI 路径。

## 环境要求

- SillyTavern 1.18.x。
- 已在 SillyTavern 中配置并验证可用的 Vertex AI Express 或完整服务账号认证。
- 配套的 `ST-Vertex-PayGo-Server` 仓库。
- Server Plugin 所在环境使用 Node.js 20 或更高版本。

## 安装

停止 SillyTavern，然后将两个仓库分别放到以下目录：

```text
SillyTavern/
├─ public/scripts/extensions/third-party/ST-Vertex-PayGo/
└─ plugins/ST-Vertex-PayGo-Server/
```

两个项目都没有需要单独安装的运行时 npm 依赖。重新启动 SillyTavern 后，在 Vertex AI 设置中应看到“Vertex AI PayGo”区域，并且“服务端插件”状态应显示为就绪。

仓库上传并配置远程地址之前，请使用上述手动安装方式。

## 使用

1. 在 SillyTavern 的 API 连接设置中选择 Chat Completion 和 Google Vertex AI。
2. 配置 Vertex AI 认证、模型和区域，并先确认原生 Standard 请求可以正常工作。
3. 在新增的“Vertex AI PayGo”区域中选择服务层级。
4. 使用 Flex 或 Priority 时接受切换到 `global`，或手动将 Vertex AI 区域设为 `global`。
5. 确认 Server Plugin 状态为就绪后发送请求。

### 路由行为

| 设置 | 请求路径 | 说明 |
| --- | --- | --- |
| Standard，PayGo-only 关闭 | SillyTavern 原生 Vertex AI | 不调用 Server Plugin。 |
| Standard，PayGo-only 开启 | Server Plugin | 添加 PayGo-only 请求头，绕过预配吞吐量。 |
| Flex | Server Plugin | 要求 `global`，添加 Flex 请求头，并允许较长的服务端等待时间。 |
| Priority | Server Plugin | 要求 `global`，添加 Priority 请求头。 |

PayGo-only 可以与 Flex 或 Priority 同时启用。Vertex AI 最终决定请求的实际调度结果；选择 Priority 不保证响应一定标记为 `ON_DEMAND_PRIORITY`，容量或账号条件不足时可能按 Standard 处理。

## 模型策略

扩展只接受以 `gemini-` 开头的原生 Vertex AI 模型 ID：

- 当前快照明确支持所选层级的模型可以直接使用。
- 已知只属于另一个层级的模型会被阻止，并提示切换模型或 Standard。
- 尚未出现在快照中的新 Gemini 模型会显示“未验证”警告，但请求仍可发送，由 Vertex AI 返回最终结果。
- 非 Gemini 模型只能使用 SillyTavern 原生 Standard 路径。

模型快照位于 `src/model-policy.js`，后续更新支持列表时应同时更新快照日期和测试。

## 安全行为

- 扩展不会在浏览器中处理或保存新的 Google 凭据；认证仍由 SillyTavern 管理。
- 需要 Server Plugin 的请求会先安装兜底拦截地址，只有 prepare 成功后才替换为一次性的本机回送代理。
- 已配置自定义 Vertex 反向代理时，PayGo 路由会直接阻止请求，避免覆盖现有代理设置。
- Server Plugin 不可用、协议不匹配、区域或模型不合法时，请求不会静默退回原生 Vertex AI。

Server Plugin 的安全设计和限制请参阅其独立仓库中的 `README.md`。

## 常见问题

### 服务端插件显示不可用

确认 Server Plugin 位于 `SillyTavern/plugins/ST-Vertex-PayGo-Server`，SillyTavern 使用的是 1.18.x，并在安装后完整重启了服务端。

### Flex 或 Priority 无法选择

确认当前模型 ID 以 `gemini-` 开头。若模型已知不支持所选层级，对应选项会被禁用；未知的新 Gemini 模型则只会显示警告。

### 切换区域后自动变回 Standard

Flex 和 Priority 目前要求 `global`。当你改用区域端点时，扩展会要求在“新区域 + Standard”和“保留 global + 当前层级”之间选择。

### Priority 没有返回 `ON_DEMAND_PRIORITY`

扩展和 Server Plugin 只负责发送 Priority 请求头。Vertex AI 仍会根据模型、项目资格、配额和可用容量决定实际流量类型，因此这不一定表示插件没有发送请求头。

## 开发与测试

本仓库不需要构建步骤。运行测试：

```powershell
node --test
```

当前测试覆盖本地化、模型策略、状态转换、预设和连接配置持久化、服务端握手，以及出错即拦截的请求钩子。

## 许可与署名

Copyright © 2026 [Mana Nekoha](https://github.com/mananekoha114)（@mananekoha114）

本项目采用 [Mozilla Public License 2.0](LICENSE)（SPDX：`MPL-2.0`）许可。修改并分发本项目文件时，请遵守 MPL 2.0 的文件级开放源代码要求。
