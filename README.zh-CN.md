[English](README.md)

# lumora — 桌面研究文献管理

lumora 取意 Lumos + Aurora，是一款**本地优先（local-first）**的桌面文献管理应用，支持 PDF 导入、高亮批注、文献集合管理、私有云同步与 Mendeley 数据迁移。数据默认全部留在你自己的电脑上，云同步直连**你自己的私有对象存储**，没有中间服务器，也没有第三方云数据库。

## 项目网站

- 项目主页（GitHub Pages）：<https://luoleicn.github.io/lumora/>
- 源码仓库：<https://github.com/luoleicn/lumora>

## 功能特性

- **现代文献库界面**：左侧集合侧边栏、中间文献列表、右侧 PDF 阅读工作区，多标签页并行阅读。
- **PDF 导入与本地存储**：元数据存入原生 SQLite，PDF 文件按可配置的命名模板落盘到你指定的目录（File Storage Settings），目录即事实来源。
- **PDF 批注**：选中文本即可创建高亮/笔记，采用归一化坐标矩形，**不修改原始 PDF**。
- **集合与整理**：多级集合、收藏、未分类、无 PDF、无 arXiv、回收站等智能视图，支持文件夹范围内检索。
- **文献内检索（Find in Document）** 与 **库内检索**：`Cmd/Ctrl+F` 在 Documents 页聚焦库检索、在论文标签页聚焦文献内查找。
- **私有云同步**：原生 Tauri 同步引擎，直连每个用户自己的**七牛 Kodo（Qiniu）私有存储桶**；增量同步、内容寻址存储；arXiv PDF 按锁定版本号重建，无需重复上传。
- **arXiv 支持**：通过 arXiv ID 或链接导入并自动下载 PDF，也可按标题检索 arXiv。
- **Mendeley 导入**：OAuth 授权连接，增量同步文献元数据、文件夹与附件。
- **macOS 原生集成**：原生菜单与快捷键、触控板双指缩放 PDF（`allowsMagnification`）等。

## 技术栈

- **桌面外壳**：Tauri v2（Rust）
- **前端**：React 19 + TypeScript + Vite 7，PDF 渲染用 `pdfjs-dist` / `react-pdf`
- **本地存储**：原生 SQLite（`rusqlite`，bundled）+ 文件系统落盘
- **云同步**：七牛 Kodo（`qiniu-sdk`），密钥通过系统钥匙串（`keyring`）保存
- **共享领域逻辑**：`@lumora/shared`（实体、几何、同步协议）

代码组织为 npm workspaces monorepo：

```
apps/desktop        # Tauri + React 桌面应用
  └─ src-tauri      # Rust 原生层（存储 / 同步 / 菜单 / 快捷键）
packages/shared     # 跨端共享的类型与领域逻辑
docs                # 项目主页与同步协议文档
```

## 环境要求

