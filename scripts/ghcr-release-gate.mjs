#!/usr/bin/env node
/**
 * scripts/ghcr-release-gate.mjs
 *
 * Provenance, CI/Audit gate verification, and retry-safe GHCR tag inspection
 * for manual main-only container image publication (.github/workflows/render-image.yml).
 *
 * Enforces:
 *   1. `verifyMainWorkflowGates`: requires BOTH a completed successful `push`
 *      CI run (`ci.yml`) AND a completed successful Dependency Audit run
 *      (`audit.yml`) on `main` for the exact 40-character expected SHA before
 *      any release image can be published.
 *   2. `inspectExistingGhcrTag`: queries the GHCR OCI Distribution v2 HTTP API
 *      directly so retries never overwrite an existing SHA tag and never
 *      conflate registry authentication (401/403) or network/server errors
 *      (5xx/429/timeout) with a genuinely missing tag (404):
 *        - Genuine missing tag (HTTP 404 NAME_UNKNOWN / MANIFEST_UNKNOWN):
 *          returns `{ status: "missing" }` so the caller may push once.
 *        - Existing tag (HTTP 200): cryptographically verifies manifest/index
 *          and config blob SHA-256 digests plus `linux/amd64`,
 *          `org.opencontainers.image.revision === expectedSha`,
 *          `org.opencontainers.image.source`, and `RABET_BUILD_SHA`.
 *          Returns `{ status: "exists_verified", repoDigest }` so the caller
 *          reuses the immutable digest without pushing or overwriting.
 *          Throws `PROVENANCE_MISMATCH` if any field disagrees.
 *        - Auth / permission failure (401 / 403): throws `REGISTRY_AUTH_ERROR`.
 *        - Network / 5xx / 429 / malformed payload: throws `REGISTRY_NETWORK_ERROR`.
 */

import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const SHA40_RE = /^[0-9a-f]{40}$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;

const ACCEPT_MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

const INDEX_MEDIA_TYPES = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);

export class ReleaseGateError extends Error {
  /**
   * @param {"INVALID_INPUT" | "WORKFLOW_GATE_FAILED" | "REGISTRY_AUTH_ERROR" | "REGISTRY_NETWORK_ERROR" | "PROVENANCE_MISMATCH"} code
   * @param {string} message
   */
  constructor(code, message) {
    super(`[${code}] ${message}`);
    this.name = "ReleaseGateError";
    this.code = code;
  }
}

function sha256Digest(bytes) {
  const hex = crypto.createHash("sha256").update(bytes).digest("hex");
  return `sha256:${hex}`;
}

/**
 * Verifies that the latest matching `ci.yml` (`push` on `main`) and `audit.yml`
 * (`push` or `workflow_dispatch` on `main`) runs for `expectedSha` have both
 * completed with `conclusion === "success"`.
 *
 * @param {{
 *   expectedSha: string,
 *   ciRunsPayload: unknown,
 *   auditRunsPayload: unknown,
 * }} params
 */
export function verifyMainWorkflowGates({
  expectedSha,
  ciRunsPayload,
  auditRunsPayload,
}) {
  const sha = String(expectedSha ?? "").trim().toLowerCase();
  if (!SHA40_RE.test(sha)) {
    throw new ReleaseGateError(
      "INVALID_INPUT",
      `expectedSha must be a 40-character lowercase hex SHA (got "${expectedSha}").`,
    );
  }

  const ciRuns = Array.isArray(ciRunsPayload?.workflow_runs)
    ? ciRunsPayload.workflow_runs
    : [];
  const matchingCi = ciRuns.filter(
    (r) =>
      r?.head_sha?.toLowerCase() === sha &&
      r?.head_branch === "main" &&
      r?.event === "push",
  );

  if (matchingCi.length === 0) {
    throw new ReleaseGateError(
      "WORKFLOW_GATE_FAILED",
      `Refusing to publish: no push CI workflow run found on main for SHA ${sha}.`,
    );
  }

  const latestCi = matchingCi[0];
  if (latestCi.status !== "completed" || latestCi.conclusion !== "success") {
    throw new ReleaseGateError(
      "WORKFLOW_GATE_FAILED",
      `Refusing to publish: latest push CI run on main (${latestCi.html_url ?? "unknown URL"}) has status="${latestCi.status}", conclusion="${latestCi.conclusion}".`,
    );
  }

  const auditRuns = Array.isArray(auditRunsPayload?.workflow_runs)
    ? auditRunsPayload.workflow_runs
    : [];
  const matchingAudit = auditRuns.filter(
    (r) =>
      r?.head_sha?.toLowerCase() === sha &&
      r?.head_branch === "main" &&
      (r?.event === "push" || r?.event === "workflow_dispatch"),
  );

  if (matchingAudit.length === 0) {
    throw new ReleaseGateError(
      "WORKFLOW_GATE_FAILED",
      `Refusing to publish: no Dependency Audit workflow run found on main for SHA ${sha}.`,
    );
  }

  const latestAudit = matchingAudit[0];
  if (latestAudit.status !== "completed" || latestAudit.conclusion !== "success") {
    throw new ReleaseGateError(
      "WORKFLOW_GATE_FAILED",
      `Refusing to publish: latest Dependency Audit run on main (${latestAudit.html_url ?? "unknown URL"}) has status="${latestAudit.status}", conclusion="${latestAudit.conclusion}".`,
    );
  }

  return {
    verifiedSha: sha,
    ciRunUrl: String(latestCi.html_url),
    auditRunUrl: String(latestAudit.html_url),
  };
}

