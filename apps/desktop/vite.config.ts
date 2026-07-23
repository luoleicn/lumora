import { execSync } from "node:child_process";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

function gitCommitHash(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    __LUMORA_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __LUMORA_GIT_COMMIT__: JSON.stringify(gitCommitHash())
  },
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false
  },
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      all: true,
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/main.tsx", "src/**/*.d.ts", "src/**/*.test.{ts,tsx}"],
      // Ratchet baselines: set just below current real coverage so the gate is
      // green today and can only be raised as tests are added — never lowered.
      // Global floor covers the whole project (components/App.tsx are still
      // untested); the src/lib/** glob holds the pure-logic layer to a higher
      // bar. Raise these as coverage improves.
      thresholds: {
        statements: 15,
        lines: 15,
        functions: 45,
        branches: 68,
        "src/lib/**": {
          statements: 45,
          lines: 45,
          functions: 50,
          branches: 70
        }
      }
    }
  }
});
