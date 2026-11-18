import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  inspectExistingGhcrTag,
  ReleaseGateError,
  verifyMainWorkflowGates,
  waitForMainWorkflowGates,
} from "../scripts/ghcr-release-gate.mjs";

const SAMPLE_SHA = "f30a29d66ecad4f174195e04f71a791d2c782fc2";
const SOURCE_URL = "https://github.com/geekammar/Rabet";

function sha256(str: string): string {
  return `sha256:${crypto.createHash("sha256").update(str, "utf8").digest("hex")}`;
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(raw, {
    status,
    headers: {
      "content-type": "application/json",
      ...headers,
    },
  });
}

describe("verifyMainWorkflowGates", () => {
  const greenCi = {
    workflow_runs: [
      {
        head_sha: SAMPLE_SHA,
        head_branch: "main",
        event: "push",
        status: "completed",
        conclusion: "success",
        html_url: "https://github.com/geekammar/Rabet/actions/runs/1001",
      },
    ],
  };

  const greenAudit = {
    workflow_runs: [
      {
        head_sha: SAMPLE_SHA,
        head_branch: "main",
        event: "push",
        status: "completed",
        conclusion: "success",
        html_url: "https://github.com/geekammar/Rabet/actions/runs/1002",
      },
    ],
  };

  it("accepts when both push CI and Dependency Audit succeeded on main for exact SHA", () => {
    const res = verifyMainWorkflowGates({
      expectedSha: SAMPLE_SHA,
      ciRunsPayload: greenCi,
      auditRunsPayload: greenAudit,
    });

    expect(res).toEqual({
      verifiedSha: SAMPLE_SHA,
      ciRunUrl: "https://github.com/geekammar/Rabet/actions/runs/1001",
      auditRunUrl: "https://github.com/geekammar/Rabet/actions/runs/1002",
    });
  });

  it("rejects when push CI run is missing or only a pull_request CI run exists", () => {
    expect(() =>
      verifyMainWorkflowGates({
        expectedSha: SAMPLE_SHA,
        ciRunsPayload: {
          workflow_runs: [
            {
              head_sha: SAMPLE_SHA,
              head_branch: "main",
              event: "pull_request",
              status: "completed",
              conclusion: "success",
              html_url: "https://github.com/geekammar/Rabet/actions/runs/999",
            },
          ],
        },
        auditRunsPayload: greenAudit,
      }),
    ).toThrow(/no push CI workflow run found/);
  });

  it("rejects when Dependency Audit run is missing, in_progress, or failed", () => {
    expect(() =>
      verifyMainWorkflowGates({
        expectedSha: SAMPLE_SHA,
        ciRunsPayload: greenCi,
        auditRunsPayload: { workflow_runs: [] },
      }),
    ).toThrow(/no Dependency Audit workflow run found/);

    expect(() =>
      verifyMainWorkflowGates({
        expectedSha: SAMPLE_SHA,
        ciRunsPayload: greenCi,
        auditRunsPayload: {
          workflow_runs: [
            {
              head_sha: SAMPLE_SHA,
              head_branch: "main",
              event: "push",
              status: "completed",
              conclusion: "failure",
              html_url: "https://github.com/geekammar/Rabet/actions/runs/1003",
            },
          ],
        },
      }),
    ).toThrow(/latest Dependency Audit run on main .* conclusion="failure"/);

    expect(() =>
      verifyMainWorkflowGates({
        expectedSha: SAMPLE_SHA,
        ciRunsPayload: greenCi,
        auditRunsPayload: {
          workflow_runs: [
            {
              head_sha: SAMPLE_SHA,
              head_branch: "main",
              event: "push",
              status: "in_progress",
              conclusion: null,
              html_url: "https://github.com/geekammar/Rabet/actions/runs/1004",
            },
          ],
        },
      }),
    ).toThrow(/status="in_progress"/);
  });
});

