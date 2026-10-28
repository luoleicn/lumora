[简体中文](README.zh-CN.md)

# lumora — Desktop Research Literature Manager

Named after Lumos + Aurora, lumora is a **local-first** desktop literature manager with PDF import, highlights and annotations, collections, private cloud sync, and Mendeley migration. Your data stays on your computer by default. Cloud sync connects directly to **your own private object storage**, with no intermediary server or third-party cloud database.

## Project Links

- Project website (GitHub Pages): <https://luoleicn.github.io/lumora/>
- Source code: <https://github.com/luoleicn/lumora>

## Features

- **Modern library interface**: A collection sidebar, document list, and PDF reading workspace, with multiple reading tabs.
- **PDF import and local storage**: Metadata lives in native SQLite. PDFs are saved to your chosen directory using configurable filename templates (File Storage Settings), with that directory as the source of truth.
- **PDF annotations**: Select text to create highlights and notes using normalized rectangle coordinates, **without modifying the original PDF**.
- **Collections and organization**: Nested collections, favorites, and smart views for unfiled papers, missing PDFs, missing arXiv links, and trash, with search scoped to folders.
- **Find in Document and library search**: `Cmd/Ctrl+F` focuses library search on the Documents page and document search in a paper tab.
- **Private cloud sync**: A native Tauri sync engine connects directly to each user's own **private Qiniu Kodo bucket**, with incremental sync and content-addressed storage. arXiv PDFs are reconstructed from pinned versions without uploading duplicate files.
- **arXiv support**: Import by arXiv ID or URL with automatic PDF downloads, or search arXiv by title.
- **Mendeley import**: Connect through OAuth to incrementally sync document metadata, folders, and attachments.
- **Native macOS integration**: Native menus and keyboard shortcuts, plus two-finger trackpad zoom for PDFs (`allowsMagnification`).

## Technology Stack

- **Desktop shell**: Tauri v2 (Rust)
- **Frontend**: React 19 + TypeScript + Vite 7, with `pdfjs-dist` / `react-pdf` for PDF rendering
- **Local storage**: Native SQLite (`rusqlite`, bundled) and files on disk
- **Cloud sync**: Qiniu Kodo (`qiniu-sdk`), with credentials stored in the system keychain (`keyring`)
- **Shared domain logic**: `@lumora/shared` (entities, geometry, and sync protocol)

The codebase is an npm workspaces monorepo:

```
apps/desktop        # Tauri + React desktop application
  └─ src-tauri      # Native Rust layer (storage / sync / menus / shortcuts)
packages/shared     # Shared types and domain logic across platforms
docs                # Project website and sync protocol documentation
```

## Prerequisites

