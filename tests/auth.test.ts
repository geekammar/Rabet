/**
 * Integration tests for authentication, driven over HTTP against the real
 * production server (`next start`).
 *
 * These tests exercise the actual request path — proxy, route handler, login
 * server action, session cookie and redirect — rather than calling functions in
 * isolation. They are the tests that prove the security claims: that an
 * unauthenticated visitor cannot reach dashboard content, that logout truly
 * invalidates the session, and that protected responses are not cacheable.
 *
 * The server is started once for the whole file with a synthetic, test-only
 * configuration. No real production secret, password or hash is used, and none
 * is printed by these tests.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess, execSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { hash } from "@node-rs/argon2";
import { encode as encodeJwt } from "@auth/core/jwt";

// Configurable ports so CI and local runs (or two runs side by side) never
// fight over a fixed address. Defaults keep the historic 3210/3211 so an
// unconfigured `npm run test` behaves exactly as before.
const PORT = process.env.RABET_TEST_PORT ?? "3210";
const CLOSED_PORT = process.env.RABET_TEST_PORT_2 ?? "3211";
const BASE = `http://localhost:${PORT}`;

const TEST_EMAIL = "admin@example.test";
const TEST_PASSWORD = "integration-test-password-99";

type CookieJar = Record<string, string>;

let server: ChildProcess | null = null;

/**
 * Best-effort: kill anything *listening* on `port` so a leftover server from a
 * crashed run cannot keep the address exclusive. No-op when the port is free.
 *
 * Two properties matter here, and both have bitten this suite:
 *
 * 1. Only real listeners count. `lsof -i tcp:PORT` matches any socket whose
 *    local *or remote* port is `PORT` — and this test process makes outbound
 *    `fetch()` requests to the server, so it holds client sockets whose remote
 *    port is `PORT`. Matching those made `freePort` SIGKILL the vitest worker
 *    itself after the tests had run, which vitest reported as a suite failure.
 *    Both lookup strategies are therefore restricted to LISTEN-state sockets.
 *
 * 2. `lsof` is unreliable on some hosts for listeners whose process name
 *    contains a space or parenthesis (the Next.js server reports as
 *    `next-server (v16…)`), silently returning nothing and letting an orphan
 *    slip through. `ss` is the fallback for that case.
 */
function freePort(port: number): void {
  if (process.platform === "win32") return;
  const pids = new Set<number>();

  try {
    // `-sTCP:LISTEN` excludes this process's outbound client sockets.
    const out = execSync(
      `lsof -ti tcp:${port} -sTCP:LISTEN 2>/dev/null || true`,
      { encoding: "utf8" },
    );
    for (const pid of out.trim().split("\n").filter(Boolean)) {
      pids.add(Number(pid));
    }
  } catch {
    // `lsof` unavailable — fall through to `ss`.
  }

  if (pids.size === 0) {
    // `-l` lists listening sockets only. The line carries a trailing
    // `users:(("name",pid=1234,fd=5))` field; the local-address token
    // (`*:3210`, `127.0.0.1:3210`, `[::]:3210`) identifies the port, and a
    // longer port number is never confused with this one.
    try {
      const out = execSync("ss -ltnpH 2>/dev/null || true", {
        encoding: "utf8",
      });
      for (const line of out.split("\n")) {
        const isListener = line
          .split(/\s+/)
          .some((token) => token.endsWith(`:${port}`));
        if (!isListener) continue;
        const match = line.match(/pid=(\d+)/);
        if (match) pids.add(Number(match[1]));
      }
    } catch {
      // `ss` unavailable too — the spawn will surface EADDRINUSE.
    }
  }

  for (const pid of pids) {
    // Belt and braces: never signal the process running this suite, its
    // process group, or its parent (the vitest main process).
    if (pid === process.pid || pid === process.ppid) continue;
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process may already be gone.
    }
  }
}

/**
 * Kill a spawned server together with every descendant it launched, and wait
 * for the OS to reclaim it before returning.
 *
 * The servers are started as `bash -c "…; exec npx next start"`. `exec` keeps
 * the same PID, then `npx` forks a `sh` and a `next-server` grandchild — so
 * signalling only the spawned PID orphans the `next-server` process, which
 * keeps holding the port and makes the next test run die with EADDRINUSE.
 *
 * Spawning detached makes the child a process-group leader whose descendants
 * inherit the group, so one signal to the negative group ID reaches the whole
 * tree at once. The stdio streams are destroyed first so nothing in this
 * process is still reading from a process we are about to kill, and we then
 * wait for the child to actually be gone (the fallback timeout is only so a
 * wedged group can never hang the suite) before teardown proceeds.
 */
