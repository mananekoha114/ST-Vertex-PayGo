# ST Vertex AI PayGo

为 SillyTavern 及其兼容分支 Luker 的 Google Vertex AI 连接补充 Standard、Flex 和 Priority PayGo 服务层级选择。

本仓库是浏览器端扩展，必须与独立的 `ST-Vertex-PayGo-Server` 服务器插件配套使用，才能发送 Flex、Priority 或 PayGo-only 请求。Standard 且未启用 PayGo-only 时仍使用酒馆和Luker原生的 Vertex AI 请求，不经过服务器插件修改。

> 当前版本已验证兼容 SillyTavern 1.16.0、1.17.0、1.18.0，以及 Luker 2.7.0 的 release 分支。它是非官方扩展，与 SillyTavern、Luker、Google 或 Google Cloud 没有隶属或认可关系。

__此扩展不能在TauriTavern中使用，此扩展不能在TauriTavern中使用，此扩展不能在TauriTavern中使用__

TauriTavern自带附加参数功能，请在那里面的自定义请求头中按照官方文档的要求填入对应的请求头

## 功能

- 在酒馆和Luker的 Vertex AI 设置下增加 Standard、Flex 和 Priority 选择。
- 提供 PayGo-only 开关，用于绕过预配吞吐量并仅使用 PayGo，不过普通用户没人买预配额玩酒馆吧。
- Flex 和 Priority 要求必须使用 `global`；切换层级或区域时会通过确认框保持配置一致。
- 仅对原生 `gemini-*` 模型启用 PayGo 路由，不影响其他 Vertex AI 模型。
- 内置截至2026年8月22日的模型支持列表。未知的新 Gemini 模型会显示警告，但仍交由 Vertex AI 做最终验证。
- 设置会随当前 Vertex AI 连接配置保存；没有活动连接配置时，保存到当前 Chat Completion 预设。
- 跟随酒馆和Luker的界面语言，当前提供简体中文和繁体中文（繁体中文是GPT敲的）。
- 检查配套服务器插件的状态，并在准备代理失败时拦截请求，避免静默退回原生 Vertex AI 路径。

## 环境要求

- SillyTavern 1.16.0 或更高版本，或者 Luker 2.7.0 release 分支。
- 已在酒馆或Luker中配置并验证可用的 Vertex AI 快速模式Key或完整服务账号认证。
- 配套的 `ST-Vertex-PayGo-Server` 插件。
- 服务器插件 所在环境使用 Node.js 20 或更高版本。

## 安装

关闭酒馆或Luker，然后将ST-Vertex-PayGo-Server放到酒馆或Luker根目录下的以下位置：

```text
<根目录>/plugins/ST-Vertex-PayGo-Server/
```
之后确认在酒馆或Luker的`config.yaml`中`enableServerPlugins`为true。
启动酒馆或Luker，在扩展程序/安装扩展程序里面输入此仓库的URL进行前端安装。

两个项目都没有需要单独安装的运行时 npm 依赖。重新启动酒馆或Luker后，在 Vertex AI 设置中应看到“Vertex AI PayGo”区域，并且“服务端插件”状态应显示为就绪。

## 使用

1. 在酒馆或Luker的插头里选择聊天补全和 Google Vertex AI。
2. 配置 Vertex AI 认证、模型和区域，并先确认原生 Standard 请求可以正常工作。
3. 在新增的“Vertex AI PayGo”区域中选择服务层级。
4. 使用 Flex 或 Priority 时接受切换到 `global`，或手动将 Vertex AI 区域设为 `global`。
5. 确认服务器插件状态为就绪后发送请求。

## 许可与署名

Copyright © 2026 [Mana Nekoha](https://github.com/mananekoha114)（@mananekoha114）

本项目采用 [Mozilla Public License 2.0](LICENSE)（SPDX：`MPL-2.0`）许可。修改并分发本项目文件时，请遵守 MPL 2.0 的文件级开放源代码要求。
