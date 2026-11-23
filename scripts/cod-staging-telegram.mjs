#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";

const CANDIDATE_SHA = (process.env.CANDIDATE_SHA ?? "").trim().toLowerCase();
const SERVICE_ID = (process.env.RENDER_SERVICE_ID ?? "").trim();
const APP_URL = (process.env.APP_URL ?? "").trim().replace(/\/$/, "");
const RENDER_API_KEY = process.env.RENDER_API_KEY ?? "";
const SUMMARY_PATH = "/tmp/cod-staging-telegram-summary.json";
const MANAGER_WEBHOOK_PATH = "/api/telegram/manager/webhook";

function log(message) {
  process.stdout.write(`[cod-telegram] ${String(message)}\n`);
}

function fail(message) {
  process.stderr.write(`[cod-telegram:FAIL] ${String(message)}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

function requireSha(value) {
  if (!/^[0-9a-f]{40}$/.test(value)) fail("CANDIDATE_SHA must be a full 40-character SHA");
  return value;
}

function requireServiceId(value) {
  if (!/^srv-[a-z0-9]+$/i.test(value)) fail("RENDER_SERVICE_ID must look like srv-…");
  return value;
}

function requireHttps(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("APP_URL must be a valid URL");
  }
  if (parsed.protocol !== "https:") fail("APP_URL must use https");
  return parsed;
}

async function renderApi(method, apiPath, body, secrets = []) {
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
    fail(`Render API ${method} ${apiPath} failed HTTP ${response.status}: ${payload?.message ?? text.slice(0, 250)}`);
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

async function telegram(token, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : "{}",
    signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json().catch(() => null);
  return { status: response.status, ok: response.ok, payload };
}

function allowedUpdateSet(value) {
  return new Set(Array.isArray(value) ? value.map(String) : []);
}

async function deployExactCommit() {
  const deploy = await renderApi("POST", `/services/${SERVICE_ID}/deploys`, {
    commitId: CANDIDATE_SHA,
  });
  if (!deploy?.id) fail("Render did not return a deploy id");
  log(`Render deploy ${deploy.id} started for ${CANDIDATE_SHA}`);
  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    const current = await renderApi("GET", `/services/${SERVICE_ID}/deploys/${deploy.id}`);
    const status = String(current?.status ?? "unknown");
    log(`Render deploy status: ${status}`);
    if (status === "live") return current;
    if (["build_failed", "update_failed", "canceled", "deactivated", "pre_deploy_failed"].includes(status)) {
      fail(`Render deploy failed with status ${status}`);
    }
  }
  fail("Timed out waiting for Render deploy");
}

async function waitForHealth() {
  const deadline = Date.now() + 8 * 60 * 1000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${APP_URL}/api/healthz`, {
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(20_000),
      });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload?.status === "ok" && payload?.sha === CANDIDATE_SHA) {
        return payload;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
  fail("Timed out waiting for deployed SHA in /api/healthz");
}

