# PayGo 自动安装脚本

只安装 **ST-Vertex-PayGo 前端 + ST-Vertex-PayGo-Server 后端**。支持 Windows PowerShell、macOS、Linux、WSL 和 Android Termux 上已经能正常运行的 SillyTavern ≥ 1.16.0 / Luker ≥ 2.7.0。**不支持 TauriTavern，不包含其他插件。**

默认宿主环境已配置完成：Node.js ≥ 20、Git 可用，宿主依赖已安装。安装器复用宿主的 `yaml` 解析器，不运行 npm、不安装或升级系统依赖、不下载酒馆本体。Google 账号仍在宿主界面配置。

## 一条命令在线安装

以下命令从本仓库的 `main` 分支获取在线入口和完整安装器，不需要 GitHub Release、解压工具或额外安装依赖。维护者迁移仓库时，请同步更新引导脚本中的仓库地址与下方命令。

用户先关闭酒馆，推荐在酒馆根目录打开终端，再复制对应的一条命令。

Windows PowerShell（5.1 / 7）：

```powershell
irm https://raw.githubusercontent.com/mananekoha114/ST-Vertex-PayGo/main/bootstrap.ps1 | iex
```

Termux / Linux / macOS / WSL：

```sh
curl -fsSL https://raw.githubusercontent.com/mananekoha114/ST-Vertex-PayGo/main/bootstrap.sh | sh
```

在线入口不依赖当前目录中已有安装器文件。它先检查现有 Node/Git，下载一份完整安装器到唯一临时目录，再运行安装核心，结束后清理下载目录。只安装 PayGo 前端和 Server 后端；与离线入口使用相同的配置备份、重复检查和失败回滚机制。

宿主路径识别顺序：

1. 显式 `--host` 或环境变量 `PAYGO_HOST`。
2. 当前目录或它的最近宿主祖先目录。
3. 用户目录中的 `SillyTavern` / `Luker` 以及安装器的有效宿主祖先目录。
4. 无法唯一确定时，在可交互终端中请用户选择或输入路径。没有交互终端则明确报错，不会随意选一个目录。

Shell 在线入口单独连接终端读取用户输入，不会把 `curl` 正在传来的脚本正文当成路径。Termux 将临时下载放在其私有 HOME 中，宿主仍须位于私有存储。PowerShell 的 `iex` 入口使用局部作用域，不会退出用户正在使用的 PowerShell 窗口。

自定义宿主路径（路径有空格也可）：

```powershell
$env:PAYGO_HOST = 'D:\My SillyTavern'
irm https://raw.githubusercontent.com/mananekoha114/ST-Vertex-PayGo/main/bootstrap.ps1 | iex
```

```sh
curl -fsSL https://raw.githubusercontent.com/mananekoha114/ST-Vertex-PayGo/main/bootstrap.sh | sh -s -- --host "$HOME/My SillyTavern"
```

仅预览安装：

```powershell
$env:PAYGO_DRY_RUN = '1'
irm https://raw.githubusercontent.com/mananekoha114/ST-Vertex-PayGo/main/bootstrap.ps1 | iex
Remove-Item Env:PAYGO_DRY_RUN
```

```sh
curl -fsSL https://raw.githubusercontent.com/mananekoha114/ST-Vertex-PayGo/main/bootstrap.sh | sh -s -- --dry-run
```

在线 `--dry-run` 仍会下载并清理临时安装器，只对宿主保证不写入；本地入口的 `--dry-run` 则不下载。

| 在线环境变量 | 用途 |
| --- | --- |
| `PAYGO_HOST` | 宿主路径；显式 `--host` 优先 |
| `PAYGO_BRANCH` | 前端和后端共同使用的分支/标签，默认 `main`；显式 `--branch` 优先 |
| `PAYGO_INSTALLER_REF` | 下载完整安装器时使用的前端仓库分支/标签，默认 `main`；与插件版本分开 |
| `PAYGO_DRY_RUN=1` | 仅预览宿主安装 |
| `PAYGO_REPLACE_MODIFIED=1` | 明确允许备份后替换有修改或非 Git 的旧安装 |

PowerShell 中用 `$env:变量名 = '值'` 设置，使用后可用 `Remove-Item Env:变量名` 清除。Shell 可将变量放在管道右侧，例如 `curl ... | PAYGO_BRANCH=feat/google-openai-bridge sh`。请确保前后端均有指定分支。