async function killTree(child: ChildProcess | null): Promise<void> {
  if (!child?.pid) return;
  try {
    child.stdout?.destroy();
  } catch {
    // Stream may already be closed.
  }
  try {
    child.stderr?.destroy();
  } catch {
    // Stream may already be closed.
  }
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    setTimeout(resolve, 2_000);
  });
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // The group may already have exited.
  }
  await exited;
}

/**
 * The temp directory holding the throwaway env files. Kept module-scoped so the
 * fail-closed test can write a second env file into the same directory, and so
 * `afterAll` can remove it on the way out (success *and* failure).
 */
const envDirRef = { dir: "" };

/**
 * Every server this file has spawned. `afterAll` walks this list so a server
 * started inside an individual test cannot outlive the suite even if that test
 * threw before reaching its own cleanup.
 */
const spawnedServers: Array<ChildProcess> = [];

/** Record a spawn and return it, so the suite-wide teardown can always find it. */
function track(child: ChildProcess): ChildProcess {
  spawnedServers.push(child);
  return child;
}

/**
 * The throwaway `AUTH_SECRET` the suite boots its server with. Recorded so the
 * expired-session test can mint a JWT against the same key the server verifies
 * with. It is generated per run, never written anywhere outside the temp env
 * file, and never printed.
 */
let testAuthSecret = "";

async function buildOnce(): Promise<void> {
  // Reuse the already-built .next output when present (the CI matrix builds
  // before testing), otherwise build it here.
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("npm", ["run", "build"], {
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    let output = "";
    proc.stdout?.on("data", (chunk) => (output += chunk));
    proc.stderr?.on("data", (chunk) => (output += chunk));
    proc.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`build failed: ${output}`)),
    );
  });
}