describe("waitForMainWorkflowGates", () => {
  function runsResponse(
    sha: string,
    workflow: "ci" | "audit",
    status: string,
    conclusion: string | null,
  ): Response {
    return jsonResponse({
      workflow_runs: [
        {
          head_sha: sha,
          head_branch: "main",
          event: workflow === "ci" ? "push" : "push",
          status,
          conclusion,
          html_url: `https://github.com/geekammar/Rabet/actions/runs/${workflow}-${status}`,
        },
      ],
    });
  }

  function queuedFetch(
    ciResponses: Response[],
    auditResponses: Response[],
  ): typeof fetch {
    let ciIndex = 0;
    let auditIndex = 0;
    return (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/workflows/ci.yml/runs")) {
        return ciResponses[
          Math.min(ciIndex++, ciResponses.length - 1)
        ].clone();
      }
      if (url.includes("/workflows/audit.yml/runs")) {
        return auditResponses[
          Math.min(auditIndex++, auditResponses.length - 1)
        ].clone();
      }
      return jsonResponse({ error: "unexpected" }, 500);
    }) as typeof fetch;
  }

  it("waits through in-progress runs and succeeds only after both exact-SHA gates pass", async () => {
    let now = 0;
    const fetchImpl = queuedFetch(
      [
        runsResponse(SAMPLE_SHA, "ci", "in_progress", null),
        runsResponse(SAMPLE_SHA, "ci", "completed", "success"),
      ],
      [
        runsResponse(SAMPLE_SHA, "audit", "in_progress", null),
        runsResponse(SAMPLE_SHA, "audit", "completed", "success"),
      ],
    );

    const res = await waitForMainWorkflowGates({
      expectedSha: SAMPLE_SHA,
      repoFullName: "geekammar/Rabet",
      token: "ghs_synthetic_test_token",
      fetchImpl,
      sleepImpl: async () => {
        now += 1;
      },
      nowImpl: () => now,
      timeoutMs: 10,
      pollIntervalMs: 1,
    });

    expect(res.verifiedSha).toBe(SAMPLE_SHA);
    expect(res.ciRunUrl).toContain("ci-completed");
    expect(res.auditRunUrl).toContain("audit-completed");
  });

  it("fails immediately when either latest exact-SHA run completed unsuccessfully", async () => {
    let now = 0;
    await expect(
      waitForMainWorkflowGates({
        expectedSha: SAMPLE_SHA,
        repoFullName: "geekammar/Rabet",
        token: "ghs_synthetic_test_token",
        fetchImpl: queuedFetch(
          [runsResponse(SAMPLE_SHA, "ci", "completed", "failure")],
          [runsResponse(SAMPLE_SHA, "audit", "completed", "success")],
        ),
        sleepImpl: async () => {
          now += 1;
        },
        nowImpl: () => now,
        timeoutMs: 10,
        pollIntervalMs: 1,
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ReleaseGateError && err.code === "WORKFLOW_GATE_FAILED",
    );
  });

  it("fails closed on timeout when either gate run is missing or never completes", async () => {
    let now = 0;
    await expect(
      waitForMainWorkflowGates({
        expectedSha: SAMPLE_SHA,
        repoFullName: "geekammar/Rabet",
        token: "ghs_synthetic_test_token",
        fetchImpl: queuedFetch(
          [runsResponse(SAMPLE_SHA, "ci", "completed", "success")],
          [jsonResponse({ workflow_runs: [] })],
        ),
        sleepImpl: async () => {
          now += 1;
        },
        nowImpl: () => now,
        timeoutMs: 3,
        pollIntervalMs: 1,
      }),
    ).rejects.toThrow(/Timed out waiting for push CI and Dependency Audit success/);
  });

  it("fails closed when GitHub run queries are rejected", async () => {
    const fetchImpl = (async () =>
      jsonResponse({ message: "Bad credentials" }, 401)) as typeof fetch;

    await expect(
      waitForMainWorkflowGates({
        expectedSha: SAMPLE_SHA,
        repoFullName: "geekammar/Rabet",
        token: "ghs_synthetic_test_token",
        fetchImpl,
        timeoutMs: 1,
        pollIntervalMs: 1,
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ReleaseGateError && err.code === "WORKFLOW_QUERY_FAILED",
    );
  });
});

describe("inspectExistingGhcrTag", () => {
  const baseParams = {
    registryBaseUrl: "https://ghcr.io",
    repoPath: "geekammar/rabet",
    tagName: `sha-${SAMPLE_SHA}`,
    expectedSha: SAMPLE_SHA,
    expectedSourceUrl: SOURCE_URL,
    actor: "geekammar",
    githubToken: "ghs_synthetic_test_token",
  };

  it("returns { status: 'missing' } on genuine OCI 404 (NAME_UNKNOWN or MANIFEST_UNKNOWN)", async () => {
    for (const ociCode of ["NAME_UNKNOWN", "MANIFEST_UNKNOWN"]) {
      const fetchMock = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/token?")) {
          return jsonResponse({ token: "bearer-123" });
        }
        return jsonResponse(
          { errors: [{ code: ociCode, message: "not found" }] },
          404,
        );
      }) as typeof fetch;

      const res = await inspectExistingGhcrTag({
        ...baseParams,
        fetchImpl: fetchMock,
      });
      expect(res).toEqual({ status: "missing" });
    }
  });

  it("distinguishes 401/403 registry auth errors from a missing tag", async () => {
    const authFailTokenFetch = (async () =>
      jsonResponse({ errors: [{ code: "UNAUTHORIZED" }] }, 401)) as typeof fetch;

    await expect(
      inspectExistingGhcrTag({ ...baseParams, fetchImpl: authFailTokenFetch }),
    ).rejects.toMatchObject({ code: "REGISTRY_AUTH_ERROR" });

    const authFailManifestFetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/token?")) {
        return jsonResponse({ token: "bearer-123" });
      }
      return jsonResponse({ errors: [{ code: "DENIED" }] }, 403);
    }) as typeof fetch;

    await expect(
      inspectExistingGhcrTag({ ...baseParams, fetchImpl: authFailManifestFetch }),
    ).rejects.toMatchObject({ code: "REGISTRY_AUTH_ERROR" });
  });

  it("distinguishes network failures, 5xx responses, and non-OCI HTML 404s from a missing tag", async () => {
    const netFailFetch = (async () => {
      throw new Error("getaddrinfo EAI_AGAIN ghcr.io");
    }) as typeof fetch;

    await expect(
      inspectExistingGhcrTag({ ...baseParams, fetchImpl: netFailFetch }),
    ).rejects.toMatchObject({ code: "REGISTRY_NETWORK_ERROR" });

    const serverErrFetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/token?")) {
        return jsonResponse({ token: "bearer-123" });
      }
      return jsonResponse({ error: "bad gateway" }, 502);
    }) as typeof fetch;

    await expect(
      inspectExistingGhcrTag({ ...baseParams, fetchImpl: serverErrFetch }),
    ).rejects.toMatchObject({ code: "REGISTRY_NETWORK_ERROR" });

    const html404Fetch = (async (input: RequestInfo | URL) => {
      if (String(input).includes("/token?")) {
        return jsonResponse({ token: "bearer-123" });
      }
      return new Response("<html>404 Not Found</html>", { status: 404 });
    }) as typeof fetch;

    await expect(
      inspectExistingGhcrTag({ ...baseParams, fetchImpl: html404Fetch }),
    ).rejects.toMatchObject({ code: "REGISTRY_NETWORK_ERROR" });
  });

  it("fails closed on ambiguous 404 bodies: empty body, {}, empty errors array, and mixed/unknown OCI codes", async () => {
    const ambiguous404Responses: Array<{ label: string; makeResponse: () => Response }> = [
      {
        label: "empty 404 body",
        makeResponse: () => new Response("", { status: 404 }),
      },
      {
        label: "whitespace-only 404 body",
        makeResponse: () =>
          new Response("   \n  ", {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
      },
      {
        label: "empty JSON object {}",
        makeResponse: () => jsonResponse({}, 404),
      },
      {
        label: "empty OCI errors array {\"errors\":[]}",
        makeResponse: () => jsonResponse({ errors: [] }, 404),
      },
      {
        label: "mixed allowed and unknown OCI codes",
        makeResponse: () =>
          jsonResponse(
            {
              errors: [
                { code: "MANIFEST_UNKNOWN", message: "manifest unknown" },
                { code: "DENIED", message: "denied" },
              ],
            },
            404,
          ),
      },
      {
        label: "mixed NAME_UNKNOWN and unrecognized OCI code",
        makeResponse: () =>
          jsonResponse(
            {
              errors: [
                { code: "NAME_UNKNOWN", message: "repository unknown" },
                { code: "BLOB_UNKNOWN", message: "unexpected code" },
              ],
            },
            404,
          ),
      },
      {
        label: "OCI error entry missing string code",
        makeResponse: () => jsonResponse({ errors: [{}] }, 404),
      },
    ];

    for (const testCase of ambiguous404Responses) {
      const fetchMock = (async (input: RequestInfo | URL) => {
        if (String(input).includes("/token?")) {
          return jsonResponse({ token: "bearer-123" });
        }
        return testCase.makeResponse();
      }) as typeof fetch;

      await expect(
        inspectExistingGhcrTag({ ...baseParams, fetchImpl: fetchMock }),
        `Expected fail-closed rejection for: ${testCase.label}`,
      ).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof ReleaseGateError && err.code === "REGISTRY_NETWORK_ERROR",
      );
    }
  });

  it("verifies provenance across BuildKit OCI Image Index + config blob and reuses existing digest", async () => {
    const configJson = JSON.stringify({
      architecture: "amd64",
      os: "linux",
      config: {
        Env: ["NODE_ENV=production", `RABET_BUILD_SHA=${SAMPLE_SHA}`],
        Labels: {
          "org.opencontainers.image.revision": SAMPLE_SHA,
          "org.opencontainers.image.source": SOURCE_URL,
        },
      },
    });
    const configDigest = sha256(configJson);

    const childManifestJson = JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: configDigest,
      },
      layers: [],
    });
    const childDigest = sha256(childManifestJson);

    const indexJson = JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: childDigest,
          platform: { os: "linux", architecture: "amd64" },
        },
        {
          mediaType: "application/vnd.oci.image.manifest.v1+json",
          digest: sha256("{}"),
          platform: { os: "unknown", architecture: "unknown" },
          annotations: { "vnd.docker.reference.type": "attestation-manifest" },
        },
      ],
    });
    const indexDigest = sha256(indexJson);

    const fetchMock = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/token?")) {
        return jsonResponse({ token: "bearer-123" });
      }
      if (url.endsWith(`/manifests/sha-${SAMPLE_SHA}`)) {
        return new Response(indexJson, {
          status: 200,
          headers: {
            "content-type": "application/vnd.oci.image.index.v1+json",
            "docker-content-digest": indexDigest,
          },
        });
      }
      if (url.endsWith(`/manifests/${childDigest}`)) {
        return new Response(childManifestJson, {
          status: 200,
          headers: {
            "content-type": "application/vnd.oci.image.manifest.v1+json",
          },
        });
      }
      if (url.endsWith(`/blobs/${configDigest}`)) {
        return new Response(configJson, {
          status: 200,
          headers: {
            "content-type": "application/vnd.oci.image.config.v1+json",
          },
        });
      }
      return jsonResponse({ error: "unexpected url" }, 500);
    }) as typeof fetch;

    const res = await inspectExistingGhcrTag({
      ...baseParams,
      fetchImpl: fetchMock,
    });

    expect(res).toEqual({
      status: "exists_verified",
      digest: indexDigest,
      repoDigest: `ghcr.io/geekammar/rabet@${indexDigest}`,
      configDigest,
    });
  });

  it("stops with PROVENANCE_MISMATCH if an existing tag carries a different revision SHA", async () => {
    const otherSha = "0000000000000000000000000000000000000000";
    const configJson = JSON.stringify({
      architecture: "amd64",
      os: "linux",
      config: {
        Env: [`RABET_BUILD_SHA=${otherSha}`],
        Labels: {
          "org.opencontainers.image.revision": otherSha,
          "org.opencontainers.image.source": SOURCE_URL,
        },
      },
    });
    const configDigest = sha256(configJson);

    const manifestJson = JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { digest: configDigest },
      layers: [],
    });
    const manifestDigest = sha256(manifestJson);

    const fetchMock = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/token?")) {
        return jsonResponse({ token: "bearer-123" });
      }
      if (url.endsWith(`/manifests/sha-${SAMPLE_SHA}`)) {
        return new Response(manifestJson, {
          status: 200,
          headers: {
            "content-type": "application/vnd.oci.image.manifest.v1+json",
            "docker-content-digest": manifestDigest,
          },
        });
      }
      if (url.endsWith(`/blobs/${configDigest}`)) {
        return new Response(configJson, { status: 200 });
      }
      return jsonResponse({}, 500);
    }) as typeof fetch;

    await expect(
      inspectExistingGhcrTag({ ...baseParams, fetchImpl: fetchMock }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof ReleaseGateError && err.code === "PROVENANCE_MISMATCH",
    );
  });
});