async function main() {
  requireSha(CANDIDATE_SHA);
  requireServiceId(SERVICE_ID);
  requireHttps(APP_URL);
  if (!RENDER_API_KEY) fail("RENDER_API_KEY is missing");

  log("Reading isolated service environment (values never printed)");
  const envList = normalizeEnvList(
    await renderApi("GET", `/services/${SERVICE_ID}/env-vars`),
  );
  const envMap = new Map();
  for (const entry of envList) {
    if (entry.key && typeof entry.value === "string") {
      envMap.set(entry.key, entry.value);
    }
  }
  const token = envMap.get("TELEGRAM_MANAGER_BOT_TOKEN");
  if (!token || token.trim().length === 0) {
    fail("TELEGRAM_MANAGER_BOT_TOKEN is absent from the isolated service");
  }

  log("Verifying test Manager Bot identity via getMe");
  const me = await telegram(token, "getMe");
  if (!me.ok || me.payload?.ok !== true || !me.payload?.result) {
    fail(`getMe failed with HTTP ${me.status}`);
  }
  const identity = me.payload.result;
  if (identity.is_bot !== true) fail("TELEGRAM_MANAGER_BOT_TOKEN is not a bot identity");
  const botId = Number(identity.id);
  const botUsername = typeof identity.username === "string" ? identity.username : null;
  if (!Number.isSafeInteger(botId) || botId < 1) fail("Telegram returned an invalid bot id");
  log(`Manager bot identity verified: @${botUsername ?? "no-username"} (id ${botId})`);

  let webhookSecret = envMap.get("TELEGRAM_MANAGER_WEBHOOK_SECRET");
  let webhookSecretGenerated = false;
  if (!webhookSecret || !/^[A-Za-z0-9_-]{16,256}$/.test(webhookSecret)) {
    webhookSecret = crypto.randomBytes(32).toString("base64url");
    webhookSecretGenerated = true;
  }

  let connectionKey = envMap.get("TELEGRAM_CONNECTION_TOKEN_KEY");
  let connectionKeyGenerated = false;
  if (connectionKey !== undefined && connectionKey.trim().length > 0) {
    let bytes;
    try {
      bytes = Buffer.from(connectionKey, "base64");
    } catch {
      bytes = null;
    }
    if (!bytes || bytes.length !== 32) {
      fail("Existing TELEGRAM_CONNECTION_TOKEN_KEY is not 32 bytes of base64; refusing to replace it");
    }
  } else {
    connectionKey = crypto.randomBytes(32).toString("base64");
    connectionKeyGenerated = true;
  }

  let connectionKeyId = envMap.get("TELEGRAM_CONNECTION_TOKEN_KEY_ID");
  if (!connectionKeyId || connectionKeyId.trim().length === 0) {
    connectionKeyId = "cod-staging-v1";
  }

  const updates = new Map(envMap);
  updates.set("TELEGRAM_MANAGER_WEBHOOK_SECRET", webhookSecret);
  updates.set("TELEGRAM_CONNECTION_TOKEN_KEY", connectionKey);
  updates.set("TELEGRAM_CONNECTION_TOKEN_KEY_ID", connectionKeyId);

  const body = [...updates.entries()].map(([key, value]) => ({ key, value }));
  log("Writing Manager webhook/encryption configuration to the isolated service");
  await renderApi("PUT", `/services/${SERVICE_ID}/env-vars`, body);

  await deployExactCommit();
  const health = await waitForHealth();
  log(`Isolated service is live at ${health.sha}`);

  const webhookUrl = `${APP_URL}${MANAGER_WEBHOOK_PATH}`;
  log("Registering Manager Bot webhook (secret not printed)");
  const set = await telegram(token, "setWebhook", {
    url: webhookUrl,
    secret_token: webhookSecret,
    allowed_updates: ["message", "managed_bot"],
    drop_pending_updates: false,
  });
  if (!set.ok || set.payload?.ok !== true) {
    fail(`setWebhook failed with HTTP ${set.status}: ${set.payload?.description ?? "unknown error"}`);
  }

  const info = await telegram(token, "getWebhookInfo");
  if (!info.ok || info.payload?.ok !== true || !info.payload?.result) {
    fail(`getWebhookInfo failed with HTTP ${info.status}`);
  }
  const webhookInfo = info.payload.result;
  if (webhookInfo.url !== webhookUrl) {
    fail(`getWebhookInfo URL mismatch: ${String(webhookInfo.url ?? "")}`);
  }
  const allowed = allowedUpdateSet(webhookInfo.allowed_updates);
  if (!allowed.has("message") || !allowed.has("managed_bot")) {
    fail(`getWebhookInfo allowed_updates is missing required types: ${[...allowed].join(",")}`);
  }

  const unauthorized = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal: AbortSignal.timeout(20_000),
  });
  const wrong = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-telegram-bot-api-secret-token": "wrong-secret",
    },
    body: "{}",
    signal: AbortSignal.timeout(20_000),
  });
  const ignoredResponse = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-telegram-bot-api-secret-token": webhookSecret,
    },
    body: JSON.stringify({ update_id: 990001, edited_message: {} }),
    signal: AbortSignal.timeout(20_000),
  });
  const ignoredBody = await ignoredResponse.json().catch(() => null);

  const summary = {
    serviceId: SERVICE_ID,
    appUrl: APP_URL,
    deployedSha: CANDIDATE_SHA,
    health,
    managerBot: {
      id: botId,
      username: botUsername,
      isBot: identity.is_bot === true,
      canManageBots:
        typeof identity.can_manage_bots === "boolean"
          ? identity.can_manage_bots
          : "not-exposed",
    },
    webhook: {
      url: webhookInfo.url,
      allowedUpdates: [...allowed].sort(),
      pendingUpdateCount: webhookInfo.pending_update_count ?? null,
      lastErrorDate: webhookInfo.last_error_date ?? null,
      lastErrorMessage: webhookInfo.last_error_message ?? null,
      registration: "verified via getWebhookInfo",
      actualTelegramUpdateDelivery: "NOT RUN - no real Telegram update observed",
    },
    configuration: {
      managerWebhookSecretGenerated: webhookSecretGenerated,
      connectionKeyGenerated,
      connectionKeyId,
      managerTokenPresence: "present",
    },
    liveWebhookChecks: {
      missingSecretStatus: unauthorized.status,
      wrongSecretStatus: wrong.status,
      correctSecretIgnoredStatus: ignoredResponse.status,
      correctSecretIgnoredBody: ignoredBody,
    },
    managedBotReadiness: {
      status: "awaiting owner taps",
      note: "No managed bot was created or confirmed by this run; seeded connection is synthetic/revoked.",
    },
    generatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2), { mode: 0o644 });
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