beforeAll(async () => {
  await buildOnce();

  // A previous crashed run can leave a server bound to the port. Try to free
  // it before starting a fresh one: `next start` binds exclusively, so an
  // EADDRINUSE here would fail the whole suite.
  await freePort(Number(PORT));

  // `algorithm: 2` is `Algorithm.Argon2id` (see @node-rs/argon2). The enum is
  // a `declare const enum`, which `isolatedModules` cannot inline in a `.ts`
  // module, so the literal is used here.
  const passwordHash = await hash(TEST_PASSWORD, {
    algorithm: 2,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  // Write a throwaway env file. The values exist only for this process tree
  // and are never committed or logged.
  const envDir = mkdtempSync(path.join(tmpdir(), "rabet-test-"));
  envDirRef.dir = envDir;
  const envFile = path.join(envDir, "test.env");

  // Generate the throwaway secret here and record it so the expired-session
  // test mints a JWT against the exact key the server verifies with.
  testAuthSecret = Buffer.from(
    globalThis.crypto.getRandomValues(new Uint8Array(32)),
  ).toString("base64");

  // Single-quote the hash so the shell does not expand its `$` characters.
  writeFileSync(
    envFile,
    [
      `AUTH_SECRET=${testAuthSecret}`,
      `ADMIN_EMAIL=${TEST_EMAIL}`,
      `ADMIN_PASSWORD_HASH='${passwordHash}'`,
      `AUTH_URL=${BASE}`,
      `AUTH_TRUST_HOST=true`,
    ].join("\n") + "\n",
  );

  await new Promise<void>((resolve, reject) => {
    server = spawn(
      "bash",
      ["-c", `set -a; . ${envFile}; set +a; exec npx next start -p ${PORT}`],
      {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: process.cwd(),
        // Detached so `killTree` can signal the whole process group, including
        // the `next-server` grandchild (see `killTree`).
        detached: true,
      },
    );
    let started = false;
    const ready = (data: Buffer) => {
      const text = data.toString();
      if (text.includes("Ready") && !started) {
        started = true;
        resolve();
      }
      if (text.toLowerCase().includes("error")) {
        reject(new Error(`server failed to start: ${text}`));
      }
    };
    server.stdout?.on("data", ready);
    server.stderr?.on("data", ready);
    // SIGKILLing the process group in `afterAll` can make these pipes emit an
    // `error` event in this process. Without a listener Node treats it as an
    // uncaught exception and the vitest worker dies after every test has
    // already passed, so the stream errors are swallowed here.
    server.stdout?.on("error", () => {});
    server.stderr?.on("error", () => {});
    server.on("error", () => {});
  });
}, 120_000);

afterAll(async () => {
  // Signal the whole process group, not just the `npx` wrapper, so the
  // `next-server` grandchild dies and releases port 3210, and wait for the
  // process tree to actually be gone before the worker tears down.
  await killTree(server);
  // Also reap any server an individual test spawned directly (the fail-closed
  // test starts its own). Guarding the whole list means a test that threw
  // before its own `finally` still leaves nothing behind.
  for (const child of spawnedServers) {
    await killTree(child);
  }
  freePort(Number(PORT));
  freePort(Number(CLOSED_PORT));

  // Remove the throwaway env directory so no test-only hash or secret is left
  // behind in the OS temp dir. `force` makes this a no-op when the directory
  // was never created (for example when `beforeAll` failed early).
  if (envDirRef.dir) {
    rmSync(envDirRef.dir, { recursive: true, force: true });
    envDirRef.dir = "";
  }
});

/** Fetch with redirect-following disabled so redirects can be inspected. */
async function raw(
  url: string,
  init: RequestInit & { jar?: CookieJar } = {},
): Promise<{ status: number; location: string | null; body: string; headers: Headers; jar: CookieJar }> {
  const jar = init.jar ?? {};
  const cookieHeader = Object.entries(jar)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");

  const response = await fetch(BASE + url, {
    ...init,
    redirect: "manual",
    headers: {
      ...(init.headers ?? {}),
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
  });

  const setCookies = response.headers.getSetCookie?.() ?? [];
  for (const cookie of setCookies) {
    const [pair] = cookie.split(";");
    const [name, ...rest] = pair.split("=");
    if (!name) continue;
    const value = rest.join("=");
    if (value === "" || (cookie.includes("Max-Age=0") && !value)) {
      delete jar[name.trim()];
    } else {
      jar[name.trim()] = value;
    }
  }

  const body = await response.text();
  return {
    status: response.status,
    location: response.headers.get("location"),
    body,
    headers: response.headers,
    jar,
  };
}

function withCsrf(jar: CookieJar): Promise<{ csrf: string; jar: CookieJar }> {
  return (async () => {
    const res = await raw("/api/auth/csrf", { jar });
    const parsed = JSON.parse(res.body || "{}") as { csrfToken?: string };
    return { csrf: parsed.csrfToken ?? "", jar: res.jar };
  })();
}

async function signIn(jar: CookieJar, email = TEST_EMAIL, password = TEST_PASSWORD) {
  const { csrf, jar: jarWithCsrf } = await withCsrf(jar);
  return raw("/api/auth/callback/credentials", {
    jar: jarWithCsrf,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      csrfToken: csrf,
      email,
      password,
      callbackUrl: `${BASE}/overview`,
    }).toString(),
  });
}

async function signOut(jar: CookieJar) {
  const { csrf, jar: jarWithCsrf } = await withCsrf(jar);
  return raw("/api/auth/signout", {
    jar: jarWithCsrf,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      csrfToken: csrf,
      callbackUrl: `${BASE}/login`,
    }).toString(),
  });
}

const DASHBOARD_PATHS = [
  "/overview",
  "/catalog",
  "/inquiries",
  "/customers",
  "/bot-content",
  "/telegram",
  "/settings",
];

describe("unauthenticated access is blocked", () => {
  it.each(DASHBOARD_PATHS)("redirects %s to /login", async (path) => {
    const res = await raw(path);
    expect([301, 302, 303, 307, 308]).toContain(res.status);
    expect(res.location).toContain("/login");
  });

  it("does not render dashboard content for /overview", async () => {
    const res = await raw("/overview");
    expect(res.body).not.toContain("No activity yet");
  });

  it("does not render the dashboard shell sidebar", async () => {
    const res = await raw("/settings");
    expect(res.body).not.toContain("Store-wide configuration");
  });

  it("rejects the protected route handler without a session", async () => {
    const res = await raw("/api/admin");
    expect([301, 302, 303, 307, 308]).toContain(res.status);
    expect(res.location).toContain("/login");
  });
});

