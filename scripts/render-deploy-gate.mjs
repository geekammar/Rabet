#!/usr/bin/env node
/**
 * scripts/render-deploy-gate.mjs
 *
 * Fail-closed Render promotion helper for the verified GHCR digest produced by
 * .github/workflows/render-image.yml.
 *
 * The helper deliberately updates BOTH Render image references:
 *   1. PATCH /v1/services/{serviceId} changes the service's saved image
 *      reference to the immutable GHCR digest. Render does not deploy this
 *      change automatically, but later dashboard "Deploy latest reference"
 *      actions use this saved value.
 *   2. POST /v1/services/{serviceId}/deploys with `imageUrl` deploys that exact
 *      digest for the live deployment.
 *
 * After Render reports the deploy `live`, the helper verifies the deploy's
 * resolved image digest and then polls GET /api/healthz until it returns the
 * expected full 40-character commit SHA. Any mismatch, timeout, stale main SHA,
 * or superseded deploy fails the release and restores the previous saved image
 * reference when it is still safe to do so.
 *
 * Official references:
 *   - https://render.com/docs/deploying-an-image
 *   - https://api-docs.render.com/reference/update-service
 *   - https://api-docs.render.com/reference/create-deploy
 *   - https://api-docs.render.com/reference/retrieve-deploy
 *   - https://api-docs.render.com/reference/cancel-deploy
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const SHA40_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const RAW_DIGEST_RE = /^[0-9a-f]{64}$/;
const IMAGE_REPO_RE = /^[a-z0-9._-]+(\/[a-z0-9._-]+)+$/;
const SERVICE_ID_RE = /^srv-[a-z0-9]+$/i;

const PENDING_DEPLOY_STATUSES = new Set([
  "created",
  "queued",
  "build_in_progress",
  "update_in_progress",
  "pre_deploy_in_progress",
]);

const FAILED_DEPLOY_STATUSES = new Set([
  "build_failed",
  "update_failed",
  "canceled",
  "deactivated",
  "pre_deploy_failed",
]);

export class RenderDeployError extends Error {
  /**
   * @param {"INVALID_INPUT" | "STALE_MAIN" | "MAIN_LOOKUP_FAILED" | "SERVICE_MISMATCH" | "IMAGE_MISMATCH" | "RENDER_API_ERROR" | "DEPLOY_FAILED" | "DEPLOY_TIMEOUT" | "HEALTH_MISMATCH"} code
   * @param {string} message
   */
  constructor(code, message) {
    super(`[${code}] ${message}`);
    this.name = "RenderDeployError";
    this.code = code;
  }
}

function normalizeSha(value, label = "sha") {
  const sha = String(value ?? "").trim().toLowerCase();
  if (!SHA40_RE.test(sha)) {
    throw new RenderDeployError(
      "INVALID_INPUT",
      `${label} must be a full 40-character lowercase hex SHA (got "${value}").`,
    );
  }
  return sha;
}

function normalizeImageRepo(value, label = "imageRepo") {
  const repo = String(value ?? "").trim().toLowerCase();
  if (!IMAGE_REPO_RE.test(repo)) {
    throw new RenderDeployError(
      "INVALID_INPUT",
      `${label} must be a lowercase OCI repository path (got "${value}").`,
    );
  }
  return repo;
}

export function normalizeDigest(value, label = "digest") {
  const raw = String(value ?? "").trim().toLowerCase();
  const candidate = raw.includes("@") ? raw.slice(raw.lastIndexOf("@") + 1) : raw;
  if (DIGEST_RE.test(candidate)) return candidate;
  if (RAW_DIGEST_RE.test(candidate)) return `sha256:${candidate}`;
  throw new RenderDeployError(
    "INVALID_INPUT",
    `${label} must be a sha256 digest or an image@sha256 reference (got "${value}").`,
  );
}

export function buildImageRef({ imageRepo, digest }) {
  const repo = normalizeImageRepo(imageRepo);
  return `ghcr.io/${repo}@${normalizeDigest(digest)}`;
}

