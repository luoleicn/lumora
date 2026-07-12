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
- **arXiv 支持**：按标题检索 arXiv、下载 PDF 并归档。
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
- **Rust 稳定版工具链**（用于 `tauri dev` 与原生打包）——通过 [rustup](https://rustup.rs) 安装
- **macOS**：安装 Xcode Command Line Tools（`xcode-select --install`），提供 C 工具链与 WebKit；`rusqlite` 使用 bundled 模式，**无需**单独安装 SQLite
- 无需 Docker，无需自建后端

> 当前阶段优先级：**macOS 优先，Linux 其次，iPhone 最后**。目前主力开发与验证在 macOS。

## 安装依赖

在仓库根目录执行（会安装所有 workspace 的依赖）：

```bash
npm install
```

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

## 编译打包（macOS）

构建原生 macOS 应用：

```bash
npm run tauri:build --workspace @lumora/desktop
```

产物位于：

```
apps/desktop/src-tauri/target/release/bundle/macos/lumora.app
```

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
- 本项目目标是跨平台产品，路线：macOS → Linux → iPhone；iPhone 目前仅体现为 Tauri 兼容的前端架构，尚无移动端构建。