describe("login", () => {
  it("serves the sign-in page publicly", async () => {
    const res = await raw("/login");
    expect(res.status).toBe(200);
    expect(res.body).toContain('id="email"');
  });

  it("marks the sign-in page private and non-cacheable", async () => {
    // The login page must not be stored in a shared cache either.
    const res = await raw("/login");
    const cacheControl = res.headers.get("cache-control") ?? "";
    expect(cacheControl.toLowerCase()).toContain("private");
    expect(cacheControl.toLowerCase()).toContain("no-store");
  });

  it("accepts correct credentials and redirects to the dashboard", async () => {
    const res = await signIn({});
    expect([301, 302, 303]).toContain(res.status);
    expect(res.location).toContain("/overview");
    // A session cookie must be issued.
    expect(
      Object.keys(res.jar).some((name) => name.includes("session-token")),
    ).toBe(true);
  });

  it("rejects a wrong password with a generic error", async () => {
    const res = await signIn({}, TEST_EMAIL, "wrong-password");
    expect(res.location).toContain("/login");
    expect(res.location).toContain("CredentialsSignin");
    expect(
      Object.keys(res.jar).some((name) => name.includes("session-token")),
    ).toBe(false);
  });

  it("rejects an unknown email with the same generic error", async () => {
    const res = await signIn({}, "nobody@example.test", "wrong-password");
    expect(res.location).toContain("CredentialsSignin");
  });

  it("does not leak the admin email anywhere in the login response", async () => {
    const res = await raw("/login");
    expect(res.body).not.toContain(TEST_EMAIL);
  });
});

describe("CSRF protection", () => {
  it("rejects a sign-in POST without a CSRF token", async () => {
    // No csrfToken cookie or body field: Auth.js must short-circuit with
    // MissingCSRF and never evaluate the credentials.
    const res = await raw("/api/auth/callback/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        callbackUrl: `${BASE}/overview`,
      }).toString(),
    });
    expect(res.location).toContain("MissingCSRF");
    expect(
      Object.keys(res.jar).some((name) => name.includes("session-token")),
    ).toBe(false);
  });

  it("rejects a sign-in POST with a bogus CSRF token", async () => {
    const res = await raw("/api/auth/callback/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrfToken: "not-a-real-token",
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        callbackUrl: `${BASE}/overview`,
      }).toString(),
    });
    expect(res.location).toContain("MissingCSRF");
    expect(
      Object.keys(res.jar).some((name) => name.includes("session-token")),
    ).toBe(false);
  });
});

describe("open-redirect protection", () => {
  it("does not follow an external callbackUrl off the site's origin", async () => {
    // An attacker-supplied `callbackUrl` must never steer the redirect off the
    // origin. Auth.js itself collapses it to the origin; the application layer
    // (`safeLoginRedirect`) additionally restricts it to internal dashboard
    // routes for the Server Action path.
    const { csrf, jar } = await withCsrf({});
    const res = await raw("/api/auth/callback/credentials", {
      jar,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrfToken: csrf,
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        callbackUrl: "https://evil.example.com/path",
      }).toString(),
    });
    expect(res.status).toBe(302);
    const location = res.location ?? "";
    expect(location).not.toContain("evil.example.com");
    expect(location).toContain(BASE);
  });

  it("sends a protocol-relative callbackUrl nowhere off-origin", async () => {
    // A protocol-relative value (`//evil.example.com/...`) has no scheme, so
    // Auth.js resolves it against the origin as a *path*. The result may carry
    // the string in its path, but the navigation must stay on this host —
    // that is the property that matters, so assert the origin, not a substring.
    const { csrf, jar } = await withCsrf({});
    const res = await raw("/api/auth/callback/credentials", {
      jar,
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        csrfToken: csrf,
        email: TEST_EMAIL,
        password: TEST_PASSWORD,
        callbackUrl: "//evil.example.com/path",
      }).toString(),
    });
    const location = res.location ?? "";
    expect(location).toContain(BASE);
    const host = new URL(location).host;
    expect(host).toBe(`localhost:${PORT}`);
  });
});

