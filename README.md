# ST Vertex AI PayGo 前端扩展

这是一个为 **SillyTavern（酒馆）** 及 **Luker** 打造的前端扩展，专门用于在 Vertex AI 连接设置中新增 **Standard、Flex 和 Priority** 三种 PayGo 服务层级选择。

> ⚠️ **重要提示（必须同时安装后端插件）**  
> 本项目**只是浏览器前端扩展**。如果要正常使用 Flex、Priority 或 PayGo-only 功能，**必须**同时在酒馆中安装配套的 [`ST-Vertex-PayGo-Server`](https://github.com/mananekoha114/ST-Vertex-PayGo-Server) 后端插件。  
> *(注：如果选择 Standard 且未勾选 PayGo-only，会走酒馆原版 Vertex AI 通道，不经过后端插件。)*

> ⛔ **TauriTavern 用户请注意：**  
> **请勿在 TauriTavern 中安装此扩展！**  
> TauriTavern 自带“附加参数”功能，如需使用 PayGo，直接在其自带的自定义请求头（Custom Headers）中填入官方对应的 Header 即可。

---

## 主要功能

- **无缝集成设置面板**：在酒馆原本的 Vertex AI 配置下方，直接添加 Standard / Flex / Priority 等级切换选项。
- **PayGo-only 专属开关**：可强制绕过预配吞吐量（Provisioned Throughput），完全使用按量计费（PayGo）。
- **智能区域切换提示**：由于 Google 要求 Flex 和 Priority 必须配合 `global` 区域使用，切换层级时扩展会贴心弹窗提示并帮你同步设置。
- **Gemini 原生模型专属保护**：仅针对官方 `gemini-*` 系列模型启用 PayGo，不影响其他 Vertex AI 模型。
- **内置模型兼容列表**：内置截止 2026 年 8 月支持的模型名单。遇到未来未知的新 Gemini 模型时会显示提醒，但仍允许发送由 Google 端进行最终校验。
- **配置自动保存**：你的 PayGo 偏好设置会自动保存在当前的 Vertex AI 连接配置或 Chat Completion 预设中。
- **状态联动与安全拦截**：自动检测配套后端插件的状态。如果后端插件未就绪或准备代理失败，会直接拦截发送，**防止在不知情的情况下静默回退到默认的原生通道**。
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
2. 打开酒馆页面，点击顶部 **扩展程序（三块积木图标 🧩） -> 安装扩展程序**。
3. 在安装输入框中粘贴本仓库的 Git URL 并点击安装。

---

## 使用说明

1. 点击酒馆顶部的 **API 连接设置（插头图标 🔌）**，接口类型选择 **Chat Completion**，服务商选择 **Google Vertex AI**。
2. 配置好你的 Vertex AI 账号、模型和区域，建议先测试一条消息，确保原本的 Vertex AI 能正常连接。
3. 在页面下方新增的 **“Vertex AI PayGo”** 设置栏中，选择你想要使用的服务层级（Standard / Flex / Priority）。
4. 如果选择了 Flex 或 Priority，请按照弹窗提示将区域（Region）改为 `global`。
5. 确认“服务端插件状态”显示为 **就绪（Ready）**，即可开始愉快聊天！

---

## 工作模式与路由规则

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

本扩展专门针对 Google Vertex AI 原生的 **`gemini-*` 系列模型**：

- **官方支持的模型**：可以直接自由切换 Standard / Flex / Priority。
- **未来新增的 Gemini 模型**：如果 Google 推出了全新的 Gemini 模型但本扩展尚未更新名单，界面会显示“未验证”黄字提醒，但**依然允许你发送请求**，交由 Google 官方验证。
- **非 Gemini 模型（如 Claude、Llama 等）**：这些模型在 Google 官方并没有开放层级调度，因此会直接走酒馆原本的默认通道，不受本扩展影响。

---

## 安全与防坑机制

- 🔒 **密钥安全**：扩展仅在浏览器端工作，不会偷存或上传你的 Google Key/服务账号，认证完全由酒馆本地管理。
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

---

## 开发者与测试

本项目无需繁琐的打包构建步骤（开箱即用）。如果你需要进行二次开发或运行内置测试集：

```bash
node --test
```

---

## 开源协议

Copyright © 2026 [Mana Nekoha](https://github.com/mananekoha114)（@mananekoha114）

本项目采用 [Mozilla Public License 2.0 (MPL-2.0)](LICENSE) 开源协议。修改并分发本项目代码时，请遵守 MPL 2.0 相关的开源与署名要求。