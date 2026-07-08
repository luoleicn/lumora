# lumora

lumora — light up your literature.

lumora combines Lumos and Aurora: a quiet desktop research library that feels like an aurora lighting up knowledge. It is a local-first literature reading app with PDF import, right-click highlights and notes, collection organization, cloud sync, and Mendeley import plumbing.

## What Is Implemented

- Desktop app scaffold: Tauri v2 + React + TypeScript + Vite.
- Modern library UI: collection sidebar, paper list, PDF reader workspace, right-click annotation flow, sync panel.
- PDF import: stores metadata in browser local storage and PDF blobs in IndexedDB for the MVP desktop/web runtime.
- PDF annotations: text selection creates normalized highlight/note rectangles without modifying the PDF.
- Sync API: Fastify server with login, push/pull sync, file upload/download signed URLs, Prisma/Postgres schema.
- Object storage: S3-compatible storage support via MinIO.
- Mendeley: OAuth connection route and metadata/folder import service skeleton.
- Deployment: Docker Compose for Postgres, MinIO, and the API server.

## Requirements

- Node.js 22+
- npm 11+
- Rust stable toolchain for `tauri dev` / native desktop builds
- Docker for the self-hosted backend stack

This workspace has been verified with Node/npm, Rust stable, Docker, and Docker Compose available.

## Install

```bash
npm install
npm run prisma:generate
```

## Run The Desktop UI

```bash
npm run dev:desktop
```

Open the Vite URL shown in the terminal. In a Rust-ready environment, run the native shell:

```bash
npm run tauri:dev --workspace @lumora/desktop
```

Build the native macOS app bundle:

```bash
npm run tauri:build --workspace @lumora/desktop
```

The app bundle is written to `apps/desktop/src-tauri/target/release/bundle/macos/lumora.app`.

## Run The Backend

Start infrastructure:

```bash
docker compose -f infra/docker-compose.yml up --build
```

Default login:

- Email: `reader@example.com`
- Password: `change-me`

For production or long-running personal use, change `JWT_SECRET`, `LUMORA_BOOTSTRAP_PASSWORD`, and S3 credentials in environment variables.

If browser uploads to MinIO are blocked by CORS, apply `infra/minio-cors.json` to the `lumora` bucket with the MinIO client.

## Development Checks

```bash
npm run typecheck
npm test
npm run build
```

## Development Notes

- Keep the architecture coherent as features are added; prefer scoped modules, clear ownership boundaries, and reusable domain logic over one-off UI fixes.
- This project is intended to become a cross-platform product. Prioritize macOS first, Linux second, and iPhone last; the current phase is macOS.
- Maintain meaningful test coverage for behavior changes, especially shared logic, data integrity, sync, annotation, and cross-platform integration paths.

Verified in this workspace:

- `npm run typecheck`
- `npm test`
- `npm run build`
- `cargo check` in `apps/desktop/src-tauri`
- `npm run tauri:build --workspace @lumora/desktop`

## Current MVP Limits

- Local desktop persistence uses localStorage + IndexedDB while the Tauri-native SQLite/file-system layer is still to be added.
- Sync currently pushes the full local library state each time; a local change-log queue should replace this before large libraries.
- Mendeley import currently imports metadata and folders. PDF attachment download and annotation migration need provider-specific hardening.
- Conflict handling is last-write-wins at record level.
- The iPhone target is represented by the Tauri-compatible frontend architecture, not a built mobile app yet.