export function parseImageRepository(imagePath) {
  const raw = String(imagePath ?? "").trim().toLowerCase();
  if (!raw) return "";
  const withoutDigest = raw.split("@")[0];
  const slash = withoutDigest.indexOf("/");
  if (slash < 1) return "";
  const host = withoutDigest.slice(0, slash);
  const remainder = withoutDigest.slice(slash + 1);
  const lastColon = remainder.lastIndexOf(":");
  const lastSlash = remainder.lastIndexOf("/");
  const path = lastColon > lastSlash ? remainder.slice(0, lastColon) : remainder;
  return `${host}/${path}`;
}

export function assertFreshMain({ expectedSha, currentMainSha }) {
  const expected = normalizeSha(expectedSha, "expectedSha");
  const current = normalizeSha(currentMainSha, "currentMainSha");
  if (current !== expected) {
    throw new RenderDeployError(
      "STALE_MAIN",
      `Refusing to promote ${expected}: current origin/main is ${current}.`,
    );
  }
  return true;
}

/**
 * @param {{
 *   service: unknown,
 *   expectedImageRepo: string,
 *   expectedServiceId: string,
 * }} params
 */
export function validateRenderService({
  service,
  expectedImageRepo,
  expectedServiceId,
}) {
  if (!service || typeof service !== "object" || Array.isArray(service)) {
    throw new RenderDeployError(
      "SERVICE_MISMATCH",
      "Render did not return a service object.",
    );
  }

  const serviceId = String(service.id ?? "");
  if (!SERVICE_ID_RE.test(serviceId)) {
    throw new RenderDeployError(
      "SERVICE_MISMATCH",
      `Unexpected Render service id "${serviceId}".`,
    );
  }
  if (serviceId !== expectedServiceId) {
    throw new RenderDeployError(
      "SERVICE_MISMATCH",
      `Render service id ${serviceId} does not match RENDER_SERVICE_ID ${expectedServiceId}.`,
    );
  }
  if (service.type !== "web_service") {
    throw new RenderDeployError(
      "SERVICE_MISMATCH",
      `Render service ${serviceId} has type "${service.type}", expected "web_service".`,
    );
  }

  const details =
    service.serviceDetails && typeof service.serviceDetails === "object"
      ? service.serviceDetails
      : {};
  const runtime = details.runtime ?? details.env;
  if (runtime !== "image") {
    throw new RenderDeployError(
      "SERVICE_MISMATCH",
      `Render service ${serviceId} has runtime "${runtime}", expected "image".`,
    );
  }
  if (service.suspended && service.suspended !== "not_suspended") {
    throw new RenderDeployError(
      "SERVICE_MISMATCH",
      `Render service ${serviceId} is ${service.suspended}; refusing to deploy while suspended.`,
    );
  }

  const ownerId = String(service.ownerId ?? "").trim();
  if (!ownerId) {
    throw new RenderDeployError(
      "SERVICE_MISMATCH",
      `Render service ${serviceId} has no ownerId; cannot update its image safely.`,
    );
  }

  const expectedRepository = `ghcr.io/${normalizeImageRepo(expectedImageRepo)}`;
  const actualRepository = parseImageRepository(service.imagePath);
  if (actualRepository !== expectedRepository) {
    throw new RenderDeployError(
      "IMAGE_MISMATCH",
      `Render service ${serviceId} uses image repository "${service.imagePath ?? ""}" (${actualRepository || "unparseable"}), expected ${expectedRepository}.`,
    );
  }

  const registryCredentialId =
    service.registryCredential?.id ??
    details.registryCredential?.id ??
    null;

  return {
    serviceId,
    ownerId,
    previousImagePath: String(service.imagePath ?? ""),
    registryCredentialId,
    dashboardUrl: String(service.dashboardUrl ?? ""),
    healthCheckPath: String(details.healthCheckPath ?? ""),
  };
}