async function registryFetch(fetchImpl, url, init, timeoutMs) {
  try {
    return await fetchImpl(url, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ReleaseGateError(
      "REGISTRY_NETWORK_ERROR",
      `Network error contacting GHCR (${url}): ${detail}`,
    );
  }
}

async function fetchVerifiedJsonByDigest(fetchImpl, url, expectedDigest, token, accept, timeoutMs) {
  if (!DIGEST_RE.test(expectedDigest ?? "")) {
    throw new ReleaseGateError(
      "PROVENANCE_MISMATCH",
      `Invalid content digest reference in remote manifest: "${expectedDigest}".`,
    );
  }

  const res = await registryFetch(
    fetchImpl,
    url,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(accept ? { Accept: accept } : {}),
      },
    },
    timeoutMs,
  );

  if (res.status === 401 || res.status === 403) {
    throw new ReleaseGateError(
      "REGISTRY_AUTH_ERROR",
      `GHCR rejected read of ${url} with HTTP ${res.status}.`,
    );
  }
  if (!res.ok) {
    throw new ReleaseGateError(
      "REGISTRY_NETWORK_ERROR",
      `Unexpected HTTP ${res.status} from GHCR while reading ${url}.`,
    );
  }

  const rawBytes = Buffer.from(await res.arrayBuffer());
  const actualDigest = sha256Digest(rawBytes);
  if (actualDigest !== expectedDigest) {
    throw new ReleaseGateError(
      "PROVENANCE_MISMATCH",
      `Digest mismatch reading ${url}: expected ${expectedDigest}, computed ${actualDigest}.`,
    );
  }

  try {
    return JSON.parse(rawBytes.toString("utf8"));
  } catch (err) {
    throw new ReleaseGateError(
      "REGISTRY_NETWORK_ERROR",
      `Invalid JSON returned by GHCR at ${url}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Inspects GHCR for an existing `sha-<expectedSha>` tag before pushing.
 *
 * @param {{
 *   registryBaseUrl?: string,
 *   repoPath: string,
 *   tagName: string,
 *   expectedSha: string,
 *   expectedSourceUrl: string,
 *   actor: string,
 *   githubToken: string,
 *   fetchImpl?: typeof fetch,
 *   timeoutMs?: number,
 * }} params
 * @returns {Promise<
 *   | { status: "missing" }
 *   | { status: "exists_verified", repoDigest: string, digest: string }
 * >}
 */
export async function inspectExistingGhcrTag({
  registryBaseUrl = "https://ghcr.io",
  repoPath,
  tagName,
  expectedSha,
  expectedSourceUrl,
  actor,
  githubToken,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
}) {
  const normalizedSha = String(expectedSha ?? "").trim().toLowerCase();
  if (!SHA40_RE.test(normalizedSha)) {
    throw new ReleaseGateError(
      "INVALID_INPUT",
      `expectedSha must be a 40-char lowercase hex SHA (got "${expectedSha}").`,
    );
  }
  const normalizedRepo = String(repoPath ?? "").trim().toLowerCase();
  if (!/^[a-z0-9._-]+(\/[a-z0-9._-]+)+$/.test(normalizedRepo)) {
    throw new ReleaseGateError(
      "INVALID_INPUT",
      `repoPath must be a lowercase OCI repository path (got "${repoPath}").`,
    );
  }
  if (!actor || !githubToken) {
    throw new ReleaseGateError(
      "REGISTRY_AUTH_ERROR",
      "Missing GitHub actor or token for GHCR authentication.",
    );
  }

  const base = registryBaseUrl.replace(/\/+$/, "");
  const basicAuth = Buffer.from(`${actor}:${githubToken}`, "utf8").toString("base64");

  // 1. Authenticate against GHCR token service with repository pull,push scope.
  //    Valid credentials + `packages:write` return 200 even before first push.
  const tokenUrl =
    `${base}/token?service=ghcr.io&scope=` +
    encodeURIComponent(`repository:${normalizedRepo}:pull,push`);
  const tokenRes = await registryFetch(
    fetchImpl,
    tokenUrl,
    {
      method: "GET",
      headers: { Authorization: `Basic ${basicAuth}` },
    },
    timeoutMs,
  );

  if (tokenRes.status === 401 || tokenRes.status === 403) {
    throw new ReleaseGateError(
      "REGISTRY_AUTH_ERROR",
      `GHCR token exchange failed with HTTP ${tokenRes.status} for repository ${normalizedRepo}.`,
    );
  }
  if (!tokenRes.ok) {
    throw new ReleaseGateError(
      "REGISTRY_NETWORK_ERROR",
      `GHCR token endpoint returned HTTP ${tokenRes.status}.`,
    );
  }

  let bearerToken = "";
  try {
    const tokenJson = await tokenRes.json();
    bearerToken = String(tokenJson?.token ?? tokenJson?.access_token ?? "");
  } catch (err) {
    throw new ReleaseGateError(
      "REGISTRY_NETWORK_ERROR",
      `Malformed JSON from GHCR token endpoint: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!bearerToken) {
    throw new ReleaseGateError(
      "REGISTRY_AUTH_ERROR",
      "GHCR token endpoint returned an empty bearer token.",
    );
  }

  // 2. Query manifest for exact SHA tag.
  const manifestUrl = `${base}/v2/${normalizedRepo}/manifests/${encodeURIComponent(tagName)}`;
  const manifestRes = await registryFetch(
    fetchImpl,
    manifestUrl,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        Accept: ACCEPT_MANIFEST_TYPES,
      },
    },
    timeoutMs,
  );

  if (manifestRes.status === 401 || manifestRes.status === 403) {
    throw new ReleaseGateError(
      "REGISTRY_AUTH_ERROR",
      `GHCR manifest lookup rejected credentials/permissions with HTTP ${manifestRes.status} for ${normalizedRepo}:${tagName}.`,
    );
  }

  if (manifestRes.status === 404) {
    // Distinguish genuine OCI NAME_UNKNOWN / MANIFEST_UNKNOWN 404 from unexpected proxy errors
    const text = await manifestRes.text().catch(() => "");
    if (text.trim().length > 0) {
      try {
        const parsedErr = JSON.parse(text);
        const codes = Array.isArray(parsedErr?.errors)
          ? parsedErr.errors.map((e) => String(e?.code ?? ""))
          : [];
        const allowedCodes = new Set(["MANIFEST_UNKNOWN", "NAME_UNKNOWN"]);
        if (codes.length > 0 && !codes.every((c) => allowedCodes.has(c))) {
          throw new ReleaseGateError(
            "REGISTRY_NETWORK_ERROR",
            `Unexpected 404 error codes from GHCR for ${normalizedRepo}:${tagName}: ${codes.join(", ")}`,
          );
        }
      } catch (err) {
        if (err instanceof ReleaseGateError) throw err;
        // Non-JSON 404 body from an intermediate proxy cannot be trusted as an OCI manifest miss
        throw new ReleaseGateError(
          "REGISTRY_NETWORK_ERROR",
          `Non-OCI 404 response from GHCR while checking ${normalizedRepo}:${tagName}.`,
        );
      }
    }
    return { status: "missing" };
  }

  if (!manifestRes.ok) {
    throw new ReleaseGateError(
      "REGISTRY_NETWORK_ERROR",
      `GHCR manifest lookup failed with HTTP ${manifestRes.status} for ${normalizedRepo}:${tagName}.`,
    );
  }

  // 3. Tag exists (HTTP 200): compute & verify top-level digest and inspect config provenance.
  const rawManifestBytes = Buffer.from(await manifestRes.arrayBuffer());
  const computedTopDigest = sha256Digest(rawManifestBytes);
  const headerDigest = manifestRes.headers.get("docker-content-digest");
  if (headerDigest && headerDigest !== computedTopDigest) {
    throw new ReleaseGateError(
      "PROVENANCE_MISMATCH",
      `Top-level Docker-Content-Digest (${headerDigest}) disagrees with computed SHA-256 (${computedTopDigest}).`,
    );
  }

  let topDoc;
  try {
    topDoc = JSON.parse(rawManifestBytes.toString("utf8"));
  } catch (err) {
    throw new ReleaseGateError(
      "REGISTRY_NETWORK_ERROR",
      `Malformed manifest JSON for existing tag ${normalizedRepo}:${tagName}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const contentType = (
    topDoc?.mediaType ??
    manifestRes.headers.get("content-type")?.split(";")[0]?.trim() ??
    ""
  ).toLowerCase();

  let imageManifest = topDoc;
  if (INDEX_MEDIA_TYPES.has(contentType) || Array.isArray(topDoc?.manifests)) {
    const entries = Array.isArray(topDoc?.manifests) ? topDoc.manifests : [];
    const amd64Entry = entries.find(
      (m) =>
        m?.platform?.os === "linux" &&
        m?.platform?.architecture === "amd64" &&
        m?.annotations?.["vnd.docker.reference.type"] !== "attestation-manifest",
    );
    if (!amd64Entry?.digest) {
      throw new ReleaseGateError(
        "PROVENANCE_MISMATCH",
        `Existing tag ${normalizedRepo}:${tagName} index contains no runnable linux/amd64 image manifest.`,
      );
    }
    imageManifest = await fetchVerifiedJsonByDigest(
      fetchImpl,
      `${base}/v2/${normalizedRepo}/manifests/${amd64Entry.digest}`,
      amd64Entry.digest,
      bearerToken,
      ACCEPT_MANIFEST_TYPES,
      timeoutMs,
    );
  }

  const configDigest = imageManifest?.config?.digest;
  if (!configDigest) {
    throw new ReleaseGateError(
      "PROVENANCE_MISMATCH",
      `Existing tag ${normalizedRepo}:${tagName} manifest has no config blob digest.`,
    );
  }

  const imageConfig = await fetchVerifiedJsonByDigest(
    fetchImpl,
    `${base}/v2/${normalizedRepo}/blobs/${configDigest}`,
    configDigest,
    bearerToken,
    "application/vnd.oci.image.config.v1+json, application/vnd.docker.container.image.v1+json",
    timeoutMs,
  );

  if (imageConfig?.os !== "linux" || imageConfig?.architecture !== "amd64") {
    throw new ReleaseGateError(
      "PROVENANCE_MISMATCH",
      `Existing tag ${normalizedRepo}:${tagName} has platform ${imageConfig?.os}/${imageConfig?.architecture}, expected linux/amd64.`,
    );
  }

  const labels = imageConfig?.config?.Labels ?? {};
  const remoteRevision = String(
    labels["org.opencontainers.image.revision"] ?? "",
  ).toLowerCase();
  if (remoteRevision !== normalizedSha) {
    throw new ReleaseGateError(
      "PROVENANCE_MISMATCH",
      `Existing tag ${normalizedRepo}:${tagName} has revision label "${remoteRevision}", expected "${normalizedSha}". Refusing to overwrite or reuse.`,
    );
  }

  const remoteSource = String(
    labels["org.opencontainers.image.source"] ?? "",
  ).toLowerCase();
  if (remoteSource !== String(expectedSourceUrl ?? "").trim().toLowerCase()) {
    throw new ReleaseGateError(
      "PROVENANCE_MISMATCH",
      `Existing tag ${normalizedRepo}:${tagName} has source label "${remoteSource}", expected "${expectedSourceUrl}".`,
    );
  }

  const envList = Array.isArray(imageConfig?.config?.Env) ? imageConfig.config.Env : [];
  if (!envList.includes(`RABET_BUILD_SHA=${normalizedSha}`)) {
    throw new ReleaseGateError(
      "PROVENANCE_MISMATCH",
      `Existing tag ${normalizedRepo}:${tagName} config Env does not carry RABET_BUILD_SHA=${normalizedSha}.`,
    );
  }

  return {
    status: "exists_verified",
    digest: computedTopDigest,
    repoDigest: `ghcr.io/${normalizedRepo}@${computedTopDigest}`,
  };
}

async function runCli() {
  const mode = process.argv[2];

  if (mode === "verify-workflows") {
    const expectedSha = process.env.VERIFIED_SHA ?? "";
    const ciRunsPayload = JSON.parse(process.env.CI_RUNS_JSON ?? "{}");
    const auditRunsPayload = JSON.parse(process.env.AUDIT_RUNS_JSON ?? "{}");
    const res = verifyMainWorkflowGates({
      expectedSha,
      ciRunsPayload,
      auditRunsPayload,
    });
    process.stdout.write(`${JSON.stringify(res)}\n`);
    return;
  }

  if (mode === "check-ghcr-tag") {
    const res = await inspectExistingGhcrTag({
      repoPath: process.env.GHCR_REPO_PATH ?? "",
      tagName: process.env.GHCR_TAG_NAME ?? "",
      expectedSha: process.env.VERIFIED_SHA ?? "",
      expectedSourceUrl: process.env.EXPECTED_SOURCE_URL ?? "",
      actor: process.env.GHCR_ACTOR ?? "",
      githubToken: process.env.GHCR_TOKEN ?? "",
    });
    process.stdout.write(`${JSON.stringify(res)}\n`);
    return;
  }

  throw new Error(
    `Unknown mode "${mode}". Expected "verify-workflows" or "check-ghcr-tag".`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli().catch((err) => {
    process.stderr.write(
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