维护者在发布前测试开发分支时，需要同时更改 raw URL 中的分支，并设置 `PAYGO_INSTALLER_REF` 为该分支；只更改 URL 仍会下载 `main` 的安装器。引导脚本下载失败会停止，不会接着用残留目录安装。首次下载引导脚本完全失败时，POSIX 管道的最终状态可能仅反映 `sh`；自动化环境应先把引导脚本下载为文件并检查 `curl` 退出码，再执行它。

## 下载文件后运行

使用包含本文件的前端仓库副本或发布压缩包，保留下面的相对目录结构；不能只下载一个启动器：

```text
install.ps1
install.sh
scripts/
  install.mjs
```

**先彻底停止宿主**，再进入安装器所在文件夹运行。脚本不检测所有可能的宿主进程、不强制结束进程、不自动重启服务。下面的路径替换成你的实际路径；安装器自身应放在待安装的插件目录以外，例如下载目录。

Windows（PowerShell）：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 --host "D:\SillyTavern"
```

`ExecutionPolicy Bypass` 仅对这次 PowerShell 进程有效，不修改系统执行策略。PowerShell 7 也可用 `pwsh -File .\install.ps1 ...`。

macOS / Linux / WSL：

```sh
sh ./install.sh --host "$HOME/SillyTavern"
```

Android Termux：

```sh
sh ./install.sh --host "$HOME/SillyTavern"
```

Termux 与其他平台共用同一个安装核心。使用 `sh` 调用，无需 `chmod`、`sudo`、`/bin/bash`、GNU `sed` 或固定 `/tmp` 路径。宿主须位于 Termux 私有目录（通常是 `$HOME`）；`/sdcard`、`/storage`、`/mnt/media_rw` 及指向这些位置的宿主路径会被拒绝。Android 共享存储不适合 Git 和宿主运行所需的 Unix 文件特性，参见 [Termux 文件系统说明](https://github.com/termux/termux-packages/wiki/Termux-file-system-layout)。这里假设现有 ST 环境已经就绪，不执行 `pkg install`。

WSL 请使用 WSL 内运行的宿主、Node 和 Git，传入 Linux 格式路径。Docker 部署可在具备 Node/Git 和写权限的容器环境中运行核心，但必须确认插件和配置位于持久化挂载中；安装器不管理镜像、容器或挂载。

也可在所有支持的平台直接使用核心：

```sh
node ./scripts/install.mjs --host "/path/to/SillyTavern"
```

## 预览、分支和本地源码

先预览目标和配置，不写文件、不联网：

```sh
sh ./install.sh --host "$HOME/SillyTavern" --dry-run
```

默认分别从下面两个仓库的 **main** 分支安装，不使用安装器所在工作区的当前分支：

- <https://github.com/mananekoha114/ST-Vertex-PayGo>
- <https://github.com/mananekoha114/ST-Vertex-PayGo-Server>

开发功能必须同时指定前后端都存在的分支或标签，例如：

```sh
sh ./install.sh --host "$HOME/SillyTavern" --branch feat/google-openai-bridge
```

安装器先准备并校验两个组件，再替换现有安装。分支不存在、网络失败或任一组件入口缺失都会终止安装。`--dry-run` 不下载，因此不验证远端分支存在性。

离线安装 / 安装当前本地修改：

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

Windows 当前工作区的例子：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 --host "D:\SillyTavern" --local-source "D:\st_plugins"
```

本地模式复制两份指定目录中的当前文件（含尚未提交的修改），跳过 `.git`、`node_modules`、`.env` 等文件；不会根据 `--branch` 切换本地源码分支。请自行确保前后端版本配套。源目录与宿主目录必须互不包含；如要安装其他开发副本，请先在独立目录按上述标准名称准备配套源码。本地模式首次安装不需要 Git。

## 安装行为与更新

默认前端为所有宿主用户安装到 `public/scripts/extensions/third-party/ST-Vertex-PayGo`，后端安装到 `plugins/ST-Vertex-PayGo-Server`。安装器将 `config.yaml` 的 `enableServerPlugins` 设为 `true`，保留其他配置语义、注释和原有 LF/CRLF 换行；YAML 的引号或缩进等排版可能被解析器规范化。配置文件不存在时从宿主 `default/config.yaml` 创建。不会开启 CORS 代理或桥接、修改凭据、改动其他插件及聊天数据。

