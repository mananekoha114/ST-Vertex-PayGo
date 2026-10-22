# Gemini 4 Argon 原生兼容

| 项目 | 说明 |
| --- | --- |
| 适用宿主 | SillyTavern / Luker 的 **Google AI Studio** 与 **Vertex AI** 原生来源 |
| 识别模型 | `gemini-4-argon`、`gemini-4-argon-cyber-permissive` |
| 所需版本 | 前端扩展与 [ST-Vertex-PayGo-Server](https://github.com/mananekoha114/ST-Vertex-PayGo-Server) 均为 **0.6.0** 及以上 |

安装或更新两个组件后，重启 SillyTavern 并刷新浏览器。前端会检查服务端能力；旧服务端不会静默回退到缺少思考配置的请求。普通模型和其他 API 来源继续使用原来的发送路径。

## 已处理的行为

### 思考配置与模型信息

- 使用 `thinkingLevel`：最低档映射到 LOW、最高档映射到 HIGH，保留 MEDIUM；自动档使用模型默认值。返回思考摘要的开关独立控制 `includeThoughts`。
- 不向模型下拉菜单或宿主模型列表添加 Argon 选项，避免与其他插件冲突。对宿主或其他插件已有的模型记录，仅补齐缺失的模型容量信息。
- 输入、思考和输出共享 1,048,576 token 窗口；保留用户已经选择的上下文及输出预算，不自动提高输出上限。

### 请求组装

- 在实际生成的提示词预算裁剪之前，调用宿主媒体方法加入图片、视频和音频。尊重媒体内联开关、列表 / 画廊选择及生成拦截器过滤后的消息集；同文消息、群聊、提示词注入和继续生成均保持附件归属。
- 使用插件自己的同源原生生成接口序列化 Gemini 4 请求，保留系统提示、名字处理、提示词后处理、工具定义、搜索和结构化输出设置；移除已经失效的采样参数及候选数量参数。
- 对以模型消息结尾的继续预填充，保留已有内容并追加用户续写指令，避免发送不被支持的模型预填充。
- Vertex 的 Argon 上游请求在校验票据目标后使用 `v1beta1`，仍保留原有目标、票据、凭证及服务层验证。

### 签名

- 恢复工具调用的上游 ID 和签名。插件用命名空间元数据穿过旧版 ST 的随机 ID 转换，发给 Google 前还原原始值。
- 保留多文本片段的独立签名，包括跨长输出段的签名；非流式消息在宿主保存之前补齐签名。
- 正文被编辑或格式变更后，无法精确匹配的旧签名不会错误地绑定到新内容。

### 长输出续传与费用

- 长输出使用原始请求及最新 continuation token 继续：流式逐片段传递，非流式合并所有片段。
- 每段请求保留原始 `max_tokens`，不会因续传而提高用户预算；到达 MAX_TOKENS 时停止。
- 费用记录按每段最终 usage 汇总。
- 中断、缺失续传令牌、无法核对预算、重复令牌、超出续传次数和缺少终止原因都会明确失败，避免把半截输出标为完整成功。

## 使用限制

- 温度、Top-P、Top-K 在 Argon 上不再具有原来的采样效果；兼容层不会伪造这些参数的效果。
- 输出预算同时包含模型思考和正文，较小的预算仍可能在正文出现前用尽。
- 是否有模型访问权限、区域或服务层配额，仍由 Google 决定。
- 宿主的提示词预览（dry run）跳过生成拦截器，因此预览中的媒体用量可能偏低；真实生成会在预算裁剪前计入媒体。
- OpenAI 兼容桥接的 Gemini 格式转换网关属于另一条链路，这里的原生兼容不会更改它的模型转换规则。

## 验证范围

验证包含前后端完整测试、直接执行本地 ST 1.18 提示词 / 流式解析源码的用例，以及模拟上游的完整链路：前端 → 原生接口 → 私有票据代理 → 多段续传 → ST 解析。没有调用真实付费 Google API，也没有修改 ST 源码文件。

## 官方依据

- [GenerateContent 迁移说明](https://ai.google.dev/gemini-api/docs/generate-content/latest-model)
- [Argon 开发指南](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/guides/gemini-4-argon)
- [思考签名](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)
