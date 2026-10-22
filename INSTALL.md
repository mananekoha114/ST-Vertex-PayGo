# PayGo 安装与更新脚本

安装器只安装 **ST-Vertex-PayGo 前端 + ST-Vertex-PayGo-Server 后端**，支持 Windows PowerShell、macOS、Linux、WSL 和 Android Termux 上已经能正常运行的 SillyTavern ≥ 1.16.0 / Luker ≥ 2.7.0。**不支持 TauriTavern，不包含其他插件。** TauriTavern 用户请按 [README](README.md#第二步安装前端扩展所有客户端通用) 在宿主中安装前端扩展。

**前提**：宿主环境已配置完成——Node.js ≥ 20、Git 可用、宿主依赖已安装。安装器复用宿主的 `yaml` 解析器，不运行 npm、不安装或升级系统依赖、不下载酒馆本体。Google 账号仍在宿主界面配置。

**版本**：默认安装两个仓库 `main` 分支上最新可达的同名 tag（包含预发布）。前端与后端须为同一版本；安装或更新完成后重启宿主并刷新页面。各版本变化见 [更新日志](CHANGELOG.md)。

## 目录

- [快速开始](#快速开始)
- [一条命令在线安装](#一条命令在线安装)
- [一条命令更新](#一条命令更新)
- [面板内更新](#面板内更新)
- [下载文件后运行](#下载文件后运行)
- [选择版本：tag、分支、commit 与本地源码](#选择版本tag分支commit-与本地源码)
- [安装行为](#安装行为)
- [参数参考](#参数参考)
- [备份与恢复](#备份与恢复)
- [维护者说明](#维护者说明)

## 快速开始

**先关闭酒馆**，推荐在酒馆根目录打开终端，再复制对应的一条命令。

| 操作 | Windows PowerShell（5.1 / 7） | Termux / Linux / macOS / WSL |
| --- | --- | --- |
| 首次安装 | `irm https://raw.githubusercontent.com/mananekoha114/ST-Vertex-PayGo/main/bootstrap.ps1 \| iex` | `curl -fsSL https://raw.githubusercontent.com/mananekoha114/ST-Vertex-PayGo/main/bootstrap.sh \| sh` |
| 更新 | `irm https://raw.githubusercontent.com/mananekoha114/ST-Vertex-PayGo/main/update.ps1 \| iex` | `curl -fsSL https://raw.githubusercontent.com/mananekoha114/ST-Vertex-PayGo/main/update.sh \| sh` |

完成后重新启动酒馆并刷新网页，确认 PayGo 面板显示后端已就绪。安装成功只代表文件和配置部署完成；账号可用性及真实 API 调用须在宿主内检查。

## 一条命令在线安装

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/mananekoha114/ST-Vertex-PayGo/main/bootstrap.ps1 | iex
```

Termux / Linux / macOS / WSL：

```sh
curl -fsSL https://raw.githubusercontent.com/mananekoha114/ST-Vertex-PayGo/main/bootstrap.sh | sh
```

### 工作方式

- 命令始终从本仓库 `main` 分支获取最新的在线入口和完整安装器，以便识别旧安装；**插件版本单独选择**，默认取 `main` 最新可达 tag。
- 不需要 GitHub Release 下载资产、解压工具或额外依赖。tag 选择包含预发布，不要求对应正式 Release；找不到 tag 会明确失败，不会回退安装 `main` 最新提交。
- 在线入口不依赖当前目录中已有的安装器文件：先检查现有 Node / Git，下载完整安装器到唯一临时目录，运行安装核心，结束后清理下载目录。与离线入口使用相同的配置备份、重复检查和失败回滚机制。
- Shell 在线入口单独连接终端读取用户输入，不会把 `curl` 正在传来的脚本正文当成路径。Termux 将临时下载放在其私有 HOME 中。PowerShell 的 `iex` 入口使用局部作用域，不会退出正在使用的 PowerShell 窗口。
- 引导脚本下载失败会停止，不会接着用残留目录安装。首次下载引导脚本完全失败时，POSIX 管道的最终状态可能仅反映 `sh`；自动化环境应先把引导脚本下载为文件并检查 `curl` 退出码，再执行它。

### 宿主路径识别

1. 显式 `--host` 或环境变量 `PAYGO_HOST`。
2. 当前目录或它最近的宿主祖先目录。
3. 用户目录中的 `SillyTavern` / `Luker`，以及安装器的有效宿主祖先目录。
4. 无法唯一确定时，在可交互终端中请用户选择或输入路径；没有交互终端则明确报错，不会随意选一个目录。

自定义宿主路径（路径有空格也可）：

```powershell
$env:PAYGO_HOST = 'D:\My SillyTavern'
irm https://raw.githubusercontent.com/mananekoha114/ST-Vertex-PayGo/main/bootstrap.ps1 | iex
```

```sh
curl -fsSL https://raw.githubusercontent.com/mananekoha114/ST-Vertex-PayGo/main/bootstrap.sh | sh -s -- --host "$HOME/My SillyTavern"
```

### 仅预览

```powershell
$env:PAYGO_DRY_RUN = '1'
irm https://raw.githubusercontent.com/mananekoha114/ST-Vertex-PayGo/main/bootstrap.ps1 | iex
Remove-Item Env:PAYGO_DRY_RUN
```

```sh
curl -fsSL https://raw.githubusercontent.com/mananekoha114/ST-Vertex-PayGo/main/bootstrap.sh | sh -s -- --dry-run
```

在线 `--dry-run` 仍会下载并清理临时安装器，只保证不写入宿主；本地入口的 `--dry-run` 则不下载。

在线入口的其他选项通过环境变量或 Shell 参数传入，见 [参数参考](#参数参考)。

## 一条命令更新

已经安装过 PayGo 前端和 Server 的用户，**先关闭酒馆**，在酒馆根目录打开终端，然后运行：

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/mananekoha114/ST-Vertex-PayGo/main/update.ps1 | iex
```

Termux / Linux / macOS / WSL：

```sh
curl -fsSL https://raw.githubusercontent.com/mananekoha114/ST-Vertex-PayGo/main/update.sh | sh
```

更新入口每次下载最新版更新器，仅更新已安装的 PayGo 前端和 Server。它会扫描并识别唯一的旧前端（全局或用户扩展目录）和 Server 变体目录，更新时保留原路径；发现多个副本会拒绝更新并列出冲突。目标必须位于宿主根目录内，且不能经过软链接 / junction。任一组件缺失都会停止并提示先安装，不会默默补装到另一个位置。

### 更新规则

- **保留跟踪分支**：普通更新命令不需要附加参数。旧 Git 安装按分支或标签推断，之后依据 `.git/paygo-updater.json` 中的记录识别。默认策略每次由跟踪分支决定：`main` 追踪最新可达 tag，开发分支按 commit 判断更新；开发版不会自动换回 `main`。显式指定分支会同时应用于两个组件。记录中的 mode、tag 和 commit 仅用于识别与展示，一次 `--mode commit` 不会永久改变 `main` 的默认策略。
- **保留配置**：更新不会启用被关闭的插件，也不改写 `config.yaml` 或聊天、账号、插件设置等宿主数据；必须能找到当前使用的配置文件。
- **备份与回滚**：先下载并验证两个组件，再备份和替换；捕获到的替换错误会回滚。更新时保留完整的所选远端分支历史，用于检查本地提交是否会丢失。
- **保护本地修改**：未提交修改、非远端提交、分叉或远端历史重写默认阻止更新，不会执行强制 reset。确实要覆盖时须显式指定 `--replace-modified` / `PAYGO_REPLACE_MODIFIED=1`，原目录仍完整保存在备份中。
- **已是最新**：版本和跟踪元数据均一致且工作区无修改时，显示 `Already up to date`，不替换插件、不创建备份。旧安装首次写入跟踪元数据时，即使版本相同也可能备份并替换。只有一个组件需要更新时，只备份和替换该组件。下载检查本身仍需要网络和临时空间。
- **不自动降级**：已安装的 `main` 官方提交若领先最新 tag，默认保留当前版本并提示等待新 tag，或显式用 `--mode commit` 继续追踪提交。默认 tag 模式找不到可达 tag 时失败，不会自动切换为 commit 模式。

### 常用更新选项

自定义宿主路径：使用与在线安装相同的 `PAYGO_HOST`，或 Shell 参数：

```sh
curl -fsSL https://raw.githubusercontent.com/mananekoha114/ST-Vertex-PayGo/main/update.sh | sh -s -- --host "$HOME/My SillyTavern"
```

仅预览更新目标（不会查询远端是否有新提交）：

```powershell
$env:PAYGO_DRY_RUN = '1'
irm https://raw.githubusercontent.com/mananekoha114/ST-Vertex-PayGo/main/update.ps1 | iex
Remove-Item Env:PAYGO_DRY_RUN
```

```sh
curl -fsSL https://raw.githubusercontent.com/mananekoha114/ST-Vertex-PayGo/main/update.sh | sh -s -- --dry-run
```

把两个组件切换回 `main` 的最新可达 tag：

```powershell
$env:PAYGO_BRANCH = 'main'
irm https://raw.githubusercontent.com/mananekoha114/ST-Vertex-PayGo/main/update.ps1 | iex
Remove-Item Env:PAYGO_BRANCH
```

```sh
curl -fsSL https://raw.githubusercontent.com/mananekoha114/ST-Vertex-PayGo/main/update.sh | sh -s -- --branch main
```

`main` 高级模式——本次按最新 commit 更新，不等待新 tag。PowerShell 使用后清除变量即恢复默认 tag 策略；若当前官方提交领先最新 tag，仍会保留当前版本而不回退：

```powershell
$env:PAYGO_MODE = 'commit'
irm https://raw.githubusercontent.com/mananekoha114/ST-Vertex-PayGo/main/update.ps1 | iex
Remove-Item Env:PAYGO_MODE
```

```sh
curl -fsSL https://raw.githubusercontent.com/mananekoha114/ST-Vertex-PayGo/main/update.sh | PAYGO_MODE=commit sh
```

选择开发分支时默认就是 commit 模式（分支须在前后端仓库中都存在）：

```sh
curl -fsSL https://raw.githubusercontent.com/mananekoha114/ST-Vertex-PayGo/main/update.sh | sh -s -- --branch feat/your-feature
```

### 旧版本与 ZIP 安装迁移

- 可识别的旧标签 Git 安装按 tag 模式更新；无法可靠识别来源的 detached HEAD 需要显式选择目标。
- 旧 ZIP 安装在确认 PayGo 身份后可以推断 `main`，无需额外指定分支，但仍须用 `--replace-modified` 明确允许覆盖；旧目录会完整备份，再迁移为可更新的 Git 安装。无法确认身份时停止。
- 插件目录里的自定义文件随旧目录备份，不会自动合并进新版本。宿主数据目录中的设置不会迁移或清空。

旧 ZIP 用户可直接运行更新入口并确认备份后替换：

```powershell
$env:PAYGO_REPLACE_MODIFIED = '1'
irm https://raw.githubusercontent.com/mananekoha114/ST-Vertex-PayGo/main/update.ps1 | iex
Remove-Item Env:PAYGO_REPLACE_MODIFIED
```

```sh
curl -fsSL https://raw.githubusercontent.com/mananekoha114/ST-Vertex-PayGo/main/update.sh | sh -s -- --replace-modified
```

已核查 `v0.2.0` 至 `v0.4.0` 的组件身份一致；这不代表每个历史版本都完成了端到端测试。版本比较使用 tag 对应的 Git SHA，不依赖组件 JSON 中的版本号（例如 `v0.3.1` 的 JSON 仍标为 `0.3.0`）。

## 面板内更新

如果前端扩展由宿主的扩展管理器安装（粘贴 Git 地址），后端由「用户设置 → 管理员面板 → 服务端插件」安装，则不必打开终端：管理员可在 **扩展程序 → ST-Vertex-PayGo →「常规」→ 日志与维护** 中检查并执行配套更新。

- 与命令行更新入口遵循同一套版本规则与保护：同一配套 tag、保留跟踪分支、保护本地修改、不自动降级、先下载校验再备份替换、失败回滚。
- 不需要系统 Git、不需要 npm，也不需要先停止宿主；替换后需**重启宿主并刷新页面**才能加载新版本，面板会明确提示这一点。
- 不会修改宿主的 `enableServerPluginsAutoUpdate` 设置；需要严格固定已装版本的用户请自行关闭该设置。
- 后端版本过旧或当前会话不是管理员时，面板不显示该入口。
- 从 ZIP 安装的旧副本没有 Git 记录，面板会明确报错，需要先用 [`--replace-modified`](#旧版本与-zip-安装迁移) 迁移一次。首次安装与故障修复仍使用命令行入口。

## 下载文件后运行

使用包含本文件的前端仓库副本或发布压缩包，保留下面的相对目录结构；不能只下载一个启动器：

```text
install.ps1
install.sh
scripts/
  install.mjs
```

**先彻底停止宿主**，再进入安装器所在文件夹运行。脚本不检测所有可能的宿主进程、不强制结束进程、不自动重启服务。下面的路径替换成你的实际路径；安装器自身应放在待安装的插件目录以外，例如下载目录。

| 平台 | 安装 | 更新 |
| --- | --- | --- |
| Windows PowerShell | `powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 --host "D:\SillyTavern"` | 同左，追加 `--update` |
| macOS / Linux / WSL / Termux | `sh ./install.sh --host "$HOME/SillyTavern"` | 同左，追加 `--update` |
| 任意平台（直接调用核心） | `node ./scripts/install.mjs --host "/path/to/SillyTavern"` | 同左，追加 `--update` |

平台说明：

- **Windows**：`ExecutionPolicy Bypass` 仅对这次 PowerShell 进程有效，不修改系统执行策略。PowerShell 7 也可用 `pwsh -File .\install.ps1 ...`。
- **Android Termux**：与其他平台共用同一个安装核心。使用 `sh` 调用，无需 `chmod`、`sudo`、`/bin/bash`、GNU `sed` 或固定 `/tmp` 路径。宿主须位于 Termux 私有目录（通常是 `$HOME`）；`/sdcard`、`/storage`、`/mnt/media_rw` 及指向这些位置的宿主路径会被拒绝，因为 Android 共享存储不具备 Git 和宿主运行所需的 Unix 文件特性，参见 [Termux 文件系统说明](https://github.com/termux/termux-packages/wiki/Termux-file-system-layout)。这里假设现有 ST 环境已经就绪，不执行 `pkg install`。
- **WSL**：请使用 WSL 内运行的宿主、Node 和 Git，传入 Linux 格式路径。
- **Docker**：可在具备 Node / Git 和写权限的容器环境中运行核心，但必须确认插件和配置位于持久化挂载中；安装器不管理镜像、容器或挂载。

## 选择版本：tag、分支、commit 与本地源码

以下参数同时适用于安装和更新；在线入口可使用 [对应的环境变量](#在线入口环境变量)。

### 默认：最新可达 tag

默认选择下面两个仓库 **`main` 最新可达 tag**，包含预发布 tag；不使用安装器所在工作区的当前分支，也不按 GitHub Release 的正式 / 预发布状态筛选：

- <https://github.com/mananekoha114/ST-Vertex-PayGo>
- <https://github.com/mananekoha114/ST-Vertex-PayGo-Server>

安装器选择 `main` 提交图上最近可达的 tag；同一提交有多个 tag 时，按 Git 版本排序选择最高者，`-suffix` 按预发布处理。两个组件均为 tag 模式时，所选 tag 名称必须一致；自动选择的前后端 tag 不匹配会停止，并提示等待 tag 同步，或用 `--tag` 明确指定两仓库已有的同名 tag。

### 指定 tag

```sh
sh ./install.sh --host "$HOME/SillyTavern" --tag vX.Y.Z
```

旧写法 `--branch vX.Y.Z` 仍兼容，建议使用 `--tag` 表达固定发布版本。

### 开发分支

开发功能必须指定前后端都存在的分支；非 `main` 分支默认使用 commit 模式：

```sh
sh ./install.sh --host "$HOME/SillyTavern" --branch feat/your-feature
```

### 精确 commit

`main` 的最新开发提交须显式选择 `--mode commit`。也可精确固定两个仓库的提交；SHA 必须来自各自仓库，不能把前端 SHA 同时用于后端：

```sh
sh ./install.sh --host "$HOME/SillyTavern" --branch main --mode commit --frontend-commit FRONTEND_SHA --server-commit SERVER_SHA
```

`--frontend-commit` 和 `--server-commit` 必须成对提供，仅用于 commit 模式。

安装器先准备并校验两个组件，再替换现有安装。分支不存在、网络失败或任一组件入口缺失都会终止安装。`--dry-run` 不下载，因此不验证远端分支是否存在：

```sh
sh ./install.sh --host "$HOME/SillyTavern" --dry-run
```

### 本地源码（离线安装 / 安装本地修改）

按标准名称准备配套源码目录：

```text
sources/
  ST-Vertex-PayGo/
    manifest.json
    index.js
    ...
  ST-Vertex-PayGo-Server/
    package.json
    index.cjs
    ...
```

```sh
sh ./install.sh --host "$HOME/SillyTavern" --local-source "/path/to/sources"
```

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 --host "D:\SillyTavern" --local-source "D:\st_plugins"
```

更新本地源码时须显式允许备份后替换：

```sh
node ./scripts/install.mjs --update --host /path/to/SillyTavern --local-source /path/to/sources --replace-modified
```

本地模式复制两份指定目录中的当前文件（含尚未提交的修改），跳过 `.git`、`node_modules`、`.env` 等文件；不会根据 `--branch` 切换本地源码分支。请自行确保前后端版本配套。源目录与宿主目录必须互不包含；如要安装其他开发副本，请先在独立目录按上述标准名称准备配套源码。本地模式首次安装不需要 Git。

## 安装行为

- **安装位置**：前端为所有宿主用户安装到 `public/scripts/extensions/third-party/ST-Vertex-PayGo`，后端安装到 `plugins/ST-Vertex-PayGo-Server`。
- **配置**：将 `config.yaml` 的 `enableServerPlugins` 设为 `true`，保留其他配置语义、注释和原有 LF / CRLF 换行；YAML 的引号或缩进等排版可能被解析器规范化。配置文件不存在时从宿主 `default/config.yaml` 创建。不会开启 CORS 代理或桥接、修改凭据、改动其他插件及聊天数据。
- **版本记录**：远端安装保留 Git 信息，版本识别记录位于各组件的 `.git/paygo-updater.json`。
- **重复安装**：日常更新推荐使用 [更新命令](#一条命令更新)。再次运行**安装**命令会按所选 tag 或 commit 备份并重新部署两个组件；Git 工作区存在未提交修改时默认拒绝覆盖。安装模式不检查未推送或非远端提交，需要这项保护时请使用更新命令。确认需要备份后重新安装时加 `--replace-modified`（依然保留完整备份，不合并本地修改）：

  ```sh
  sh ./install.sh --host "$HOME/SillyTavern" --replace-modified
  ```

- **重复扩展检查**：安装模式会扫描全局目录及 `dataRoot/<用户>/extensions`。发现已有同名或已知 PayGo 身份的其他目录时停止并显示冲突路径，避免用户级旧版遮蔽全局新版或开发副本被重复加载。请先备份并移走旧副本再重试；安装器不迁移不同扩展目录对应的用户设置。更新模式则保留已识别的唯一旧安装路径。
- **自动更新**：宿主的 `enableServerPluginsAutoUpdate` 不会被改变；若指定固定标签或希望严格固定版本，请自行检查该设置。
- **路径边界**：**配置文件和插件目标须位于宿主根目录内**，目标路径中的软链接 / junction 会被拒绝；外置数据目录只用于只读的重复检查。插件放在外部磁盘或外置配置的布局会明确报错，请改用手动安装。该边界使备份、暂存与替换留在同一宿主文件系统中。
- **Luker**：默认读取配置中的 `serverPluginsPath` 和 `globalExtensionsPath`；如果启动时还用了覆盖参数，安装时必须通过 `--plugins-path` / `--extensions-path` 提供对应路径。安装器不修改这些目录配置。SillyTavern 使用其标准插件目录。

## 参数参考

### 命令行参数

| 参数 | 含义 |
| --- | --- |
| `--host PATH` | 宿主根目录；省略时按 [宿主路径识别](#宿主路径识别) 的顺序查找 |
| `--update` | 更新已安装的两个组件；识别已有分支 / 标签及版本模式，配置文件保持原文 |
| `--branch NAME` | 两个组件共同使用的分支；安装默认 `main`，更新默认保留各自分支。`main` 默认 tag 模式，其他分支默认 commit 模式 |
| `--mode tag\|commit` | 显式选择版本模式；`main` 高级开发更新用 `commit` |
| `--tag TAG` | 两仓库中同名的明确发布 tag |
| `--frontend-commit SHA` / `--server-commit SHA` | commit 模式下成对指定两仓库各自的提交 |
| `--local-source PATH` | 从本地源码目录安装（含未提交修改） |
| `--config PATH` | 本次宿主启动使用的配置；相对路径按宿主根目录解析，默认 `config.yaml` |
| `--data-root PATH` | 宿主启动参数覆盖后的数据目录，优先于配置中的 `dataRoot`，用于检查重复扩展 |
| `--plugins-path PATH` | Luker 启动参数覆盖后的服务端插件目录 |
| `--extensions-path PATH` | Luker 启动参数覆盖后的全局扩展目录 |
| `--replace-modified` | 允许备份后替换有本地修改或非托管的旧安装 |
| `--dry-run` | 校验路径与配置并显示计划，不写入、不联网 |
| `--help`, `-h` | 显示完整参数 |

### 在线入口环境变量

显式命令行参数优先于对应的环境变量。

| 环境变量 | 用途 |
| --- | --- |
| `PAYGO_HOST` | 宿主路径 |
| `PAYGO_BRANCH` | 前端和后端共同选择的分支，首次安装默认 `main` |
| `PAYGO_MODE` | `tag` / `commit`；`main` 默认 `tag`，其他分支默认 `commit` |
| `PAYGO_TAG` | 安装或更新到两仓库中同名的 tag |
| `PAYGO_FRONTEND_COMMIT` / `PAYGO_SERVER_COMMIT` | 两仓库各自的提交 SHA，必须成对提供且仅用于 `commit` 模式 |
| `PAYGO_DRY_RUN=1` | 仅预览宿主安装 |
| `PAYGO_REPLACE_MODIFIED=1` | 明确允许备份后替换有本地修改或非远端提交的旧安装 |
| `PAYGO_INSTALLER_REF` | 仅供维护者测试安装器，见 [维护者说明](#维护者说明) |

PowerShell 中用 `$env:变量名 = '值'` 设置，使用后可用 `Remove-Item Env:变量名` 清除。Shell 可将变量放在管道右侧，例如 `curl ... | PAYGO_BRANCH=feat/your-feature sh`。

普通用户即使选择旧 tag 或开发分支，也应保留上方 `main` 的工具 URL，不要把工具来源改成插件版本。

## 备份与恢复

每次实际安装或更新都会创建 `<宿主>/.paygo-install-backups/<时间戳-随机后缀>/`：

- `config.yaml`：安装前的配置原文（之前不存在则没有此文件）。
- `ST-Vertex-PayGo/`、`ST-Vertex-PayGo-Server/`：安装前的完整插件目录（首次安装则没有）。
- `restore.json`：原配置路径、插件目标及原先是否存在的记录，以及各组件的 `changed` 标志；仅恢复 `changed=true` 的组件，单组件更新不会备份另一个组件。

正常捕获到的安装错误会自动回滚；断电、强制结束进程，或回滚本身遇到权限 / 磁盘故障时，可能需要人工恢复：

1. 停止宿主，参考 `restore.json`。
2. 仅将 `changed=true` 的当前组件目标移到临时位置，再把对应备份目录移回原目标；原先不存在的组件无需恢复。
3. 按记录恢复原配置文件；原先没有配置时，移走新建的配置即可。

不要把备份放回 `plugins/` 或扩展扫描目录，否则可能被当作额外插件加载。

`.paygo-install.lock` 阻止同一宿主的并发安装。意外中断后，仅在确认安装进程已结束并完成必要恢复后移除此目录，再重试。备份不会自动清理，其中的配置可能包含私密信息，请按原宿主数据的权限管理。

> 这里的备份针对插件文件与 `config.yaml`。PayGo 用量账本与桥接配置的快照由配套后端单独管理，见 [README](README.md) 的「数据备份与恢复」一节。

## 维护者说明

- **测试安装器本身**：需要同时更改 raw URL 中的分支，并设置 `PAYGO_INSTALLER_REF`；只更改 URL 仍会下载 `main` 的安装器。普通安装和更新始终使用默认 `main` 的最新工具，与插件版本分开。
- **迁移仓库**：请同步更新引导脚本中的仓库地址与本文档中的命令。
- **同步更新入口**：修改 `bootstrap.sh` / `bootstrap.ps1` 后，运行 `node scripts/sync-update-launchers.mjs` 生成在线更新入口；CI 的 `--check` 会防止两套引导逻辑不同步。
- **测试**：运行 `node --test test/install.test.mjs`。覆盖离线 Git 下载、带空格 / 中文路径、首次安装、备份更新、失败回滚、重复扩展、YAML 配置、Luker 自定义目录，以及将在线安装 / 更新正文真正通过 stdin / Invoke-Expression 执行、下载失败、安装失败、无交互终端、正文截断和临时文件清理。更新用例还覆盖分支保留、本地提交保护、detached HEAD、原样保留关闭状态的配置、无新提交时跳过替换。测试用本地 Git 仓库替代远端，避免真实网络影响结果。
- **CI**：跨平台配置见 `.github/workflows/installer.yml`。Android / Termux 真机运行需要单独验证，桌面测试不能代替真机测试。