export function buildServiceImagePatch({ target, imageRef }) {
  const image = {
    ownerId: target.ownerId,
    imagePath: imageRef,
  };
  if (target.registryCredentialId) {
    image.registryCredentialId = target.registryCredentialId;
  }
  return { image };
}

export function classifyDeployStatus(status) {
  if (status === "live") return "live";
  if (FAILED_DEPLOY_STATUSES.has(status)) return "failed";
  if (PENDING_DEPLOY_STATUSES.has(status)) return "pending";
  return "unknown";
}

export function verifyDeployImage({
  deploy,
  expectedDigest,
  expectedImageRef,
}) {
  const expected = normalizeDigest(expectedDigest, "expectedDigest");
  const expectedRef = String(expectedImageRef ?? "").trim().toLowerCase();
  if (!deploy || typeof deploy !== "object") {
    throw new RenderDeployError(
      "DEPLOY_FAILED",
      "Render did not return a deploy object.",
    );
  }

  const image = deploy.image;
  if (!image || typeof image !== "object") {
    throw new RenderDeployError(
      "DEPLOY_FAILED",
      `Render deploy ${deploy.id ?? "<unknown>"} has no image provenance.`,
    );
  }

  let actualDigest;
  try {
    actualDigest = normalizeDigest(image.sha ?? image.ref, "deploy image digest");
  } catch (err) {
    throw new RenderDeployError(
      "IMAGE_MISMATCH",
      `Render deploy ${deploy.id ?? "<unknown>"} did not report a usable image digest: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (actualDigest !== expected) {
    throw new RenderDeployError(
      "IMAGE_MISMATCH",
      `Render deploy ${deploy.id ?? "<unknown>"} resolved to ${actualDigest}, expected ${expected}.`,
    );
  }

  if (expectedRef) {
    const actualRef = String(image.ref ?? "").trim().toLowerCase();
    if (actualRef && actualRef !== expectedRef) {
      throw new RenderDeployError(
        "IMAGE_MISMATCH",
        `Render deploy ${deploy.id ?? "<unknown>"} used image reference "${image.ref}", expected "${expectedImageRef}".`,
      );
    }
  }

  return actualDigest;
}

export function verifyHealthPayload({ httpStatus, payload, expectedSha }) {
  const sha = normalizeSha(expectedSha, "expectedSha");
  if (httpStatus !== 200) {
    throw new RenderDeployError(
      "HEALTH_MISMATCH",
      `GET /api/healthz returned HTTP ${httpStatus}, expected 200.`,
    );
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new RenderDeployError(
      "HEALTH_MISMATCH",
      "GET /api/healthz did not return a JSON object.",
    );
  }
  if (payload.status !== "ok") {
    throw new RenderDeployError(
      "HEALTH_MISMATCH",
      `GET /api/healthz returned status "${payload.status}", expected "ok".`,
    );
  }
  const reportedSha = String(payload.sha ?? "").trim().toLowerCase();
  if (!SHA40_RE.test(reportedSha)) {
    throw new RenderDeployError(
      "HEALTH_MISMATCH",
      `GET /api/healthz did not return a full 40-character sha (got "${payload.sha ?? ""}").`,
    );
  }
  if (reportedSha !== sha) {
    throw new RenderDeployError(
      "HEALTH_MISMATCH",
      `GET /api/healthz reported sha ${reportedSha}, expected ${sha}.`,
    );
  }
  return { status: "ok", sha: reportedSha };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renderApi({
  apiKey,
  apiBaseUrl,
  method,
  path,
  body,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
}) {
  let res;
  try {
    res = await fetchImpl(`${apiBaseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new RenderDeployError(
      "RENDER_API_ERROR",
      `Network error calling Render API ${method} ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const text = await res.text();
  let payload = null;
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!res.ok) {
    const detail =
      payload?.message ?? (text.trim().slice(0, 300) || res.statusText);
    throw new RenderDeployError(
      "RENDER_API_ERROR",
      `Render API ${method} ${path} failed with HTTP ${res.status}: ${detail}`,
    );
  }

  return payload;
}

async function waitForDeploy({
  getDeploy,
  cancelDeploy,
  getCurrentMainSha,
  expectedSha,
  deployId,
  expectedDigest,
  expectedImageRef,
  timeoutMs,
  pollIntervalMs,
  sleepImpl,
  nowImpl,
  onStatus,
}) {
  const deadline = nowImpl() + timeoutMs;
  let lastStatus = "unknown";

  while (true) {
    const deploy = await getDeploy(deployId);
    lastStatus = String(deploy?.status ?? "unknown");
    if (typeof onStatus === "function") onStatus(lastStatus);

    if (lastStatus === "live") {
      verifyDeployImage({ deploy, expectedDigest, expectedImageRef });
      return deploy;
    }

    if (classifyDeployStatus(lastStatus) === "failed") {
      throw new RenderDeployError(
        "DEPLOY_FAILED",
        `Render deploy ${deployId} ended with status "${lastStatus}".`,
      );
    }
    if (classifyDeployStatus(lastStatus) === "unknown") {
      throw new RenderDeployError(
        "RENDER_API_ERROR",
        `Render deploy ${deployId} reported unknown status "${lastStatus}".`,
      );
    }

    const currentMainSha = await getCurrentMainSha();
    if (currentMainSha !== expectedSha) {
      let cancelDetail = "cancel request failed";
      try {
        await cancelDeploy(deployId);
        cancelDetail = "in-progress Render deploy was canceled";
      } catch (err) {
        cancelDetail = `cancel request failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      throw new RenderDeployError(
        "STALE_MAIN",
        `origin/main moved to ${currentMainSha} while deploy ${deployId} was ${lastStatus}; ${cancelDetail}.`,
      );
    }

    if (nowImpl() >= deadline) {
      throw new RenderDeployError(
        "DEPLOY_TIMEOUT",
        `Timed out waiting for Render deploy ${deployId} to become live (last status "${lastStatus}").`,
      );
    }
    await sleepImpl(pollIntervalMs);
  }
}

async function waitForHealth({
  fetchImpl,
  healthUrl,
  expectedSha,
  timeoutMs,
  pollIntervalMs,
  sleepImpl,
  nowImpl,
}) {
  const deadline = nowImpl() + timeoutMs;
  let lastHttpStatus = null;
  let lastSha = "";
  let lastError = "no health response received";

  while (true) {
    try {
      const res = await fetchImpl(healthUrl, {
        method: "GET",
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(15_000),
      });
      lastHttpStatus = res.status;
      const text = await res.text();
      let payload = null;
      if (text.trim()) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = null;
        }
      }
      lastSha = String(payload?.sha ?? "").trim().toLowerCase();
      try {
        const verified = verifyHealthPayload({
          httpStatus: res.status,
          payload,
          expectedSha,
        });
        return {
          httpStatus: res.status,
          sha: verified.sha,
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    if (nowImpl() >= deadline) {
      throw new RenderDeployError(
        "HEALTH_MISMATCH",
        `Timed out waiting for /api/healthz to report ${expectedSha} (last HTTP ${lastHttpStatus ?? "n/a"}, sha "${lastSha}", error: ${lastError}).`,
      );
    }
    await sleepImpl(pollIntervalMs);
  }
}

/**
 * Promotes one verified GHCR digest to Render and verifies the live SHA.
 *
 * @param {{
 *   apiKey: string,
 *   apiBaseUrl?: string,
 *   serviceId: string,
 *   expectedSha: string,
 *   imageRepo: string,
 *   imageDigestRef: string,
 *   healthUrl: string,
 *   getCurrentMainSha: () => Promise<string> | string,
 *   fetchImpl?: typeof fetch,
 *   sleepImpl?: (ms: number) => Promise<void>,
 *   nowImpl?: () => number,
 *   deployTimeoutMs?: number,
 *   healthTimeoutMs?: number,
 *   pollIntervalMs?: number,
 *   logger?: Pick<Console, "log" | "error">,
 * }} params
 */
export async function runRenderDeployment({
  apiKey,
  apiBaseUrl = "https://api.render.com/v1",
  serviceId,
  expectedSha,
  imageRepo,
  imageDigestRef,
  healthUrl,
  getCurrentMainSha,
  fetchImpl = globalThis.fetch,
  sleepImpl = defaultSleep,
  nowImpl = () => Date.now(),
  deployTimeoutMs = 20 * 60 * 1000,
  healthTimeoutMs = 5 * 60 * 1000,
  pollIntervalMs = 10_000,
  logger = console,
}) {
  const sha = normalizeSha(expectedSha, "expectedSha");
  const normalizedServiceId = String(serviceId ?? "").trim();
  if (!SERVICE_ID_RE.test(normalizedServiceId)) {
    throw new RenderDeployError(
      "INVALID_INPUT",
      `RENDER_SERVICE_ID must look like srv-… (got "${serviceId}").`,
    );
  }
  if (!apiKey) {
    throw new RenderDeployError(
      "INVALID_INPUT",
      "RENDER_API_KEY is required for Render deployment.",
    );
  }
  if (typeof getCurrentMainSha !== "function") {
    throw new RenderDeployError(
      "INVALID_INPUT",
      "getCurrentMainSha callback is required.",
    );
  }

  let parsedHealthUrl;
  try {
    parsedHealthUrl = new URL(String(healthUrl ?? ""));
  } catch {
    throw new RenderDeployError(
      "INVALID_INPUT",
      `RENDER_HEALTH_URL must be a valid URL (got "${healthUrl}").`,
    );
  }
  if (parsedHealthUrl.protocol !== "https:") {
    throw new RenderDeployError(
      "INVALID_INPUT",
      "RENDER_HEALTH_URL must use https://.",
    );
  }
  if (parsedHealthUrl.username || parsedHealthUrl.password) {
    throw new RenderDeployError(
      "INVALID_INPUT",
      "RENDER_HEALTH_URL must not contain credentials.",
    );
  }

  const canonicalRepo = normalizeImageRepo(imageRepo, "imageRepo");
  const digest = normalizeDigest(imageDigestRef, "imageDigestRef");
  const imageRef = `ghcr.io/${canonicalRepo}@${digest}`;

  if (String(imageDigestRef).includes("@")) {
    const providedRepository = parseImageRepository(imageDigestRef);
    if (providedRepository !== `ghcr.io/${canonicalRepo}`) {
      throw new RenderDeployError(
        "IMAGE_MISMATCH",
        `IMAGE_DIGEST repository "${providedRepository || "<unparseable>"}" does not match IMAGE_REPO "ghcr.io/${canonicalRepo}".`,
      );
    }
  }

  const summary = {
    expectedSha: sha,
    imageRepo: canonicalRepo,
    imageRef,
    digest,
    serviceId: normalizedServiceId,
    healthUrl: parsedHealthUrl.toString(),
    previousImagePath: null,
    appliedImagePath: null,
    savedImageUpdated: false,
    deployId: null,
    deployStatus: null,
    deployImageRef: null,
    healthHttpStatus: null,
    healthSha: null,
    verified: false,
    restore: null,
    error: null,
  };

  let target = null;

  const assertStillCurrentMain = async () => {
    const currentMainSha = normaliseCurrentMain(await getCurrentMainSha());
    assertFreshMain({ expectedSha: sha, currentMainSha });
    return currentMainSha;
  };

  try {
    await assertStillCurrentMain();

    const service = await renderApi({
      apiKey,
      apiBaseUrl,
      method: "GET",
      path: `/services/${normalizedServiceId}`,
      fetchImpl,
    });
    target = validateRenderService({
      service,
      expectedImageRepo: canonicalRepo,
      expectedServiceId: normalizedServiceId,
    });
    summary.previousImagePath = target.previousImagePath;

    await assertStillCurrentMain();

    const patch = buildServiceImagePatch({ target, imageRef });
    const updatedService = await renderApi({
      apiKey,
      apiBaseUrl,
      method: "PATCH",
      path: `/services/${normalizedServiceId}`,
      body: patch,
      fetchImpl,
    });
    summary.savedImageUpdated = true;

    const updatedImagePath = String(updatedService?.imagePath ?? "");
    if (updatedImagePath !== imageRef) {
      throw new RenderDeployError(
        "IMAGE_MISMATCH",
        `Render saved image reference "${updatedImagePath}", expected "${imageRef}".`,
      );
    }
    summary.appliedImagePath = updatedImagePath;

    await assertStillCurrentMain();

    const deploy = await renderApi({
      apiKey,
      apiBaseUrl,
      method: "POST",
      path: `/services/${normalizedServiceId}/deploys`,
      body: { imageUrl: imageRef },
      fetchImpl,
    });
    if (!deploy?.id) {
      throw new RenderDeployError(
        "RENDER_API_ERROR",
        "Render did not return a deploy id.",
      );
    }

    summary.deployId = String(deploy.id);
    summary.deployStatus = String(deploy.status ?? "unknown");

    const finalDeploy = await waitForDeploy({
      getDeploy: (deployId) =>
        renderApi({
          apiKey,
          apiBaseUrl,
          method: "GET",
          path: `/services/${normalizedServiceId}/deploys/${deployId}`,
          fetchImpl,
        }),
      cancelDeploy: (deployId) =>
        renderApi({
          apiKey,
          apiBaseUrl,
          method: "POST",
          path: `/services/${normalizedServiceId}/deploys/${deployId}/cancel`,
          fetchImpl,
        }),
      getCurrentMainSha: async () =>
        normaliseCurrentMain(await getCurrentMainSha()),
      expectedSha: sha,
      deployId: summary.deployId,
      expectedDigest: digest,
      expectedImageRef: imageRef,
      timeoutMs: deployTimeoutMs,
      pollIntervalMs,
      sleepImpl,
      nowImpl,
      onStatus: (status) => {
        summary.deployStatus = status;
      },
    });

    summary.deployStatus = "live";
    summary.deployImageRef = String(finalDeploy?.image?.ref ?? "");

    const health = await waitForHealth({
      fetchImpl,
      healthUrl: parsedHealthUrl.toString(),
      expectedSha: sha,
      timeoutMs: healthTimeoutMs,
      pollIntervalMs,
      sleepImpl,
      nowImpl,
    });

    summary.healthHttpStatus = health.httpStatus;
    summary.healthSha = health.sha;
    summary.verified = true;
    logger.log(
      `Render deploy ${summary.deployId} is live at ${summary.deployImageRef} and /api/healthz reports ${summary.healthSha}.`,
    );
    return summary;
  } catch (err) {
    summary.error = err instanceof Error ? err.message : String(err);

    if (summary.savedImageUpdated && target) {
      summary.restore = await restorePreviousSavedImage({
        apiKey,
        apiBaseUrl,
        serviceId: normalizedServiceId,
        target,
        appliedImageRef: imageRef,
        fetchImpl,
      });
    }

    if (err && typeof err === "object") {
      err.summary = summary;
    }
    throw err;
  }
}

function normaliseCurrentMain(value) {
  const sha = String(value ?? "").trim().toLowerCase();
  if (!SHA40_RE.test(sha)) {
    throw new RenderDeployError(
      "MAIN_LOOKUP_FAILED",
      `Unable to determine current origin/main SHA (got "${value}").`,
    );
  }
  return sha;
}

async function restorePreviousSavedImage({
  apiKey,
  apiBaseUrl,
  serviceId,
  target,
  appliedImageRef,
  fetchImpl,
}) {
  try {
    const currentService = await renderApi({
      apiKey,
      apiBaseUrl,
      method: "GET",
      path: `/services/${serviceId}`,
      fetchImpl,
    });
    const currentImagePath = String(currentService?.imagePath ?? "");
    if (currentImagePath !== appliedImageRef) {
      return {
        restored: false,
        skipped: true,
        reason: `saved image reference changed to "${currentImagePath}" by another run; not overwriting it`,
      };
    }

    if (!target.previousImagePath) {
      return {
        restored: false,
        skipped: true,
        reason: "previous saved image reference is empty; nothing safe to restore",
      };
    }

    const patch = buildServiceImagePatch({
      target,
      imageRef: target.previousImagePath,
    });
    const restored = await renderApi({
      apiKey,
      apiBaseUrl,
      method: "PATCH",
      path: `/services/${serviceId}`,
      body: patch,
      fetchImpl,
    });
    if (String(restored?.imagePath ?? "") !== target.previousImagePath) {
      throw new Error(
        `Render returned "${restored?.imagePath ?? ""}" instead of "${target.previousImagePath}".`,
      );
    }
    return {
      restored: true,
      skipped: false,
      imagePath: target.previousImagePath,
    };
  } catch (err) {
    return {
      restored: false,
      skipped: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new RenderDeployError(
      "INVALID_INPUT",
      `Missing required environment variable ${name}.`,
    );
  }
  return String(value).trim();
}

async function readOriginMainSha() {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const output = execFileSync(
        "git",
        ["ls-remote", "--exit-code", "origin", "refs/heads/main"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      return normaliseCurrentMain(output.trim().split(/\s+/)[0]);
    } catch (err) {
      lastError = err;
      if (attempt < 3) {
        await defaultSleep(1_000);
      }
    }
  }
  throw new RenderDeployError(
    "MAIN_LOOKUP_FAILED",
    `Unable to read origin/main with git ls-remote: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

function writeStepSummary(summary, success) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;

  const lines = [];
  if (success) {
    lines.push("## Render Deployment Verified");
    lines.push("");
    lines.push(`- **Commit SHA:** \`${summary.expectedSha}\``);
    lines.push(`- **Immutable GHCR Digest:** \`${summary.imageRef}\``);
    lines.push(`- **Render Service:** \`${summary.serviceId}\``);
    lines.push(`- **Saved Render Image Reference:** \`${summary.appliedImagePath}\``);
    lines.push(`- **Render Deploy:** \`${summary.deployId}\` (status: \`${summary.deployStatus}\`)`);
    lines.push(`- **Live Image Reference:** \`${summary.deployImageRef}\``);
    lines.push(`- **/api/healthz:** HTTP \`${summary.healthHttpStatus}\`, full SHA \`${summary.healthSha}\``);
    lines.push("- **Result:** Render reached Live and the live SHA matches the verified main SHA.");
  } else {
    lines.push("## Render Deployment FAILED");
    lines.push("");
    lines.push(`- **Commit SHA:** \`${summary.expectedSha}\``);
    lines.push(`- **Immutable GHCR Digest:** \`${summary.imageRef}\``);
    lines.push(`- **Render Service:** \`${summary.serviceId}\``);
    lines.push(`- **Error:** ${summary.error ?? "unknown error"}`);
    if (summary.previousImagePath) {
      lines.push(`- **Previous Saved Image Reference:** \`${summary.previousImagePath}\``);
    }
    if (summary.appliedImagePath) {
      lines.push(`- **Attempted Saved Image Reference:** \`${summary.appliedImagePath}\``);
    }
    if (summary.deployId) {
      lines.push(`- **Render Deploy:** \`${summary.deployId}\` (last status: \`${summary.deployStatus ?? "unknown"}\`)`);
    }
    if (summary.healthHttpStatus !== null) {
      lines.push(`- **Last /api/healthz:** HTTP \`${summary.healthHttpStatus}\`, sha \`${summary.healthSha || "<missing>"}\``);
    }
    if (summary.restore) {
      if (summary.restore.restored) {
        lines.push(`- **Saved Image Restore:** restored \`${summary.restore.imagePath}\``);
      } else if (summary.restore.skipped) {
        lines.push(`- **Saved Image Restore:** skipped — ${summary.restore.reason}`);
      } else {
        lines.push(`- **Saved Image Restore:** FAILED — ${summary.restore.error ?? "unknown error"}`);
      }
    }
    lines.push("- **Result:** release is NOT verified. Do not report this run as deployed.");
  }

  try {
    fs.appendFileSync(summaryPath, `${lines.join("\n")}\n`, "utf8");
  } catch (err) {
    process.stderr.write(
      `Unable to write GITHUB_STEP_SUMMARY: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

function emptySummary() {
  return {
    expectedSha: process.env.EXPECTED_SHA ?? "",
    imageRef: process.env.IMAGE_DIGEST ?? "",
    serviceId: process.env.RENDER_SERVICE_ID ?? "",
    healthUrl: process.env.RENDER_HEALTH_URL ?? "",
    previousImagePath: null,
    appliedImagePath: null,
    deployId: null,
    deployStatus: null,
    healthHttpStatus: null,
    healthSha: null,
    verified: false,
    restore: null,
    error: "deployment did not start",
  };
}

async function runCli() {
  const mode = process.argv[2];

  if (mode !== "deploy" && mode !== "check-target") {
    throw new RenderDeployError(
      "INVALID_INPUT",
      `Unknown mode "${mode}". Expected "deploy" or "check-target".`,
    );
  }

  const apiKey = requireEnv("RENDER_API_KEY");
  const serviceId = requireEnv("RENDER_SERVICE_ID");
  const expectedSha = requireEnv("EXPECTED_SHA");
  const imageRepo = requireEnv("IMAGE_REPO");
  const imageDigestRef = requireEnv("IMAGE_DIGEST");
  const healthUrl = requireEnv("RENDER_HEALTH_URL");
  const apiBaseUrl =
    process.env.RENDER_API_BASE_URL ?? "https://api.render.com/v1";

  const common = {
    apiKey,
    apiBaseUrl,
    serviceId,
    expectedSha,
    imageRepo,
    imageDigestRef,
    healthUrl,
    getCurrentMainSha: readOriginMainSha,
    deployTimeoutMs: parsePositiveInteger(
      process.env.RENDER_DEPLOY_TIMEOUT_MS,
      20 * 60 * 1000,
    ),
    healthTimeoutMs: parsePositiveInteger(
      process.env.RENDER_HEALTH_TIMEOUT_MS,
      5 * 60 * 1000,
    ),
    pollIntervalMs: parsePositiveInteger(
      process.env.RENDER_POLL_INTERVAL_MS,
      10_000,
    ),
  };

  if (mode === "check-target") {
    const currentMainSha = normaliseCurrentMain(await readOriginMainSha());
    assertFreshMain({ expectedSha, currentMainSha });
    const service = await renderApi({
      apiKey,
      apiBaseUrl,
      method: "GET",
      path: `/services/${serviceId}`,
      fetchImpl: globalThis.fetch,
    });
    const target = validateRenderService({
      service,
      expectedImageRepo: imageRepo,
      expectedServiceId: serviceId,
    });
    const imageRef = buildImageRef({ imageRepo, digest: imageDigestRef });
    process.stdout.write(
      `${JSON.stringify({
        serviceId: target.serviceId,
        dashboardUrl: target.dashboardUrl,
        previousImagePath: target.previousImagePath,
        registryCredentialId: target.registryCredentialId,
        healthCheckPath: target.healthCheckPath,
        expectedImageRef: imageRef,
        currentMainSha,
        mutationPerformed: false,
      })}\n`,
    );
    return;
  }

  try {
    const summary = await runRenderDeployment(common);
    writeStepSummary(summary, true);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } catch (err) {
    const summary =
      err && typeof err === "object" && err.summary
        ? err.summary
        : { ...emptySummary(), error: err instanceof Error ? err.message : String(err) };
    writeStepSummary(summary, false);
    throw err;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli().catch((err) => {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