- **Node.js ≥ 22**
- **npm ≥ 11**
- **Git** (to clone the repository)
- **Stable Rust toolchain** (for `tauri dev` and native packaging) — install with [rustup](https://rustup.rs)
- **macOS**: Install Xcode Command Line Tools (`xcode-select --install`) for the C toolchain and WebKit. `rusqlite` uses bundled SQLite, so **no separate SQLite installation is required**.
- **Ubuntu / Debian**: Install WebKitGTK and GTK development libraries, Secret Service support for credential storage, and packaging tools. `rusqlite` uses bundled SQLite, so **no separate SQLite installation is required**:

  ```bash
  sudo apt update
  sudo apt install -y \
    libwebkit2gtk-4.1-dev libgtk-3-dev libsecret-1-dev librsvg2-dev \
    build-essential pkg-config libdbus-1-dev libssl-dev patchelf file curl wget \
    libxdo-dev libayatana-appindicator3-dev poppler-utils
  ```

  > `libsecret`, together with a Secret Service backend such as GNOME Keyring or KWallet, securely stores cloud sync credentials. Credential reads and writes fail if the desktop session has no running Secret Service.

  `poppler-utils` provides commands such as `pdfinfo` and `pdftotext` for native PDF reading. It is also required for local development and when running the binary directly.
- **Windows**: Windows 10/11 x64 is recommended. Install [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with **Desktop development with C++**, including the MSVC compiler and Windows SDK, and install [Microsoft Edge WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/). Use the MSVC Rust toolchain:

  ```powershell
  rustup default stable-msvc
  ```

  Reopen your terminal after installation. Building an MSI also requires the Windows VBSCRIPT optional feature. If you encounter `failed to run light.exe`, check that feature using the [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows).
- No Docker or self-hosted backend is required.

> **macOS and Linux desktop** are the primary product platforms at this stage. Features, architecture, and release quality are maintained together on both platforms. iPhone support is planned for a later stage.

## Install Dependencies

Clone the repository and install dependencies for all workspaces from the repository root. These commands work in macOS and Linux terminals and Windows PowerShell:

```bash
git clone https://github.com/luoleicn/lumora.git
cd lumora
npm ci
```

If you already have the source code, run `npm ci` from the repository root. Use `npm install` when adding or updating dependencies during development.

Cargo downloads Rust dependencies automatically on the first `tauri dev` or `tauri build`; no manual installation is needed.

## Development

Run only the frontend in a browser with Vite for quick UI work:

```bash
npm run dev:desktop
# Open the Vite URL shown in the terminal.
```

Run the native desktop application with full functionality (requires Rust):

```bash
npm run tauri:dev --workspace @lumora/desktop
```

## Build Desktop Executables

Complete the prerequisites and dependency installation first. Run all commands below from the **repository root**. They use release mode by default and build the shared package, frontend, and native Rust application automatically. There is no need to start a separate Vite server or run `npm run build` first. The first build needs network access to download Cargo dependencies and platform packaging tools, and may take longer.

| Target platform | Build host | Build command | Main output |
| --- | --- | --- | --- |
| macOS | macOS | `npm run tauri:build --workspace @lumora/desktop` | `lumora.app` |
| Linux | Linux (Ubuntu / Debian) | `npm run tauri:build:linux --workspace @lumora/desktop` | `.deb`, `.AppImage`, `lumora` binary |
| Windows | Windows (PowerShell) | `npm run tauri:build:windows --workspace @lumora/desktop` | `.msi`, `-setup.exe`, `lumora.exe` |

These steps use each platform's native build environment. Adding a Rust target on macOS alone is not enough to produce Linux or Windows distribution packages. The repository's [Release workflow](.github/workflows/release.yml) also uses separate runners for all three operating systems.

### macOS (Apple Silicon / Intel)

Build the application for your current Mac architecture:

```bash
npm run tauri:build --workspace @lumora/desktop
```

Launch the resulting application:

```bash
open apps/desktop/src-tauri/target/release/bundle/macos/lumora.app
```

You can copy the entire `lumora.app` to `/Applications`. The executable is at `lumora.app/Contents/MacOS/lumora`; keep the complete `.app` directory when distributing it. The default build produces arm64 on Apple Silicon and x86_64 on Intel.

To build a Universal application supporting both architectures on one Mac:

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri:build --workspace @lumora/desktop -- --target universal-apple-darwin
open apps/desktop/src-tauri/target/universal-apple-darwin/release/bundle/macos/lumora.app
```

To create a local DMG installer image, specify the bundle formats directly:

```bash
npm exec --workspace @lumora/desktop -- tauri build --bundles app,dmg
```

The DMG is saved to `apps/desktop/src-tauri/target/release/bundle/dmg/`. Ordinary local builds do not need an updater signing key. For Apple signing and notarization requirements when distributing to other users, see [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/).

### Linux (Ubuntu / Debian)

After installing the Linux system dependencies, build on Linux to produce `.deb` and `.AppImage` distribution packages:

```bash
npm run tauri:build:linux --workspace @lumora/desktop
```

> `tauri:build` (used on macOS) specifies `--bundles app`, and `app` is not a valid Linux bundle type. Linux therefore uses the separate `tauri:build:linux` script (`--bundles deb,appimage`).

The Linux build checks system development libraries and packaging tools before compiling. If it reports missing dependencies, run the Ubuntu / Debian installation command under **Prerequisites** and retry. Linker errors such as `unable to find library -lgtk-3` or `-lwebkit2gtk-4.1` also indicate missing development packages; runtime libraries and cached Cargo artifacts are not enough.

If AppImage packaging reports `failed to run linuxdeploy`, rerun with `-- --verbose` to see the underlying error. The packaging tool may need to download an AppImage runtime from GitHub. If that download fails, download the matching architecture from the [official runtime releases](https://github.com/AppImage/type2-runtime/releases) and set `LDAI_RUNTIME_FILE=/absolute/path/to/runtime` when running the build; this is a [supported packaging option](https://github.com/linuxdeploy/linuxdeploy-plugin-appimage#optional-variables).

The build targets the current machine's architecture by default. The following paths use x86_64 / amd64 as an example; the actual version and architecture in filenames depend on the build output:

```text
apps/desktop/src-tauri/target/release/lumora
apps/desktop/src-tauri/target/release/bundle/deb/lumora_<version>_amd64.deb
apps/desktop/src-tauri/target/release/bundle/appimage/lumora_<version>_amd64.AppImage
```

Install and run:

```bash
sudo apt install ./apps/desktop/src-tauri/target/release/bundle/deb/lumora_*_amd64.deb
lumora

# Or run the AppImage directly (requires executable permission).
chmod +x apps/desktop/src-tauri/target/release/bundle/appimage/lumora_*_amd64.AppImage
./apps/desktop/src-tauri/target/release/bundle/appimage/lumora_*_amd64.AppImage
```

You can also run `./apps/desktop/src-tauri/target/release/lumora` directly in a desktop session with the runtime dependencies above installed. Prefer an installer package or AppImage for distribution to other machines.

Linux package compatibility depends on system libraries such as glibc on the build host. To support older systems, build on the oldest system in your target range that provides WebKitGTK 4.1. The current Release workflow uses Ubuntu 22.04; see [Tauri AppImage limitations](https://v2.tauri.app/distribute/appimage/#limitations).

### Windows (x64)

Run in Windows PowerShell after setting up MSVC, the Windows SDK, WebView2, and Rust:

```powershell
npm run tauri:build:windows --workspace @lumora/desktop
```

By default, the build uses the target architecture of the current Rust toolchain. For x64 builds, outputs are located at:

```text
apps/desktop/src-tauri/target/release/lumora.exe
apps/desktop/src-tauri/target/release/bundle/msi/*.msi
apps/desktop/src-tauri/target/release/bundle/nsis/*-setup.exe
```

Double-click the MSI or `-setup.exe` to install. You can also launch the compiled executable directly on the build machine:

```powershell
.\apps\desktop\src-tauri\target\release\lumora.exe
```

Running directly still requires WebView2 on the system. Tauri downloads the relevant packaging tools when creating MSI/NSIS installers. MSI builds must run on Windows. See [Tauri Windows Installer](https://v2.tauri.app/distribute/windows-installer/) for more packaging options.

### Build Only the Binary

Run the following command on the corresponding platform to skip `.app`, `.deb`, `.AppImage`, MSI, and NSIS packaging. It still builds the frontend and embeds it in the desktop executable:

```bash
npm exec --workspace @lumora/desktop -- tauri build --no-bundle
```

The output is `apps/desktop/src-tauri/target/release/lumora` on macOS / Linux, or `lumora.exe` on Windows. The same platform runtime dependencies apply. A complete `.app` is recommended for everyday use and distribution on macOS.

These paths assume the default Cargo output directory. Passing `--target <triple>` moves outputs under `apps/desktop/src-tauri/target/<triple>/release/`. If `CARGO_TARGET_DIR` is set, use that directory and the build logs as the reference.

### Releases and Automatic Updates

Ordinary local builds do not require a GitHub token or `TAURI_SIGNING_PRIVATE_KEY`. Official releases use the [Release workflow](.github/workflows/release.yml), [macOS release script](scripts/release-macos.sh), or [Linux release script](scripts/release-linux.sh), and require an updater signing key. See [docs/updater-release.md](docs/updater-release.md) for signing and automatic update configuration. Release scripts push version tags and create GitHub Releases by default, so they should not be used as ordinary local build commands.

## Configure Cloud Sync

1. Create a **private** Qiniu Kodo bucket dedicated to your library.
2. In the application's Sync panel, enter the bucket's Access Key, Secret Key, name, region, and private download domain.
3. The Secret Key is stored only in the **operating system keychain**, never in browser storage or SQLite.
4. Each bucket hosts one library, with data under the `lumora/v1/` prefix.

See [docs/qiniu-sync.md](docs/qiniu-sync.md) for protocol, recovery, and security details.

## Mendeley Import

Authorize through OAuth in the Mendeley Sync menu to incrementally sync metadata, folders, and attachments. See [docs/mendeley-sync.md](docs/mendeley-sync.md) for coverage and pagination / media type details.

## Development Checks

Run these checks before submitting changes:

```bash
npm run typecheck
npm test
npm run build
```

For Rust, you can also run:

```bash
cd apps/desktop/src-tauri && cargo check
```

## Development Guidelines

- Keep the architecture coherent as features evolve. Prefer **reusable domain modules with clear boundaries** over one-off UI patches.
- Maintain meaningful test coverage for behavior changes, especially shared logic, data integrity, sync, annotations, and cross-platform integration.
- lumora is a cross-platform product, with macOS and Linux as the primary platforms and iPhone planned for later. iPhone support currently consists of a Tauri-compatible frontend architecture; no mobile build is available yet.
