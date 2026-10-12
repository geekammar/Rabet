import { readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit configuration.
 *
 * - **Generate** (`npm run db:generate`) is offline: it reads the TypeScript
 *   schema in `src/db/schema` and writes version-controlled SQL plus the
 *   journal and snapshot metadata to `drizzle/`. It never touches a database.
 * - **Migrate** (`npm run db:migrate`) requires `DATABASE_URL` and applies the
 *   committed chain through the journal. Run it only against a development or
 *   throwaway database; a production migration is run by hand from the
 *   development VPS against the **unpooled** connection after a manual
 *   snapshot. It is never run from a Vercel build, at application startup or
 *   by a deploy hook, and `drizzle-kit push` is not wired into any script or
 *   CI step (DATA_MODEL.md §17.3).
 *
 * Local values are read from `.env.local` — the same file Next.js loads and
 * the one `.env.example` tells you to copy — so `npm run db:migrate` works
 * locally without exporting anything. Values already in the environment win,
 * and real values are never committed (`.env*` is git-ignored).
 */

/**
 * Reads `KEY=value` pairs from a local env file, applying only keys that are
 * not already set in the environment. No dependency, no interpolation — the
 * same shape as a shell export, and it never overrides a CI-provided value.
 */
function loadLocalEnv(file: string): void {
  let contents: string;

  try {
    contents = readFileSync(path.resolve(process.cwd(), file), "utf8");
  } catch {
    // Missing file is not an error: the environment may already carry the
    // value (CI, or an exported variable on the VPS).
    return;
  }

  for (const line of contents.split("\n")) {
    const trimmed = line.trim();

    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const equals = trimmed.indexOf("=");

    if (equals === -1) continue;

    const key = trimmed.slice(0, equals).trim();

    if (process.env[key] !== undefined) continue;

    process.env[key] = trimmed
      .slice(equals + 1)
      .trim()
      // Tolerate optional surrounding quotes, the way a shell would. Written
      // with a `[\s\S]` class rather than the `s` (dotAll) flag so the file
      // type-checks under the project's ES2017 `target` (the flag needs ES2018).
      .replace(/^"([\s\S]*)"$/, "$1");
  }
}

loadLocalEnv(".env.local");
loadLocalEnv(".env");

const url = process.env.DATABASE_URL;

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/*",
  out: "./drizzle",
  // `generate` ignores this; `migrate` fails loudly when it is missing.
  dbCredentials: url ? { url } : { url: "" },
  verbose: true,
  strict: true,
});