describe("authenticated access", () => {
  it("renders dashboard content with a valid session", async () => {
    const loginRes = await signIn({});
    const res = await raw("/overview", { jar: loginRes.jar });
    expect(res.status).toBe(200);
    expect(res.body).toContain("No activity yet");
  });

  it("returns admin data from the protected route handler", async () => {
    const loginRes = await signIn({});
    const res = await raw("/api/admin", { jar: loginRes.jar });
    expect(res.status).toBe(200);
    const parsed = JSON.parse(res.body || "{}") as { admin?: string };
    expect(parsed.admin).toBe(TEST_EMAIL);
  });

  it("marks protected responses as private and non-cacheable", async () => {
    const loginRes = await signIn({});
    const res = await raw("/overview", { jar: loginRes.jar });
    const cacheControl = res.headers.get("cache-control") ?? "";
    expect(cacheControl.toLowerCase()).toContain("private");
    expect(cacheControl.toLowerCase()).toContain("no-store");
  });

  it("rejects a tampered session cookie", async () => {
    const loginRes = await signIn({});
    const tampered = { ...loginRes.jar };
    const sessionKey = Object.keys(tampered).find((name) =>
      name.includes("session-token"),
    );
    expect(sessionKey).toBeTruthy();
    tampered[sessionKey as string] = tampered[sessionKey as string]
      .slice(0, -4)
      .concat("AAAA");
    const res = await raw("/overview", { jar: tampered });
    expect(res.body).not.toContain("No activity yet");
  });

  it("rejects a fabricated session cookie", async () => {
    const res = await raw("/overview", {
      jar: { "__Secure-authjs.session-token": "totally-fabricated-value" },
    });
    expect(res.body).not.toContain("No activity yet");
  });

  it("rejects a session cookie whose JWT has expired", async () => {
    // The session is a stateless encrypted JWT, so the only honest way to test
    // expiry without waiting seven days is to mint a token that is *already*
    // past its `exp`, using the same secret and salt the running server uses
    // (`salt` is the cookie name — see `@auth/core`'s session store).
    //
    // The control matters: a token minted the same way but still valid IS
    // accepted, so this assertion is genuinely about the `exp` claim and not
    // about a malformed cookie.
    const loginRes = await signIn({});
    const sessionName = Object.keys(loginRes.jar).find((name) =>
      name.includes("session-token"),
    );
    expect(sessionName).toBeTruthy();

    const expired = await encodeJwt({
      token: { sub: "admin", email: TEST_EMAIL, role: "admin" },
      secret: testAuthSecret,
      salt: sessionName ?? "authjs.session-token",
      // Negative maxAge sets an expiration time in the past.
      maxAge: -3600,
    });

    const res = await raw("/overview", {
      jar: { [sessionName as string]: expired },
    });
    expect([301, 302, 303, 307, 308]).toContain(res.status);
    expect(res.location).toContain("/login");
    expect(res.body).not.toContain("No activity yet");
  });
});

describe("missing admin configuration fails closed", () => {
  it("rejects every sign-in attempt when no admin is provisioned", async () => {
    // Start a second server that has AUTH_SECRET but no ADMIN_EMAIL /
    // ADMIN_PASSWORD_HASH. Sign-in must be impossible on it: nobody can log
    // in, and the dashboard stays unreachable.
    const base = `http://localhost:${CLOSED_PORT}`;

    const envFile = path.join(envDirRef.dir, "empty-admin.env");
    writeFileSync(
      envFile,
      [
        `AUTH_SECRET=${Buffer.from(
          globalThis.crypto.getRandomValues(new Uint8Array(32)),
        ).toString("base64")}`,
        `AUTH_URL=${base}`,
        `AUTH_TRUST_HOST=true`,
      ].join("\n") + "\n",
    );

    // A leftover from a previously crashed run can still hold this port.
    await freePort(Number(CLOSED_PORT));

    const proc = track(
      spawn(
        "bash",
        [
          "-c",
          `set -a; . ${envFile}; set +a; exec npx next start -p ${CLOSED_PORT}`,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          cwd: process.cwd(),
          // Detached so `killTree` reaches the `next-server` grandchild too.
          detached: true,
        },
      ),
    );
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("fail-closed server did not start")),
        60_000,
      );
      const onData = (data: Buffer) => {
        if (data.toString().includes("Ready")) {
          clearTimeout(timer);
          resolve();
        }
      };
      proc.stdout?.on("data", onData);
      proc.stderr?.on("data", onData);
      // As with the main server: killing the group can raise stream `error`
      // events that would otherwise crash this worker after the test passes.
      proc.stdout?.on("error", () => {});
      proc.stderr?.on("error", () => {});
      proc.on("error", () => {});
    });
    await ready;

    try {
      // Fetch a CSRF token and keep the cookie it sets, otherwise the callback
      // rejects with MissingCSRF before the credentials are even evaluated.
      const jar: CookieJar = {};
      const csrfRes = await fetch(`${base}/api/auth/csrf`);
      for (const cookie of csrfRes.headers.getSetCookie()) {
        const [pair] = cookie.split(";");
        const [name, ...rest] = pair.split("=");
        if (name && rest.length) jar[name.trim()] = rest.join("=");
      }
      const { csrfToken } = (await csrfRes.json()) as { csrfToken: string };

      const loginRes = await fetch(`${base}/api/auth/callback/credentials`, {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: Object.entries(jar)
            .map(([name, value]) => `${name}=${value}`)
            .join("; "),
        },
        body: new URLSearchParams({
          csrfToken,
          email: "admin@example.test",
          password: TEST_PASSWORD,
          callbackUrl: `${base}/overview`,
        }).toString(),
      });

      // Must NOT land on the dashboard.
      expect(loginRes.headers.get("location")).toContain("/login");
      expect(loginRes.headers.get("location")).toContain("CredentialsSignin");

      const hasSession = loginRes.headers
        .getSetCookie()
        .some((cookie) => cookie.includes("session-token"));
      expect(hasSession).toBe(false);

      const overviewRes = await fetch(`${base}/overview`, {
        redirect: "manual",
      });
      expect(overviewRes.headers.get("location")).toContain("/login");
      const body = await overviewRes.text();
      expect(body).not.toContain("No activity yet");
    } finally {
      // Kill the whole process group so the `next-server` grandchild dies and
      // releases port 3211 for future runs.
      await killTree(proc);
    }
  }, 90_000);
});

