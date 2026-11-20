import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";

/**
 * A minimal Neon HTTP endpoint in front of a real PostgreSQL database.
 *
 * The application's production client is `drizzle-orm/neon-http`, which talks
 * to Neon over HTTP rather than a PostgreSQL socket. That means an integration
 * test cannot point `DATABASE_URL` at a plain local PostgreSQL service: the
 * driver would try to POST SQL to the database host.
 *
 * This helper starts a loopback HTTP server that accepts the driver's
 * `{query, params}` / `{queries: [...]}` payloads, executes them through
 * `postgres`, and returns the rows/fields shape the driver expects. The
 * spawned Next.js server gets `NODE_OPTIONS=--import <preload>` so its
 * `fetch` calls for a synthetic `*.neon.tech` host are redirected to this
 * server. No real Neon endpoint or credential is involved.
 *
 * The database URL handed back is deliberately synthetic and loopback-only in
 * effect; the preload forwards it to this process.
 */

const SYNTHETIC_HOST = "ep-rabet-integration-test.neon.tech";

export type NeonHttpBridge = {
  /** Synthetic `DATABASE_URL` for the spawned application server. */
  url: string;
  /** Preload module that redirects the synthetic host's fetch calls here. */
  preloadPath: string;
  close(): Promise<void>;
};

type ExecuteOnePayload = {
  query?: string;
  params?: unknown[];
};

type QueryResult = {
  rows: unknown[][];
  fields: Array<{ name: string; dataTypeID: number }>;
};

/**
 * Neon's HTTP protocol returns text-format values. In particular its boolean
 * parser accepts `"t"`/`"f"`, not JSON `true`/`false`, so the bridge formats
 * values exactly as the real endpoint does before handing them to the driver.
 */
function formatValue(value: unknown): unknown {
  if (typeof value === "boolean") return value ? "t" : "f";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return `{${value.map((entry) => JSON.stringify(String(entry))).join(",")}}`;
  }
  if (typeof value === "object" && value !== null) {
    return JSON.stringify(value);
  }
  return value;
}

export async function startNeonHttpBridge(
  databaseUrl: string,
): Promise<NeonHttpBridge> {
  const sql = postgres(databaseUrl, { max: 4 });

  const executeOne = async (
    payload: ExecuteOnePayload,
  ): Promise<QueryResult> => {
    // `.values()` keeps one value per selected column position. A row object
    // would collapse duplicate column names (for example `product.id` and
    // `product_translation.id`) into one key, which corrupts joined catalog
    // reads before Drizzle ever sees them.
    const rows = await sql
      .unsafe(payload.query ?? "", payload.params ?? [])
      .values();
    const columns = rows.columns ?? [];

    return {
      rows: rows.map((row) => row.map((value) => formatValue(value))) as unknown[][],
      fields: columns.map((column) => ({
        name: column.name,
        dataTypeID: column.type,
      })),
    };
  };

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];

    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (!request.url?.startsWith("/neon-sql")) {
        response.writeHead(404);
        response.end("not found");
        return;
      }

      void (async () => {
        try {
          const payload = JSON.parse(
            Buffer.concat(chunks).toString("utf8"),
          ) as ExecuteOnePayload | { queries?: ExecuteOnePayload[] };

          const body =
            "queries" in payload && Array.isArray(payload.queries)
              ? {
                  results: await Promise.all(
                    payload.queries.map((entry) => executeOne(entry)),
                  ),
                }
              : await executeOne(payload as ExecuteOnePayload);

          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify(body));
        } catch (error) {
          response.writeHead(500, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              message: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      })();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    await sql.end();
    throw new Error("Neon HTTP bridge did not bind a TCP port.");
  }

  const bridgeBase = `http://127.0.0.1:${address.port}`;
  const tempDir = mkdtempSync(path.join(tmpdir(), "rabet-neon-bridge-"));
  const preloadPath = path.join(tempDir, "preload.mjs");

  writeFileSync(
    preloadPath,
    [
      "const originalFetch = globalThis.fetch;",
      `const hostBase = ${JSON.stringify(bridgeBase)};`,
      `const syntheticHost = ${JSON.stringify(SYNTHETIC_HOST)};`,
      "globalThis.fetch = async (input, init) => {",
      "  const url = typeof input === 'string' ? input : (input?.url ?? String(input));",
      "  const headers = init?.headers ?? {};",
      "  const connectionString =",
      "    typeof headers.get === 'function'",
      "      ? (headers.get('Neon-Connection-String') ?? headers.get('neon-connection-string') ?? '')",
      "      : (headers['Neon-Connection-String'] ?? headers['neon-connection-string'] ?? '');",
      "  if (url.includes(syntheticHost) || String(connectionString).includes(syntheticHost)) {",
      "    return originalFetch(hostBase + '/neon-sql', {",
      "      method: 'POST',",
      "      headers: { 'content-type': 'application/json' },",
      "      body: init?.body,",
      "    });",
      "  }",
      "  return originalFetch(input, init);",
      "};",
    ].join("\n"),
    { mode: 0o644 },
  );

  return {
    url: `postgresql://rabet:rabet@${SYNTHETIC_HOST}/rabet_integration?sslmode=require`,
    preloadPath,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await sql.end();
      rmSync(tempDir, { recursive: true, force: true });
    },
  };
}