- **Node.js ≥ 22**
- **npm ≥ 11**
- **Git**（获取源码）
- **Rust 稳定版工具链**（用于 `tauri dev` 与原生打包）——通过 [rustup](https://rustup.rs) 安装
- **macOS**：安装 Xcode Command Line Tools（`xcode-select --install`），提供 C 工具链与 WebKit；`rusqlite` 使用 bundled 模式，**无需**单独安装 SQLite
- **Ubuntu / Debian**：安装 WebKitGTK 与 GTK 开发库、Secret Service（密钥存储）以及打包工具。`rusqlite` 使用 bundled 模式，**无需**单独安装 SQLite：

  ```bash
  sudo apt update
  sudo apt install -y \
    libwebkit2gtk-4.1-dev libgtk-3-dev libsecret-1-dev librsvg2-dev \
    build-essential pkg-config libdbus-1-dev libssl-dev patchelf file curl wget \
    libxdo-dev libayatana-appindicator3-dev poppler-utils
  ```

  > `libsecret`（配合 GNOME Keyring / KWallet 等 Secret Service 后端）用于安全保存云同步密钥；桌面会话未运行 Secret Service 时，密钥读写会失败。

  `poppler-utils` 提供原生 PDF 阅读使用的 `pdfinfo`、`pdftotext` 等命令；本地开发和直接运行二进制时也需要安装。
- **Windows**：建议使用 Windows 10/11 x64，安装 [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)，勾选 **Desktop development with C++（使用 C++ 的桌面开发）**，包含 MSVC 编译器和 Windows SDK；同时安装 [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。Rust 使用 MSVC 工具链：

  ```powershell
  rustup default stable-msvc
  ```

  安装完成后重新打开终端。生成 MSI 还需要启用 Windows 的 VBSCRIPT 可选功能；遇到 `failed to run light.exe` 时，按 [Tauri Windows 环境说明](https://v2.tauri.app/start/prerequisites/#windows) 检查该功能。
- 无需 Docker，无需自建后端

> 当前阶段的主力产品是 **macOS 与 Linux 桌面端**，两端的功能、架构与发布质量需要共同维护；iPhone 作为后续平台推进。

## 安装依赖

获取源码并在仓库根目录安装所有 workspace 的依赖（macOS、Linux 终端和 Windows PowerShell 均可执行）：

```bash
git clone https://github.com/luoleicn/lumora.git
cd lumora
npm ci
```

已有源码时直接进入仓库根目录执行 `npm ci`。日常新增或调整依赖时使用 `npm install`。

Rust 侧依赖会在首次 `tauri dev` / `tauri build` 时由 Cargo 自动拉取，无需手动安装。

## 开发运行

仅前端（浏览器里跑 Vite，快速调 UI）：

```bash
npm run dev:desktop
# 打开终端里显示的 Vite 地址
```

原生桌面外壳（需要 Rust 环境，功能完整）：

```bash
npm run tauri:dev --workspace @lumora/desktop
```

## 编译桌面可执行程序

先完成上面的环境准备和依赖安装。以下构建命令均在**仓库根目录**执行，默认使用 release 模式，并自动构建共享包、前端和 Rust 原生程序；无需另开 Vite 服务或事先执行 `npm run build`。首次构建需要联网下载 Cargo 依赖及平台打包工具，耗时较长。

| 目标平台 | 构建所在系统 | 构建命令 | 主要产物 |
| --- | --- | --- | --- |
| macOS | macOS | `npm run tauri:build --workspace @lumora/desktop` | `lumora.app` |
| Linux | Linux（Ubuntu / Debian） | `npm run tauri:build:linux --workspace @lumora/desktop` | `.deb`、`.AppImage`、`lumora` 二进制 |
| Windows | Windows（PowerShell） | `npm run tauri:build:windows --workspace @lumora/desktop` | `.msi`、`-setup.exe`、`lumora.exe` |

这些步骤使用各平台的原生构建环境；仅在 macOS 上添加一个 Rust target 不足以生成 Linux / Windows 分发包。仓库的 [Release 工作流](.github/workflows/release.yml) 也分别使用三个系统的 runner。

### macOS（Apple Silicon / Intel）

构建当前 Mac 架构的应用：

```bash
npm run tauri:build --workspace @lumora/desktop
```

产物与启动命令：

```bash
open apps/desktop/src-tauri/target/release/bundle/macos/lumora.app
```

可以将整个 `lumora.app` 拷贝到 `/Applications`。包内可执行文件位于 `lumora.app/Contents/MacOS/lumora`，分发时保留完整 `.app` 目录。默认构建在 Apple Silicon 上生成 arm64，在 Intel 上生成 x86_64。

在同一台 Mac 上构建同时支持两种架构的 Universal 应用：

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri:build --workspace @lumora/desktop -- --target universal-apple-darwin
open apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos/lumora.app
```

如需本地 DMG 安装镜像，可直接指定打包格式：

```bash
npm exec --workspace @lumora/desktop -- tauri build --bundles app,dmg
```

DMG 位于 `apps/desktop/src-tauri/target/release/bundle/dmg/`。普通本地构建无需更新签名密钥；面向其他用户分发时的 Apple 签名与公证要求见 [Tauri macOS 签名说明](https://v2.tauri.app/distribute/sign/macos/)。

### Linux（Ubuntu / Debian）

完成 Linux 系统依赖安装后，在 Linux 上构建应用并生成 `.deb` 与 `.AppImage` 分发包：

```bash
npm run tauri:build:linux --workspace @lumora/desktop
```

> `tauri:build`（macOS 用）固定 `--bundles app`，而 `app` 不是 Linux 的有效包类型，故 Linux 单独用 `tauri:build:linux` 脚本（`--bundles deb,appimage`）。

Linux 构建会在编译前检查系统开发库和打包工具。若提示缺少依赖，执行**环境要求**中 Ubuntu / Debian 的安装命令后重试。`unable to find library -lgtk-3` 或 `-lwebkit2gtk-4.1` 等链接错误也说明缺少开发包；仅有运行时库和已有的 Cargo 编译缓存不足以完成构建。

若 AppImage 打包提示 `failed to run linuxdeploy`，追加 `-- --verbose` 重试以查看底层错误。打包工具可能需要从 GitHub 下载 AppImage 运行时；若下载失败，可从[官方运行时发布页](https://github.com/AppImage/type2-runtime/releases)下载匹配架构的文件，并在构建时设置 `LDAI_RUNTIME_FILE=/运行时文件的绝对路径`，这是打包工具[支持的配置项](https://github.com/linuxdeploy/linuxdeploy-plugin-appimage#optional-variables)。

默认面向当前机器架构。下面以 x86_64 / amd64 为例，实际文件名中的版本号、架构以构建输出为准：

```text
apps/desktop/src-tauri/target/release/lumora
apps/desktop/src-tauri/target/release/bundle/deb/lumora_<version>_amd64.deb
apps/desktop/src-tauri/target/release/bundle/appimage/lumora_<version>_amd64.AppImage
```

安装与运行：

```bash
sudo apt install ./apps/desktop/src-tauri/target/release/bundle/deb/lumora_*_amd64.deb
lumora

# 或直接运行 AppImage（需要可执行权限）
chmod +x apps/desktop/src-tauri/target/release/bundle/appimage/lumora_*_amd64.AppImage
./apps/desktop/src-tauri/target/release/bundle/appimage/lumora_*_amd64.AppImage
```

也可以在已安装上述运行依赖的桌面会话中直接执行 `./apps/desktop/src-tauri/target/release/lumora`。分发到其他机器时优先使用安装包或 AppImage。

Linux 包的兼容性受构建机 glibc 等系统库版本影响；需要兼容较老系统时，应在目标范围内最老、且提供 WebKitGTK 4.1 的系统上构建。当前 Release 工作流使用 Ubuntu 22.04，详见 [Tauri AppImage 兼容性说明](https://v2.tauri.app/distribute/appimage/#limitations)。

### Windows（x64）

在准备好 MSVC、Windows SDK、WebView2 和 Rust 的 Windows PowerShell 中执行：

```powershell
npm run tauri:build:windows --workspace @lumora/desktop
```

默认构建当前 Rust 工具链的目标架构。x64 构建的产物位于：

```text
apps/desktop/src-tauri/target/release/lumora.exe
apps/desktop/src-tauri/target/release/bundle/msi/*.msi
apps/desktop/src-tauri/target/release/bundle/nsis/*-setup.exe
```

双击 MSI 或 `-setup.exe` 安装；本机也可直接启动编译出的程序：

```powershell
.\apps\desktop\src-tauri\target\release\lumora.exe
```

直接运行仍需系统安装 WebView2。生成 MSI/NSIS 时，Tauri 会下载相应打包工具；MSI 构建须在 Windows 上进行。更多安装包选项见 [Tauri Windows Installer](https://v2.tauri.app/distribute/windows-installer/)。

### 只编译二进制，不生成安装包

在对应平台上执行以下命令，可以跳过 `.app` / `.deb` / `.AppImage` / MSI / NSIS 打包，但仍会构建前端并嵌入桌面程序：

```bash
npm exec --workspace @lumora/desktop -- tauri build --no-bundle
```

产物为 `apps/desktop/src-tauri/target/release/lumora`（macOS / Linux）或 `lumora.exe`（Windows）。运行依赖与上面对应平台相同；macOS 日常使用和分发推荐完整 `.app`。

以上路径按默认 Cargo 输出目录列出。显式传入 `--target <triple>` 时，产物改到 `apps/desktop/src-tauri/target/<triple>/release/` 下；设置了 `CARGO_TARGET_DIR` 时，以该目录及构建日志为准。

### 正式发布与自动更新

普通本地构建不需要 GitHub Token 或 `TAURI_SIGNING_PRIVATE_KEY`。正式发布使用 [Release 工作流](.github/workflows/release.yml) 或 [macOS 发布脚本](scripts/release-macos.sh)、[Linux 发布脚本](scripts/release-linux.sh)，需配置更新签名密钥；签名与自动更新配置见 [docs/updater-release.md](docs/updater-release.md)。发布脚本默认会推送版本标签并创建 GitHub Release，不能当作普通本地编译命令使用。

## 配置云同步

1. 在七牛云创建一个**私有** Kodo 存储桶专门给文献库使用。
2. 在应用的 Sync 面板填入该桶的 Access Key、Secret Key、桶名、区域（region）、以及私有下载域名。
3. Secret Key 只保存在**操作系统钥匙串**里，不会写入浏览器存储或 SQLite。
4. 每个桶托管一个库，数据位于 `lumora/v1/` 前缀下。

协议、恢复与安全细节见 [docs/qiniu-sync.md](docs/qiniu-sync.md)。

## Mendeley 导入

通过 Mendeley Sync 菜单进行 OAuth 授权后，增量同步元数据、文件夹与附件。覆盖范围与分页/媒体类型细节见 [docs/mendeley-sync.md](docs/mendeley-sync.md)。

## 开发校验

提交前建议跑通以下检查：

```bash
npm run typecheck
npm test
npm run build
```

Rust 侧可另行执行：

```bash
cd apps/desktop/src-tauri && cargo check
```

## 开发约定

- 随功能演进保持架构自洽：优先做**边界清晰、可复用的领域模块**，而不是一次性的 UI 补丁。
- 对行为变更保持有意义的测试覆盖，尤其是共享逻辑、数据完整性、同步、批注与跨端集成路径。
- 本项目目标是跨平台产品，当前主力平台为 macOS + Linux，后续扩展至 iPhone；iPhone 目前仅体现为 Tauri 兼容的前端架构，尚无移动端构建。