describe("logout", () => {
  it("invalidates the session and blocks subsequent access", async () => {
    const loginRes = await signIn({});
    const authed = await raw("/overview", { jar: loginRes.jar });
    expect(authed.body).toContain("No activity yet");

    const out = await signOut(loginRes.jar);
    expect(out.location).toContain("/login");

    const after = await raw("/overview", { jar: out.jar });
    // The session cookie is gone, so the dashboard must be unreachable.
    expect(after.body).not.toContain("No activity yet");
  });

  it("leaves the public landing page reachable", async () => {
    const res = await raw("/");
    expect(res.status).toBe(200);
    expect(res.body).toContain("Rabet");
  });
});

describe("PWA assets stay reachable while signed out", () => {
  // The installed PWA must always be able to present the login screen, so the
  // proxy must never gate the manifest, the icons or the Auth.js handler.
  it("serves the web app manifest", async () => {
    const res = await raw("/manifest.webmanifest");
    expect(res.status).toBe(200);
    const manifest = JSON.parse(res.body || "{}") as {
      start_url?: string;
      display?: string;
      icons?: Array<{ src?: string }>;
    };
    expect(manifest.start_url).toBe("/overview");
    expect(manifest.display).toBe("standalone");
    expect(manifest.icons?.length).toBeGreaterThan(0);
  });

  it.each([
    "/icons/icon-192x192.png",
    "/icons/icon-512x512.png",
    "/icons/maskable-192x192.png",
    "/icons/maskable-512x512.png",
    "/icons/apple-touch-icon.png",
    "/favicon.ico",
  ])("serves %s without a session", async (asset) => {
    const res = await raw(asset);
    expect(res.status).toBe(200);
  });

  it("registers no service worker", async () => {
    // No service worker may exist: one could cache authenticated responses,
    // which is the exact risk ADR-008 rules out. A missing script on the
    // standard paths plus no registration in the document proves absence.
    for (const sw of ["/sw.js", "/service-worker.js"]) {
      const res = await raw(sw);
      expect(res.status).toBe(404);
    }
    const login = await raw("/login");
    expect(login.body).not.toMatch(/serviceWorker\.register/);
  });
});

describe("no credential material leaks", () => {
  it("never returns the admin password or its hash in any response", async () => {
    const login = await signIn({});
    const overview = await raw("/overview", { jar: login.jar });
    const admin = await raw("/api/admin", { jar: login.jar });

    for (const body of [login.body, overview.body, admin.body]) {
      expect(body).not.toContain(TEST_PASSWORD);
      expect(body.toLowerCase()).not.toContain("argon2");
      expect(body).not.toContain("$argon2id$");
    }
  });

  it("does not echo the session token in any response body", async () => {
    const loginRes = await signIn({});
    const sessionValue = Object.entries(loginRes.jar).find(([name]) =>
      name.includes("session-token"),
    )?.[1];
    expect(sessionValue).toBeTruthy();

    const res = await raw("/overview", { jar: loginRes.jar });
    // The token must be cookie-only: it must never be echoed back in HTML.
    expect(res.body).not.toContain(sessionValue as string);
  });
});
