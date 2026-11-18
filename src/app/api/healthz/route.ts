import { connection } from "next/server";

const GIT_SHA_PATTERN = /^[0-9a-f]{7,40}$/i;

function readBuildSha(): string | undefined {
  const raw = process.env.RABET_BUILD_SHA;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!GIT_SHA_PATTERN.test(trimmed)) return undefined;
  return trimmed.toLowerCase();
}

/**
 * Container liveness probe (`GET /api/healthz`).
 *
 * Deliberately contacts neither Neon/PostgreSQL nor Telegram, and does not
 * inspect secrets or authentication state. Calling `connection()` opts out of
 * build-time Cache Components prerendering so every probe proves the live
 * Node.js HTTP server is accepting requests at runtime.
 */
export async function GET(): Promise<Response> {
  await connection();

  const sha = readBuildSha();
  const body = sha ? { status: "ok", sha } : { status: "ok" };

  return Response.json(body, {
    status: 200,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
