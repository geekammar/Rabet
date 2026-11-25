#!/usr/bin/env node
import fs from "node:fs";
import postgres from "postgres";

const CANDIDATE_SHA = (process.env.CANDIDATE_SHA ?? "").trim().toLowerCase();
const PREVIOUS_SHA = (process.env.PREVIOUS_SHA ?? "").trim().toLowerCase();
const QA_SERVICE_ID = (process.env.QA_SERVICE_ID ?? "").trim();
const QA_APP_URL = (process.env.QA_APP_URL ?? "").trim().replace(/\/$/, "");
const EXPECTED_DB_NAME = (process.env.EXPECTED_DB_NAME ?? "").trim();
const RENDER_API_KEY = process.env.RENDER_API_KEY ?? "";
const SUMMARY_PATH = "/tmp/cod-qa-pr58-deploy-summary.json";

const summary = {
  status: "blocked",
  candidateSha: CANDIDATE_SHA,
  previousSha: PREVIOUS_SHA,
  qaServiceId: QA_SERVICE_ID,
  qaAppUrl: QA_APP_URL,
  stage: "validate",
  generatedAt: new Date().toISOString(),
};
const secrets = [RENDER_API_KEY];

function log(message) {
  process.stdout.write(`[cod-qa-pr58-deploy] ${String(message)}\n`);
}

function redact(value) {
  let text = String(value ?? "");
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join("[REDACTED]");
  }
  return text.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "[REDACTED_DB_URL]");
}

function fail(message) {
  throw new Error(redact(message));
}

function requireSha(value, label) {
  if (!/^[0-9a-f]{40}$/.test(value)) fail(`${label} must be a full 40-character SHA`);
  return value;
}

function parseDbUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail("QA DATABASE_URL is missing or invalid");
  }
  if (!/^postgres(ql)?:$/.test(parsed.protocol)) fail("QA DATABASE_URL must be postgres");
  if (!parsed.hostname.toLowerCase().endsWith(".neon.tech")) fail("QA DATABASE_URL must target Neon");
  if (!parsed.pathname || parsed.pathname === "/") fail("QA DATABASE_URL must name a database");
  secrets.push(raw, parsed.password);
  return parsed;
}