远端安装保留 Git 信息，可继续通过宿主更新功能更新。再次运行安装命令会备份并替换两组件；Git 工作区有修改或目标是 ZIP/本地复制安装时，默认拒绝覆盖。确认需要更新后加：

```sh
sh ./install.sh --host "$HOME/SillyTavern" --replace-modified
```

该参数依然保留完整备份，不会合并本地修改。宿主的 `enableServerPluginsAutoUpdate` 不会被改变；若指定固定标签或希望严格固定版本，请自行检查宿主自动更新设置。

安装器会扫描全局目录及 `dataRoot/<用户>/extensions`。发现已有同名或已知 PayGo 身份的其他目录时停止，并显示冲突路径，避免用户级旧版遮蔽全局新版或开发副本被重复加载。请先备份并移走旧副本，再重试；安装器不迁移不同扩展目录对应的用户设置。

成功后重启宿主、刷新浏览器，确认 PayGo 面板显示后端已就绪。安装成功只代表文件和配置部署完成；账号可用性及真实 API 调用须在宿主内检查。

## 自定义配置与 Luker

| 参数 | 含义 |
| --- | --- |
| `--host PATH` | 宿主根目录；省略时优先当前目录及其最近宿主祖先，再寻找 HOME 的 SillyTavern/Luker 与安装器祖先中的唯一有效宿主 |
| `--config PATH` | 本次宿主启动使用的配置；相对路径按宿主根目录解析 |
| `--data-root PATH` | 宿主启动参数覆盖后的数据目录，优先于配置中的 `dataRoot`，用于检查重复扩展 |
| `--plugins-path PATH` | Luker 启动参数覆盖后的服务端插件目录 |
| `--extensions-path PATH` | Luker 启动参数覆盖后的全局扩展目录 |
| `--help` | 显示完整参数 |

Luker 默认读取配置中的 `serverPluginsPath` 和 `globalExtensionsPath`；如果启动时还用了覆盖参数，安装时必须提供对应路径。安装器不修改这些目录配置。SillyTavern 使用其标准插件目录。

当前版本要求**配置文件和插件目标位于宿主根目录内**，并拒绝目标路径中的软链接/junction；外置数据目录可用于只读重复检查。插件放在外部磁盘或外置配置的布局会明确报错，请使用手动安装。该边界使备份、暂存与替换留在同一宿主文件系统中。

## 备份与恢复

每次实际安装创建 `<宿主>/.paygo-install-backups/<时间戳-随机后缀>/`：

- `config.yaml`：安装前的配置原文（之前不存在则没有此文件）。
- `ST-Vertex-PayGo/`、`ST-Vertex-PayGo-Server/`：安装前的完整插件目录（首次安装则没有）。
- `restore.json`：原配置路径、插件目标及原先是否存在的记录。

正常捕获到的安装错误会自动回滚；断电、强制结束进程或回滚本身遇到权限/磁盘故障，可能需要人工恢复。先停止宿主，参考 `restore.json`，将当前两个目标移到临时位置，再把备份目录移回原目标，恢复原配置文件；原先不存在的组件不需恢复，原先没有配置时移走新建配置即可。不要把备份放回 `plugins/` 或扩展扫描目录，否则可能被当作额外插件加载。

`.paygo-install.lock` 阻止同一宿主的并发安装。意外中断后，仅在确认安装进程已结束并完成必要恢复后移除此目录，再重试。备份不自动清理，其中的配置可能包含私密信息，请按原宿主数据的权限管理。

## 验证

开发测试运行 `node --test test/install.test.mjs`。覆盖离线 Git 下载、带空格/中文路径、首次安装、备份更新、失败回滚、重复扩展、YAML 配置、Luker 自定义目录，以及将在线引导正文真正通过 stdin / Invoke-Expression 执行、下载失败、安装失败、无交互终端、正文截断和临时文件清理。测试用本地 Git 仓库替代远端，避免真实网络影响结果。跨平台 CI 配置见 `.github/workflows/installer.yml`。Android/Termux 真机运行需要单独验证，桌面测试不能代替真机测试。
