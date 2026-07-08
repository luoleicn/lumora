# AGENTS.md

## Project Priorities

- Keep the architecture coherent as features are added. Prefer scoped modules, clear ownership boundaries, and reusable domain logic over one-off UI fixes.
- This project is intended to become a cross-platform product. Prioritize macOS first, Linux second, and iPhone last; the current phase is macOS.
- Maintain meaningful test coverage for behavior changes, especially shared logic, data integrity, sync, annotation, and cross-platform integration paths.

## Verification

- After code or project changes, run the macOS desktop build:

```bash
npm run tauri:build --workspace @lumora/desktop
```