async function renderApi(method, apiPath, body) {
  let response;
  try {
    response = await fetch(`https://api.render.com/v1${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${RENDER_API_KEY}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    fail(`Render API network error: ${error instanceof Error ? error.message : String(error)}`);
  }
  const text = await response.text();
  let payload = null;
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {}
  }
  if (!response.ok) {
    fail(
      `Render API ${method} ${apiPath} failed HTTP ${response.status}: ${
        payload?.message ?? text.slice(0, 300)
      }`,
    );
  }
  return payload;
}

function normalizeEnvList(payload) {
  const list = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.envVars)
      ? payload.envVars
      : null;
  if (!list) fail("Unexpected Render env-vars response shape");
  return list.map((entry) => {
    const row = entry?.envVar ?? entry;
    return { key: String(row?.key ?? ""), value: row?.value };
  });
}

async function getEnvMap(serviceId) {
  const rows = normalizeEnvList(
    await renderApi("GET", `/services/${serviceId}/env-vars?limit=100`),
  );
  return new Map(rows.filter((row) => row.key).map((row) => [row.key, row.value]));
}

async function getService() {
  const payload = await renderApi("GET", `/services/${QA_SERVICE_ID}`);
  return payload?.service ?? payload;
}

async function getDeploy(deployId) {
  return renderApi("GET", `/services/${QA_SERVICE_ID}/deploys/${deployId}`);
}

async function main() {
  stage = "validate";
  requireSha(CANDIDATE_SHA, "CANDIDATE_SHA");
  requireSha(PREVIOUS_SHA, "PREVIOUS_SHA");
  if (!/^srv-[a-z0-9]+$/i.test(QA_SERVICE_ID)) fail("QA_SERVICE_ID must look like srv-…");
  if (!EXPECTED_DB_NAME) fail("EXPECTED_DB_NAME is missing");
  if (!RENDER_API_KEY) fail("RENDER_API_KEY is missing");
  const appUrl = new URL(QA_APP_URL);
  if (appUrl.protocol !== "https:") fail("QA_APP_URL must be https");

  const service = await getService();
  const serviceUrl = String(service?.serviceDetails?.url ?? "").replace(/\/$/, "");
  if (new URL(serviceUrl).hostname !== appUrl.hostname) {
    fail(`QA service URL ${serviceUrl} does not match ${QA_APP_URL}`);
  }
  if (service?.suspended === "suspended") fail("QA service is suspended");
  if (service?.autoDeployTrigger !== "off" && service?.autoDeploy !== "no") {
    fail("QA service auto-deploy must be off");
  }

  const env = await getEnvMap(QA_SERVICE_ID);
  if ([...env.keys()].some((key) => key.startsWith("TELEGRAM_"))) {
    fail("QA service must not have Telegram credentials");
  }
  const dbUrlRaw = env.get("DATABASE_URL");
  if (!dbUrlRaw) fail("QA DATABASE_URL is missing");
  const dbUrl = parseDbUrl(dbUrlRaw);
  const database = dbUrl.pathname.replace(/^\//, "");
  if (database !== EXPECTED_DB_NAME) {
    fail(`QA database is ${database}, expected ${EXPECTED_DB_NAME}`);
  }
  const currentBuild = String(env.get("RABET_BUILD_SHA") ?? "").toLowerCase();
  if (currentBuild !== PREVIOUS_SHA) {
    fail(`QA RABET_BUILD_SHA is ${currentBuild || "missing"}, expected ${PREVIOUS_SHA}`);
  }
  summary.service = {
    id: service.id,
    name: service.name,
    url: serviceUrl,
    autoDeployTrigger: service.autoDeployTrigger ?? service.autoDeploy,
    database: { host: dbUrl.hostname, name: database },
    previousBuildSha: currentBuild,
    envKeys: [...env.keys()].sort(),
  };
  log(`QA service ${service.id} is on ${currentBuild}, database ${database}`);

  stage = "database-before";
  const sql = postgres(dbUrl.toString(), { max: 1, connect_timeout: 30, ssl: "require" });
  try {
    const [identity] = await sql`
      select current_database() as database, current_user as role,
        (select count(*)::int from drizzle.__drizzle_migrations) as ledger
    `;
    const fixtures = await sql`
      select reference, status, fulfillment_status, payment_status,
        handed_to_shipping_at, delivered_at, payment_collected_at,
        subtotal, delivery_fee, total, currency
      from "order" where reference in ('ORD-DXA234','ORD-DXB345')
      order by reference
    `;
    const prior = await sql`
      select reference, status, fulfillment_status, payment_status,
        delivered_at, payment_collected_at, total
      from "order" where reference in (
        'ORD-Q2A234','ORD-QHL456','ORD-QCB345','ORD-X2EZD9'
      ) order by reference
    `;
    if (identity.database !== EXPECTED_DB_NAME) fail("Connected QA database identity mismatch");
    if (identity.ledger !== 16) fail(`QA ledger is ${identity.ledger}, expected 16`);
    if (fixtures.length !== 2) fail("Expected two UX-01 fixtures before deploy");
    for (const [index, expected] of [
      {
        reference: "ORD-DXA234",
        status: "preparing",
        fulfillment: "unfulfilled",
        payment: "awaiting_collection",
        total: "31.00",
      },
      {
        reference: "ORD-DXB345",
        status: "preparing",
        fulfillment: "delivered",
        payment: "awaiting_collection",
        total: "22.00",
      },
    ].entries()) {
      const row = fixtures.find((item) => item.reference === expected.reference);
      if (!row) fail(`Fixture ${expected.reference} is missing`);
      if (
        row.status !== expected.status ||
        row.fulfillment_status !== expected.fulfillment ||
        row.payment_status !== expected.payment ||
        row.total !== expected.total
      ) {
        fail(`Fixture ${expected.reference} state differs from expected (${index})`);
      }
    }
    summary.databaseBeforeDeploy = { identity, fixtures, priorEvidence: prior };
    log(`Database ${identity.database}, ledger ${identity.ledger}, fixtures present`);
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }

  stage = "update-build-sha";
  const envRows = normalizeEnvList(
    await renderApi("GET", `/services/${QA_SERVICE_ID}/env-vars?limit=100`),
  ).filter((row) => row.key);
  const nextEnv = envRows.map((row) =>
    row.key === "RABET_BUILD_SHA" ? { ...row, value: CANDIDATE_SHA } : row,
  );
  if (!nextEnv.some((row) => row.key === "RABET_BUILD_SHA")) {
    fail("RABET_BUILD_SHA is missing from QA service");
  }
  await renderApi(
    "PUT",
    `/services/${QA_SERVICE_ID}/env-vars`,
    nextEnv.map(({ key, value }) => ({ key, value })),
  );
  log(`Updated RABET_BUILD_SHA to ${CANDIDATE_SHA}`);

  stage = "deploy";
  const deploy = await renderApi("POST", `/services/${QA_SERVICE_ID}/deploys`, {
    commitId: CANDIDATE_SHA,
  });
  if (!deploy?.id) fail("Render did not return a deploy id");
  summary.deploy = { id: deploy.id, commit: CANDIDATE_SHA };
  log(`Render deploy ${deploy.id} started`);

  const deadline = Date.now() + 25 * 60 * 1000;
  let live = null;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const current = await getDeploy(deploy.id);
    const status = String(current?.status ?? "unknown");
    log(`Deploy status: ${status}`);
    if (status === "live") {
      live = current;
      break;
    }
    if (["build_failed", "update_failed", "canceled", "deactivated", "pre_deploy_failed"].includes(status)) {
      fail(`Deploy failed with status ${status}`);
    }
  }
  if (!live) fail("Timed out waiting for Render deploy");
  const liveCommit = live.commit?.id ?? live.commitId ?? null;
  if (liveCommit && liveCommit !== CANDIDATE_SHA) {
    fail(`Live deploy commit is ${liveCommit}, expected ${CANDIDATE_SHA}`);
  }
  summary.deploy.status = "live";
  summary.deploy.commit = liveCommit ?? CANDIDATE_SHA;

  stage = "verify-health";
  const healthDeadline = Date.now() + 8 * 60 * 1000;
  let health = null;
  while (Date.now() < healthDeadline) {
    try {
      const response = await fetch(`${QA_APP_URL}/api/healthz`, {
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(20_000),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload?.status === "ok" && payload?.sha === CANDIDATE_SHA) {
        health = payload;
        break;
      }
      log(`Health not ready: HTTP ${response.status} sha ${String(payload?.sha ?? "missing")}`);
    } catch (error) {
      log(`Health request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  if (!health) fail("Timed out waiting for candidate SHA in QA /api/healthz");

  stage = "database-after";
  const sqlAfter = postgres(dbUrl.toString(), { max: 1, connect_timeout: 30, ssl: "require" });
  try {
    const [identity] = await sqlAfter`
      select current_database() as database, current_user as role,
        (select count(*)::int from drizzle.__drizzle_migrations) as ledger
    `;
    const fixtures = await sqlAfter`
      select reference, status, fulfillment_status, payment_status,
        handed_to_shipping_at, delivered_at, payment_collected_at,
        subtotal, delivery_fee, total, currency
      from "order" where reference in ('ORD-DXA234','ORD-DXB345')
      order by reference
    `;
    const prior = await sqlAfter`
      select reference, status, fulfillment_status, payment_status,
        delivered_at, payment_collected_at, total
      from "order" where reference in (
        'ORD-Q2A234','ORD-QHL456','ORD-QCB345','ORD-X2EZD9'
      ) order by reference
    `;
    const ux01Order = await sqlAfter`
      select reference, placed_at, created_at, id
      from "order" where reference in ('ORD-DXA234','ORD-DXB345')
      order by placed_at desc, created_at desc, id desc
    `;
    summary.databaseAfterDeploy = { identity, fixtures, priorEvidence: prior, deterministicOrder: ux01Order };
    if (identity.database !== EXPECTED_DB_NAME || identity.ledger !== 16) {
      fail("QA database identity or ledger changed after deploy");
    }
    if (JSON.stringify(fixtures) !== JSON.stringify(summary.databaseBeforeDeploy.fixtures)) {
      fail("Fixture states changed during deploy");
    }
    if (JSON.stringify(prior) !== JSON.stringify(summary.databaseBeforeDeploy.priorEvidence)) {
      fail("Prior evidence orders changed during deploy");
    }
    log(`Post-deploy database preserved: ledger ${identity.ledger}, fixtures and prior evidence unchanged`);
  } finally {
    await sqlAfter.end({ timeout: 5 }).catch(() => {});
  }

  summary.health = health;
  summary.status = "ready";
  summary.stage = "complete";
  summary.generatedAt = new Date().toISOString();
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), { mode: 0o644 });
  log(`QA is live at ${QA_APP_URL} with ${health.sha}`);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

let stage = "validate";

main().catch((error) => {
  summary.status = "blocked";
  summary.stage = stage;
  summary.error = redact(error instanceof Error ? error.message : String(error));
  summary.generatedAt = new Date().toISOString();
  try {
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), { mode: 0o644 });
  } catch {}
  process.stderr.write(`[cod-qa-pr58-deploy:FAIL] ${summary.error}\n`);
  process.exitCode = 1;
});
