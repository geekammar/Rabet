import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      // Mirror the `@/*` -> `./src/*` alias from tsconfig.json so tests import
      // application modules with the same specifiers the app uses.
      "@": path.resolve(dirname, "./src"),
      // `server-only` is a build-time guard that throws when a server module
      // reaches a client bundle. Under Vitest there is no bundler boundary to
      // enforce, so it is stubbed to a no-op to let the modules load.
      "server-only": path.resolve(dirname, "./tests/stubs/server-only.ts"),
    },
  },
  test: {
    // The auth modules read process.env (ADMIN_EMAIL, ADMIN_PASSWORD_HASH,
    // AUTH_SECRET). Tests set synthetic values per-case via vi.stubEnv and need
    // isolation so a change in one file cannot leak into another.
    isolate: true,
    environment: "node",
    include: ["src/**/__tests__/**/*.test.ts", "tests/**/*.test.ts"],
    setupFiles: ["./tests/setup.ts"],
  },
});
