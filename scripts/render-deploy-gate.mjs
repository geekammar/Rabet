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

// Paths that define the production Drizzle migration inputs. Automatic
// promotion is refused when these differ from the currently live revision.
export const MIGRATION_INPUT_PATHS = Object.freeze([
  "drizzle",
  "drizzle.config.ts",
]);

export class RenderDeployError extends Error {
  /**
   * @param {"INVALID_INPUT" | "STALE_MAIN" | "MAIN_LOOKUP_FAILED" | "SERVICE_MISMATCH" | "IMAGE_MISMATCH" | "RENDER_API_ERROR" | "DEPLOY_FAILED" | "DEPLOY_TIMEOUT" | "HEALTH_MISMATCH" | "LIVE_REVISION_UNKNOWN" | "MIGRATION_CHANGED" | "MIGRATION_COMPARISON_FAILED"} code
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
  expectedConfigDigest,
}) {
  const expectedManifestDigest = normalizeDigest(expectedDigest, "expectedDigest");
  const expectedRef = String(expectedImageRef ?? "").trim().toLowerCase();
  if (!expectedRef) {
    throw new RenderDeployError(
      "INVALID_INPUT",
      "expectedImageRef is required to verify the pinned Render image reference.",
    );
  }
  const expectedConfig = expectedConfigDigest
    ? normalizeDigest(expectedConfigDigest, "expectedConfigDigest")
    : null;

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

  // Render's image.ref is the reference used for the deploy. Because this
  // workflow always deploys an immutable @sha256:<manifest digest> reference,
  // this must carry the exact expected pinned reference. Render's image.sha is
  // allowed to be the pulled image ID (config digest), which is NOT the same
  // digest as the registry manifest; do not prioritise it over image.ref.
  const actualRef = String(image.ref ?? "").trim().toLowerCase();
  if (!actualRef) {
    throw new RenderDeployError(
      "IMAGE_MISMATCH",
      `Render deploy ${deploy.id ?? "<unknown>"} did not report a pinned image reference (image.ref).`,
    );
  }
  if (actualRef !== expectedRef) {
    throw new RenderDeployError(
      "IMAGE_MISMATCH",
      `Render deploy ${deploy.id ?? "<unknown>"} used image reference "${image.ref}", expected "${expectedImageRef}".`,
    );
  }

  let referenceDigest;
  try {
    referenceDigest = normalizeDigest(actualRef, "deploy image.ref");
  } catch (err) {
    throw new RenderDeployError(
      "IMAGE_MISMATCH",
      `Render deploy ${deploy.id ?? "<unknown>"} image.ref is not a pinned sha256 reference: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (referenceDigest !== expectedManifestDigest) {
    throw new RenderDeployError(
      "IMAGE_MISMATCH",
      `Render deploy ${deploy.id ?? "<unknown>"} pinned reference digest ${referenceDigest}, expected manifest digest ${expectedManifestDigest}.`,
    );
  }

  const rawImageSha = String(image.sha ?? "").trim().toLowerCase();
  let imageSha = null;
  if (rawImageSha) {
    try {
      imageSha = normalizeDigest(rawImageSha, "deploy image.sha");
    } catch (err) {
      throw new RenderDeployError(
        "IMAGE_MISMATCH",
        `Render deploy ${deploy.id ?? "<unknown>"} image.sha is not a sha256 digest: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (
      expectedConfig &&
      imageSha !== expectedConfig &&
      imageSha !== expectedManifestDigest
    ) {
      throw new RenderDeployError(
        "IMAGE_MISMATCH",
        `Render deploy ${deploy.id ?? "<unknown>"} image.sha ${imageSha} does not match the GHCR config digest ${expectedConfig} (or manifest digest ${expectedManifestDigest}).`,
      );
    }
  }

  return {
    pinnedRef: actualRef,
    manifestDigest: expectedManifestDigest,
    imageSha,
  };
}

export function readHealthRevision({ httpStatus, payload }) {
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
  return reportedSha;
}

export function verifyHealthPayload({ httpStatus, payload, expectedSha }) {
  const sha = normalizeSha(expectedSha, "expectedSha");
  const reportedSha = readHealthRevision({ httpStatus, payload });
  if (reportedSha !== sha) {
    throw new RenderDeployError(
      "HEALTH_MISMATCH",
      `GET /api/healthz reported sha ${reportedSha}, expected ${sha}.`,
    );
  }
  return { status: "ok", sha: reportedSha };
}

export function assertNoMigrationChanges({
  liveSha,
  expectedSha,
  changedPaths,
}) {
  const live = normalizeSha(liveSha, "liveSha");
  const expected = normalizeSha(expectedSha, "expectedSha");
  if (live === expected) {
    return {
      liveSha: live,
      expectedSha: expected,
      changedPaths: [],
      migrationChanges: [],
    };
  }
  if (!Array.isArray(changedPaths)) {
    throw new RenderDeployError(
      "MIGRATION_COMPARISON_FAILED",
      `Cannot compare migration inputs between live revision ${live} and ${expected}: changed paths were not established.`,
    );
  }

  const paths = changedPaths
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  const migrationChanges = paths.filter(
    (file) =>
      file === "drizzle" ||
      file === "drizzle.config.ts" ||
      file.startsWith("drizzle/"),
  );

  if (migrationChanges.length > 0) {
    throw new RenderDeployError(
      "MIGRATION_CHANGED",
      `Automatic promotion is blocked: migration inputs differ between live revision ${live} and ${expected} (${migrationChanges.join(", ")}). Use the owner-approved manual migration and release path.`,
    );
  }

  return {
    liveSha: live,
    expectedSha: expected,
    changedPaths: paths,
    migrationChanges: [],
  };
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
  expectedConfigDigest,
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
      const verifiedImage = verifyDeployImage({
        deploy,
        expectedDigest,
        expectedImageRef,
        expectedConfigDigest,
      });
      return { deploy, verifiedImage };
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

async function waitForLiveRevision({
  fetchImpl,
  healthUrl,
  timeoutMs,
  pollIntervalMs,
  sleepImpl,
  nowImpl,
}) {
  const deadline = nowImpl() + timeoutMs;
  let lastError = "no health response received";

  while (true) {
    try {
      const res = await fetchImpl(healthUrl, {
        method: "GET",
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
        signal: AbortSignal.timeout(15_000),
      });
      const text = await res.text();
      let payload = null;
      if (text.trim()) {
        try {
          payload = JSON.parse(text);
        } catch {
          payload = null;
        }
      }
      return readHealthRevision({ httpStatus: res.status, payload });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    if (nowImpl() >= deadline) {
      throw new RenderDeployError(
        "LIVE_REVISION_UNKNOWN",
        `Cannot establish the currently live revision from /api/healthz: ${lastError}`,
      );
    }
    await sleepImpl(pollIntervalMs);
  }
}

function readChangedMigrationPaths({ liveSha, expectedSha }) {
  const live = normalizeSha(liveSha, "liveSha");
  const expected = normalizeSha(expectedSha, "expectedSha");
  if (live === expected) return [];

  try {
    execFileSync(
      "git",
      ["fetch", "--no-tags", "--depth=1", "origin", live],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (err) {
    throw new RenderDeployError(
      "MIGRATION_COMPARISON_FAILED",
      `Unable to fetch live revision ${live} for migration comparison: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    const output = execFileSync(
      "git",
      [
        "diff",
        "--name-only",
        live,
        expected,
        "--",
        ...MIGRATION_INPUT_PATHS,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (err) {
    throw new RenderDeployError(
      "MIGRATION_COMPARISON_FAILED",
      `Unable to compare migration inputs between ${live} and ${expected}: ${err instanceof Error ? err.message : String(err)}`,
    );
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
 *   imageConfigDigest?: string,
 *   healthUrl: string,
 *   promotionMode?: "automatic" | "manual",
 *   getCurrentMainSha: () => Promise<string> | string,
 *   getLiveRevision?: () => Promise<string> | string,
 *   getChangedPaths?: (params: { liveSha: string, expectedSha: string }) => Promise<string[]> | string[],
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
  imageConfigDigest,
  healthUrl,
  promotionMode = "manual",
  getCurrentMainSha,
  getLiveRevision,
  getChangedPaths,
  fetchImpl = globalThis.fetch,
  sleepImpl = defaultSleep,
  nowImpl = () => Date.now(),
  deployTimeoutMs = 20 * 60 * 1000,
  healthTimeoutMs = 5 * 60 * 1000,
  pollIntervalMs = 10_000,
  logger = console,
}) {
  const sha = normalizeSha(expectedSha, "expectedSha");
  const mode = String(promotionMode ?? "").trim().toLowerCase();
  if (mode !== "automatic" && mode !== "manual") {
    throw new RenderDeployError(
      "INVALID_INPUT",
      `promotionMode must be "automatic" or "manual" (got "${promotionMode}").`,
    );
  }
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
  const configDigest = imageConfigDigest
    ? normalizeDigest(imageConfigDigest, "imageConfigDigest")
    : null;
  const imageRef = `ghcr.io/${canonicalRepo}@${digest}`;

  if (mode === "automatic" && !configDigest) {
    throw new RenderDeployError(
      "INVALID_INPUT",
      "IMAGE_CONFIG_DIGEST is required for automatic promotion so Render's resolved image.sha can be cross-checked.",
    );
  }
  if (mode === "automatic" && typeof getLiveRevision !== "function") {
    throw new RenderDeployError(
      "INVALID_INPUT",
      "getLiveRevision callback is required for automatic promotion.",
    );
  }
  if (mode === "automatic" && typeof getChangedPaths !== "function") {
    throw new RenderDeployError(
      "INVALID_INPUT",
      "getChangedPaths callback is required for automatic promotion.",
    );
  }

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
    promotionMode: mode,
    imageRepo: canonicalRepo,
    imageRef,
    digest,
    configDigest,
    serviceId: normalizedServiceId,
    healthUrl: parsedHealthUrl.toString(),
    liveShaBefore: null,
    migrationCheck: null,
    previousImagePath: null,
    appliedImagePath: null,
    savedImageUpdated: false,
    deployId: null,
    deployStatus: null,
    deployImageRef: null,
    deployImageSha: null,
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

  const assertMigrationException = async () => {
    if (mode === "manual") {
      summary.migrationCheck = {
        skipped: true,
        reason: "owner-approved manual promotion path",
      };
      logger.log(
        "Manual promotion path: migration comparison is owner-managed; automatic migration exception is not applied.",
      );
      return;
    }

    let liveSha;
    try {
      liveSha = normalizeSha(await getLiveRevision(), "live revision");
    } catch (err) {
      if (err instanceof RenderDeployError && err.code === "LIVE_REVISION_UNKNOWN") {
        throw err;
      }
      throw new RenderDeployError(
        "LIVE_REVISION_UNKNOWN",
        `Cannot establish the currently live revision for migration comparison: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    summary.liveShaBefore = liveSha;

    let changedPaths;
    try {
      changedPaths =
        liveSha === sha
          ? []
          : await getChangedPaths({ liveSha, expectedSha: sha });
    } catch (err) {
      if (
        err instanceof RenderDeployError &&
        err.code === "MIGRATION_COMPARISON_FAILED"
      ) {
        throw err;
      }
      throw new RenderDeployError(
        "MIGRATION_COMPARISON_FAILED",
        `Cannot compare migration inputs between live revision ${liveSha} and ${sha}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    summary.migrationCheck = assertNoMigrationChanges({
      liveSha,
      expectedSha: sha,
      changedPaths,
    });
    logger.log(
      liveSha === sha
        ? `Migration check passed: live revision already equals ${sha}.`
        : `Migration check passed: no migration input changes between live ${liveSha} and ${sha}.`,
    );
  };

  try {
    await assertStillCurrentMain();
    await assertMigrationException();

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

    const { verifiedImage } = await waitForDeploy({
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
      expectedConfigDigest: configDigest,
      timeoutMs: deployTimeoutMs,
      pollIntervalMs,
      sleepImpl,
      nowImpl,
      onStatus: (status) => {
        summary.deployStatus = status;
      },
    });

    summary.deployStatus = "live";
    summary.deployImageRef = verifiedImage.pinnedRef;
    summary.deployImageSha = verifiedImage.imageSha;

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
    lines.push(`- **Promotion Mode:** \`${summary.promotionMode ?? "unknown"}\``);
    lines.push(`- **Immutable GHCR Digest:** \`${summary.imageRef}\``);
    lines.push(`- **GHCR Config Digest:** \`${summary.configDigest ?? "<not provided>"}\``);
    lines.push(`- **Render Service:** \`${summary.serviceId}\``);
    lines.push(`- **Saved Render Image Reference:** \`${summary.appliedImagePath}\``);
    if (summary.liveShaBefore) {
      lines.push(`- **Live Revision Before:** \`${summary.liveShaBefore}\``);
    }
    if (summary.migrationCheck?.skipped) {
      lines.push(`- **Migration Check:** skipped — ${summary.migrationCheck.reason}`);
    } else if (summary.migrationCheck) {
      lines.push(`- **Migration Check:** passed against live revision \`${summary.migrationCheck.liveSha}\``);
    }
    lines.push(`- **Render Deploy:** \`${summary.deployId}\` (status: \`${summary.deployStatus}\`)`);
    lines.push(`- **Live Image Reference:** \`${summary.deployImageRef}\``);
    lines.push(`- **Live Render image.sha:** \`${summary.deployImageSha ?? "<missing>"}\``);
    lines.push(`- **/api/healthz:** HTTP \`${summary.healthHttpStatus}\`, full SHA \`${summary.healthSha}\``);
    lines.push("- **Result:** Render reached Live and the live SHA matches the verified main SHA.");
  } else {
    lines.push("## Render Deployment FAILED");
    lines.push("");
    lines.push(`- **Commit SHA:** \`${summary.expectedSha}\``);
    lines.push(`- **Promotion Mode:** \`${summary.promotionMode ?? "unknown"}\``);
    lines.push(`- **Immutable GHCR Digest:** \`${summary.imageRef}\``);
    lines.push(`- **GHCR Config Digest:** \`${summary.configDigest ?? "<not provided>"}\``);
    lines.push(`- **Render Service:** \`${summary.serviceId}\``);
    lines.push(`- **Error:** ${summary.error ?? "unknown error"}`);
    if (summary.liveShaBefore) {
      lines.push(`- **Live Revision Before:** \`${summary.liveShaBefore}\``);
    }
    if (summary.migrationCheck?.skipped) {
      lines.push(`- **Migration Check:** skipped — ${summary.migrationCheck.reason}`);
    } else if (summary.migrationCheck) {
      lines.push(`- **Migration Check:** passed against live revision \`${summary.migrationCheck.liveSha}\``);
    }
    if (summary.previousImagePath) {
      lines.push(`- **Previous Saved Image Reference:** \`${summary.previousImagePath}\``);
    }
    if (summary.appliedImagePath) {
      lines.push(`- **Attempted Saved Image Reference:** \`${summary.appliedImagePath}\``);
    }
    if (summary.deployId) {
      lines.push(`- **Render Deploy:** \`${summary.deployId}\` (last status: \`${summary.deployStatus ?? "unknown"}\`)`);
    }
    if (summary.deployImageRef) {
      lines.push(`- **Live/Pinned Image Reference:** \`${summary.deployImageRef}\``);
    }
    if (summary.deployImageSha) {
      lines.push(`- **Live Render image.sha:** \`${summary.deployImageSha}\``);
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
    promotionMode: process.env.RENDER_PROMOTION_MODE ?? "unknown",
    imageRef: process.env.IMAGE_DIGEST ?? "",
    configDigest: process.env.IMAGE_CONFIG_DIGEST ?? null,
    serviceId: process.env.RENDER_SERVICE_ID ?? "",
    healthUrl: process.env.RENDER_HEALTH_URL ?? "",
    liveShaBefore: null,
    migrationCheck: null,
    previousImagePath: null,
    appliedImagePath: null,
    deployId: null,
    deployStatus: null,
    deployImageRef: null,
    deployImageSha: null,
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
  const promotionMode = String(
    process.env.RENDER_PROMOTION_MODE ?? "manual",
  ).toLowerCase();
  const imageConfigDigest = String(
    process.env.IMAGE_CONFIG_DIGEST ?? "",
  ).trim();
  if (mode === "deploy" && !imageConfigDigest) {
    throw new RenderDeployError(
      "INVALID_INPUT",
      "IMAGE_CONFIG_DIGEST is required for deployment verification.",
    );
  }

  const deployTimeoutMs = parsePositiveInteger(
    process.env.RENDER_DEPLOY_TIMEOUT_MS,
    20 * 60 * 1000,
  );
  const healthTimeoutMs = parsePositiveInteger(
    process.env.RENDER_HEALTH_TIMEOUT_MS,
    5 * 60 * 1000,
  );
  const liveRevisionTimeoutMs = parsePositiveInteger(
    process.env.RENDER_LIVE_REVISION_TIMEOUT_MS,
    60_000,
  );
  const pollIntervalMs = parsePositiveInteger(
    process.env.RENDER_POLL_INTERVAL_MS,
    10_000,
  );

  const common = {
    apiKey,
    apiBaseUrl,
    serviceId,
    expectedSha,
    imageRepo,
    imageDigestRef,
    imageConfigDigest: imageConfigDigest || undefined,
    healthUrl,
    promotionMode,
    getCurrentMainSha: readOriginMainSha,
    getLiveRevision: () =>
      waitForLiveRevision({
        fetchImpl: globalThis.fetch,
        healthUrl,
        timeoutMs: liveRevisionTimeoutMs,
        pollIntervalMs,
        sleepImpl: defaultSleep,
        nowImpl: () => Date.now(),
      }),
    getChangedPaths: async ({ liveSha, expectedSha: targetSha }) =>
      readChangedMigrationPaths({
        liveSha,
        expectedSha: targetSha,
      }),
    deployTimeoutMs,
    healthTimeoutMs,
    pollIntervalMs,
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
        autoDeploy: service.autoDeploy ?? null,
        autoDeployTrigger: service.autoDeployTrigger ?? null,
        suspended: service.suspended ?? null,
        runtime: service.serviceDetails?.runtime ?? service.serviceDetails?.env ?? null,
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
