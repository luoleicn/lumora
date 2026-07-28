# AGENTS.md

## Project Priorities

- Keep the architecture coherent as features are added. Prefer scoped modules, clear ownership boundaries, and reusable domain logic over one-off UI fixes.
- macOS and Linux are the primary product platforms and must be maintained together across features, architecture, verification, and releases. iPhone is a later platform.
- Maintain meaningful test coverage for behavior changes, especially shared logic, data integrity, sync, annotation, and cross-platform integration paths.

## Verification

- After code or project changes, run the desktop build for the current host platform. When changes affect platform-specific behavior, also verify the other primary platform when a compatible environment is available, and report any verification that could not be run.

On macOS:

```bash
npm run tauri:build --workspace @lumora/desktop
```

On Linux:

```bash
npm run tauri:build:linux --workspace @lumora/desktop
```
