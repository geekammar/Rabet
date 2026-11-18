import { describe, expect, it } from "vitest";

import {
  assertFreshMain,
  assertNoMigrationChanges,
  buildImageRef,
  classifyDeployStatus,
  RenderDeployError,
  runRenderDeployment,
  validateRenderService,
  verifyDeployImage,
  verifyHealthPayload,
} from "../scripts/render-deploy-gate.mjs";

const SAMPLE_SHA = "f30a29d66ecad4f174195e04f71a791d2c782fc2";
const OTHER_SHA = "0000000000000000000000000000000000000000";
// Sanitized representative Render response: image.ref is the pinned GHCR
// manifest digest; image.sha is the pulled image ID (config digest), not the
// same digest as the manifest.
const DIGEST = `sha256:8bd590f2${"0".repeat(56)}`;
const CONFIG_DIGEST = `sha256:7f2fa1b2${"0".repeat(56)}`;
const OTHER_DIGEST = `sha256:${"b".repeat(64)}`;
const OTHER_CONFIG_DIGEST = `sha256:${"d".repeat(64)}`;
const IMAGE_REPO = "geekammar/rabet";
const IMAGE_REF = `ghcr.io/${IMAGE_REPO}@${DIGEST}`;
const PREVIOUS_IMAGE = "ghcr.io/geekammar/rabet:sha-previous";
const SERVICE_ID = "srv-abc123";
const HEALTH_URL = "https://rabet.example.test/api/healthz";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function service(overrides: Record<string, unknown> = {}) {
  return {
    id: SERVICE_ID,
    type: "web_service",
    ownerId: "tea-owner",
    suspended: "not_suspended",
    autoDeployTrigger: "off",
    imagePath: PREVIOUS_IMAGE,
    registryCredential: { id: "rgc-credential", name: "ghcr-read-only" },
    dashboardUrl: "https://dashboard.render.com/web/srv-abc123",
    serviceDetails: {
      runtime: "image",
      healthCheckPath: "/api/healthz",
      url: "https://rabet.example.test",
    },
    ...overrides,
  };
}

type Scenario = {
  service?: Record<string, unknown>;
  patchStatus?: number;
  deployTriggerStatus?: number;
  deployStatuses?: string[];
  health?: Array<() => Response>;
  currentMainShas?: string[];
  cancelStatus?: number;
  restorePatchStatus?: number;
  restoreGetService?: Record<string, unknown>;
  imageRef?: string;
  imageSha?: string;
  configDigest?: string;
  liveRevision?: string;
  changedPaths?: string[];
  liveRevisionError?: string;
  changedPathsError?: string;
  promotionMode?: "automatic" | "manual";
};

function scenarioFetch(scenario: Scenario) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  let savedImagePath = String(scenario.service?.imagePath ?? PREVIOUS_IMAGE);
  let deployIndex = 0;
  let healthIndex = 0;
  let mainIndex = 0;
  let deployAttempted = false;
  const deployStatuses = scenario.deployStatuses ?? ["queued", "live"];
  const returnedImageRef = scenario.imageRef ?? IMAGE_REF;
  const returnedImageSha = scenario.imageSha ?? CONFIG_DIGEST;

  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = String(init.method ?? "GET").toUpperCase();
    const path = url.pathname;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });

    if (path === `/v1/services/${SERVICE_ID}`) {
      if (method === "GET") {
        if (deployAttempted && scenario.restoreGetService) {
          return json(scenario.restoreGetService);
        }
        return json({ ...service(scenario.service), imagePath: savedImagePath });
      }
      if (method === "PATCH") {
        const restoring =
          body?.image?.imagePath === PREVIOUS_IMAGE && deployAttempted;
        if (restoring && scenario.restorePatchStatus) {
          return json({ message: "restore failed" }, scenario.restorePatchStatus);
        }
        if (!restoring && scenario.patchStatus) {
          return json({ message: "patch failed" }, scenario.patchStatus);
        }
        savedImagePath = body.image.imagePath;
        return json({ ...service(scenario.service), imagePath: savedImagePath });
      }
    }

    if (path === `/v1/services/${SERVICE_ID}/deploys` && method === "POST") {
      if (scenario.deployTriggerStatus) {
        return json(
          { message: "deploy trigger failed" },
          scenario.deployTriggerStatus,
        );
      }
      deployAttempted = true;
      return json({
        id: "dep-1",
        status: "queued",
        image: { ref: body.imageUrl, sha: returnedImageSha },
      });
    }

    if (path === `/v1/services/${SERVICE_ID}/deploys/dep-1` && method === "GET") {
      const status =
        deployStatuses[Math.min(deployIndex++, deployStatuses.length - 1)];
      return json({
        id: "dep-1",
        status,
        image: { ref: returnedImageRef, sha: returnedImageSha },
      });
    }

    if (
      path === `/v1/services/${SERVICE_ID}/deploys/dep-1/cancel` &&
      method === "POST"
    ) {
      return json({ id: "dep-1", status: scenario.cancelStatus ?? "canceled" });
    }

    if (String(input) === HEALTH_URL) {
      const index = Math.min(healthIndex++, scenario.health!.length - 1);
      return scenario.health![index]();
    }

    return json({ message: `unexpected ${method} ${path}` }, 500);
  }) as typeof fetch;

  const getCurrentMainSha = async () => {
    const sequence = scenario.currentMainShas ?? [SAMPLE_SHA];
    const value = sequence[Math.min(mainIndex++, sequence.length - 1)];
    return value;
  };

  const getLiveRevision = async () => {
    if (scenario.liveRevisionError) throw new Error(scenario.liveRevisionError);
    return scenario.liveRevision ?? OTHER_SHA;
  };

  const getChangedPaths = async () => {
    if (scenario.changedPathsError) throw new Error(scenario.changedPathsError);
    return scenario.changedPaths ?? [];
  };

  return {
    fetchImpl,
    getCurrentMainSha,
    getLiveRevision,
    getChangedPaths,
    calls,
    getSavedImagePath: () => savedImagePath,
  };
}

function healthy(sha: string): Response {
  return json({ status: "ok", sha });
}

async function runScenario(scenario: Scenario) {
  const harness = scenarioFetch(scenario);
  try {
    const summary = await runRenderDeployment({
      apiKey: "rnd_synthetic_test_key",
      serviceId: SERVICE_ID,
      expectedSha: SAMPLE_SHA,
      imageRepo: IMAGE_REPO,
      imageDigestRef: IMAGE_REF,
      imageConfigDigest: scenario.configDigest ?? CONFIG_DIGEST,
      healthUrl: HEALTH_URL,
      promotionMode: scenario.promotionMode ?? "automatic",
      getCurrentMainSha: harness.getCurrentMainSha,
      getLiveRevision: harness.getLiveRevision,
      getChangedPaths: harness.getChangedPaths,
      fetchImpl: harness.fetchImpl,
      sleepImpl: async () => {},
      nowImpl: (() => {
        let now = 0;
        return () => {
          now += 1;
          return now;
        };
      })(),
      deployTimeoutMs: 100,
      healthTimeoutMs: 100,
      pollIntervalMs: 1,
      logger: { log: () => {}, error: () => {} },
    });
    return { summary, ...harness };
  } catch (err) {
    if (err && typeof err === "object") {
      (err as { harness?: unknown }).harness = harness;
    }
    throw err;
  }
}

function expectGateError(err: unknown, code: string) {
  expect(err).toBeInstanceOf(RenderDeployError);
  expect((err as RenderDeployError).code).toBe(code);
}

describe("render deploy gate inputs", () => {
  it("accepts only the current origin/main SHA", () => {
    expect(
      assertFreshMain({ expectedSha: SAMPLE_SHA, currentMainSha: SAMPLE_SHA }),
    ).toBe(true);
    expect(() =>
      assertFreshMain({ expectedSha: SAMPLE_SHA, currentMainSha: OTHER_SHA }),
    ).toThrow(/current origin\/main is/);
  });

  it("validates the Render service is the expected image-backed web service", () => {
    const target = validateRenderService({
      service: service(),
      expectedImageRepo: IMAGE_REPO,
      expectedServiceId: SERVICE_ID,
    });
    expect(target.previousImagePath).toBe(PREVIOUS_IMAGE);
    expect(target.registryCredentialId).toBe("rgc-credential");

    for (const badService of [
      service({ type: "private_service" }),
      service({ serviceDetails: { runtime: "docker" } }),
      service({ suspended: "suspended" }),
      service({ imagePath: "ghcr.io/geekammar/other:latest" }),
      service({ id: "srv-other" }),
    ]) {
      expect(() =>
        validateRenderService({
          service: badService,
          expectedImageRepo: IMAGE_REPO,
          expectedServiceId: SERVICE_ID,
        }),
      ).toThrow(RenderDeployError);
    }
  });

  it("builds immutable digest references and rejects malformed digests", () => {
    expect(buildImageRef({ imageRepo: IMAGE_REPO, digest: DIGEST })).toBe(
      IMAGE_REF,
    );
    expect(() =>
      buildImageRef({ imageRepo: IMAGE_REPO, digest: "sha256:not-a-digest" }),
    ).toThrow(/sha256 digest/);
  });

  it("accepts the real Render response shape: pinned image.ref + config image.sha", () => {
    expect(
      verifyDeployImage({
        deploy: {
          id: "dep-1",
          image: { ref: IMAGE_REF, sha: CONFIG_DIGEST },
        },
        expectedDigest: DIGEST,
        expectedImageRef: IMAGE_REF,
        expectedConfigDigest: CONFIG_DIGEST,
      }),
    ).toEqual({
      pinnedRef: IMAGE_REF,
      manifestDigest: DIGEST,
      imageSha: CONFIG_DIGEST,
    });

    // A Render response that resolves image.sha to the manifest digest is also
    // acceptable; only the pinned image.ref is authoritative.
    expect(
      verifyDeployImage({
        deploy: {
          id: "dep-1",
          image: { ref: IMAGE_REF, sha: DIGEST },
        },
        expectedDigest: DIGEST,
        expectedImageRef: IMAGE_REF,
        expectedConfigDigest: CONFIG_DIGEST,
      }).imageSha,
    ).toBe(DIGEST);
  });

  it("rejects a wrong or missing pinned image reference", () => {
    for (const [label, deploy] of [
      [
        "missing image.ref",
        { id: "dep-1", image: { sha: CONFIG_DIGEST } },
      ],
      [
        "wrong pinned digest",
        {
          id: "dep-1",
          image: {
            ref: `ghcr.io/${IMAGE_REPO}@${OTHER_DIGEST}`,
            sha: CONFIG_DIGEST,
          },
        },
      ],
      [
        "tag instead of digest",
        {
          id: "dep-1",
          image: {
            ref: `ghcr.io/${IMAGE_REPO}:sha-${SAMPLE_SHA}`,
            sha: CONFIG_DIGEST,
          },
        },
      ],
    ] as const) {
      expect(() =>
        verifyDeployImage({
          deploy,
          expectedDigest: DIGEST,
          expectedImageRef: IMAGE_REF,
          expectedConfigDigest: CONFIG_DIGEST,
        }),
        label,
      ).toThrow(/pinned|image reference|reference digest/);
    }
  });

  it("rejects an image.sha that matches neither the GHCR config nor manifest digest", () => {
    expect(() =>
      verifyDeployImage({
        deploy: {
          id: "dep-1",
          image: { ref: IMAGE_REF, sha: OTHER_CONFIG_DIGEST },
        },
        expectedDigest: DIGEST,
        expectedImageRef: IMAGE_REF,
        expectedConfigDigest: CONFIG_DIGEST,
      }),
    ).toThrow(/does not match the GHCR config digest/);
  });

  it("requires /api/healthz to return status ok and the exact full SHA", () => {
    expect(
      verifyHealthPayload({
        httpStatus: 200,
        payload: { status: "ok", sha: SAMPLE_SHA },
        expectedSha: SAMPLE_SHA,
      }),
    ).toEqual({ status: "ok", sha: SAMPLE_SHA });

    for (const [label, payload] of [
      ["missing sha", { status: "ok" }],
      ["short sha", { status: "ok", sha: SAMPLE_SHA.slice(0, 12) }],
      ["wrong sha", { status: "ok", sha: OTHER_SHA }],
      ["wrong status", { status: "degraded", sha: SAMPLE_SHA }],
    ] as const) {
      expect(() =>
        verifyHealthPayload({
          httpStatus: 200,
          payload,
          expectedSha: SAMPLE_SHA,
        }),
        label,
      ).toThrow(/healthz/);
    }
  });

  it("classifies Render deploy statuses fail-closed", () => {
    expect(classifyDeployStatus("live")).toBe("live");
    expect(classifyDeployStatus("queued")).toBe("pending");
    expect(classifyDeployStatus("update_in_progress")).toBe("pending");
    expect(classifyDeployStatus("build_failed")).toBe("failed");
    expect(classifyDeployStatus("deactivated")).toBe("failed");
    expect(classifyDeployStatus("something-new")).toBe("unknown");
  });

  it("enforces the migration exception against the live revision", () => {
    expect(
      assertNoMigrationChanges({
        liveSha: SAMPLE_SHA,
        expectedSha: OTHER_SHA,
        changedPaths: ["src/app/page.tsx", "docs/README.md"],
      }).migrationChanges,
    ).toEqual([]);

    expect(
      assertNoMigrationChanges({
        liveSha: SAMPLE_SHA,
        expectedSha: SAMPLE_SHA,
        changedPaths: undefined,
      }).migrationChanges,
    ).toEqual([]);

    expect(() =>
      assertNoMigrationChanges({
        liveSha: SAMPLE_SHA,
        expectedSha: OTHER_SHA,
        changedPaths: ["drizzle/0008_new_migration.sql"],
      }),
    ).toThrow(/migration inputs differ/);

    expect(() =>
      assertNoMigrationChanges({
        liveSha: SAMPLE_SHA,
        expectedSha: OTHER_SHA,
        changedPaths: undefined,
      }),
    ).toThrow(/changed paths were not established/);
  });
});

describe("runRenderDeployment", () => {
  it("updates the saved image reference, deploys the same digest, and verifies live SHA", async () => {
    const { summary, calls, getSavedImagePath } = await runScenario({
      health: [() => healthy(SAMPLE_SHA)],
    });

    expect(summary.verified).toBe(true);
    expect(summary.promotionMode).toBe("automatic");
    expect(summary.expectedSha).toBe(SAMPLE_SHA);
    expect(summary.imageRef).toBe(IMAGE_REF);
    expect(summary.configDigest).toBe(CONFIG_DIGEST);
    expect(summary.liveShaBefore).toBe(OTHER_SHA);
    expect(summary.migrationCheck.migrationChanges).toEqual([]);
    expect(summary.deployId).toBe("dep-1");
    expect(summary.deployStatus).toBe("live");
    expect(summary.deployImageRef).toBe(IMAGE_REF);
    expect(summary.deployImageSha).toBe(CONFIG_DIGEST);
    expect(summary.healthHttpStatus).toBe(200);
    expect(summary.healthSha).toBe(SAMPLE_SHA);
    expect(getSavedImagePath()).toBe(IMAGE_REF);

    const patch = calls.find((call) => call.method === "PATCH");
    expect(patch?.body).toEqual({
      image: {
        ownerId: "tea-owner",
        imagePath: IMAGE_REF,
        registryCredentialId: "rgc-credential",
      },
    });
    const deploy = calls.find(
      (call) => call.method === "POST" && call.path.endsWith("/deploys"),
    );
    expect(deploy?.body).toEqual({ imageUrl: IMAGE_REF });
  });

  it("allows the owner-approved manual path without the automatic migration comparison", async () => {
    const { summary } = await runScenario({
      promotionMode: "manual",
      liveRevisionError: "manual path does not read live revision",
      changedPaths: ["drizzle/0008_new_migration.sql"],
      health: [() => healthy(SAMPLE_SHA)],
    });

    expect(summary.verified).toBe(true);
    expect(summary.promotionMode).toBe("manual");
    expect(summary.migrationCheck).toMatchObject({ skipped: true });
  });

  it("blocks automatic promotion before any Render mutation when migration inputs changed", async () => {
    const harness = scenarioFetch({
      changedPaths: ["drizzle/0008_new_migration.sql", "src/app/page.tsx"],
      health: [() => healthy(SAMPLE_SHA)],
    });

    let failure: unknown;
    try {
      await runRenderDeployment({
        apiKey: "rnd_synthetic_test_key",
        serviceId: SERVICE_ID,
        expectedSha: SAMPLE_SHA,
        imageRepo: IMAGE_REPO,
        imageDigestRef: IMAGE_REF,
        imageConfigDigest: CONFIG_DIGEST,
        healthUrl: HEALTH_URL,
        promotionMode: "automatic",
        getCurrentMainSha: harness.getCurrentMainSha,
        getLiveRevision: harness.getLiveRevision,
        getChangedPaths: harness.getChangedPaths,
        fetchImpl: harness.fetchImpl,
        sleepImpl: async () => {},
        pollIntervalMs: 1,
        logger: { log: () => {}, error: () => {} },
      });
    } catch (err) {
      failure = err;
    }

    expectGateError(failure, "MIGRATION_CHANGED");
    expect(harness.calls).toEqual([]);
  });

  it("blocks automatic promotion when the live revision cannot be established", async () => {
    const harness = scenarioFetch({
      liveRevisionError: "health response has no full SHA",
      health: [() => healthy(SAMPLE_SHA)],
    });

    let failure: unknown;
    try {
      await runRenderDeployment({
        apiKey: "rnd_synthetic_test_key",
        serviceId: SERVICE_ID,
        expectedSha: SAMPLE_SHA,
        imageRepo: IMAGE_REPO,
        imageDigestRef: IMAGE_REF,
        imageConfigDigest: CONFIG_DIGEST,
        healthUrl: HEALTH_URL,
        promotionMode: "automatic",
        getCurrentMainSha: harness.getCurrentMainSha,
        getLiveRevision: harness.getLiveRevision,
        getChangedPaths: harness.getChangedPaths,
        fetchImpl: harness.fetchImpl,
        sleepImpl: async () => {},
        pollIntervalMs: 1,
        logger: { log: () => {}, error: () => {} },
      });
    } catch (err) {
      failure = err;
    }

    expectGateError(failure, "LIVE_REVISION_UNKNOWN");
    expect(harness.calls).toEqual([]);
  });

  it("blocks automatic promotion when migration comparison cannot be established", async () => {
    const harness = scenarioFetch({
      changedPathsError: "live commit is not fetchable",
      health: [() => healthy(SAMPLE_SHA)],
    });

    let failure: unknown;
    try {
      await runRenderDeployment({
        apiKey: "rnd_synthetic_test_key",
        serviceId: SERVICE_ID,
        expectedSha: SAMPLE_SHA,
        imageRepo: IMAGE_REPO,
        imageDigestRef: IMAGE_REF,
        imageConfigDigest: CONFIG_DIGEST,
        healthUrl: HEALTH_URL,
        promotionMode: "automatic",
        getCurrentMainSha: harness.getCurrentMainSha,
        getLiveRevision: harness.getLiveRevision,
        getChangedPaths: harness.getChangedPaths,
        fetchImpl: harness.fetchImpl,
        sleepImpl: async () => {},
        pollIntervalMs: 1,
        logger: { log: () => {}, error: () => {} },
      });
    } catch (err) {
      failure = err;
    }

    expectGateError(failure, "MIGRATION_COMPARISON_FAILED");
    expect(harness.calls).toEqual([]);
  });

  it("does not touch Render when origin/main has moved before promotion", async () => {
    const harness = scenarioFetch({
      currentMainShas: [OTHER_SHA],
      health: [() => healthy(SAMPLE_SHA)],
    });

    await expect(
      runRenderDeployment({
        apiKey: "rnd_synthetic_test_key",
        serviceId: SERVICE_ID,
        expectedSha: SAMPLE_SHA,
        imageRepo: IMAGE_REPO,
        imageDigestRef: IMAGE_REF,
        imageConfigDigest: CONFIG_DIGEST,
        healthUrl: HEALTH_URL,
        promotionMode: "automatic",
        getCurrentMainSha: harness.getCurrentMainSha,
        getLiveRevision: harness.getLiveRevision,
        getChangedPaths: harness.getChangedPaths,
        fetchImpl: harness.fetchImpl,
        sleepImpl: async () => {},
        pollIntervalMs: 1,
        logger: { log: () => {}, error: () => {} },
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof RenderDeployError && err.code === "STALE_MAIN",
    );

    expect(harness.calls).toEqual([]);
  });

  it("does not deploy when Render rejects the saved image update", async () => {
    const harness = scenarioFetch({
      patchStatus: 500,
      health: [() => healthy(SAMPLE_SHA)],
    });

    await expect(
      runRenderDeployment({
        apiKey: "rnd_synthetic_test_key",
        serviceId: SERVICE_ID,
        expectedSha: SAMPLE_SHA,
        imageRepo: IMAGE_REPO,
        imageDigestRef: IMAGE_REF,
        imageConfigDigest: CONFIG_DIGEST,
        healthUrl: HEALTH_URL,
        promotionMode: "automatic",
        getCurrentMainSha: harness.getCurrentMainSha,
        getLiveRevision: harness.getLiveRevision,
        getChangedPaths: harness.getChangedPaths,
        fetchImpl: harness.fetchImpl,
        sleepImpl: async () => {},
        pollIntervalMs: 1,
        logger: { log: () => {}, error: () => {} },
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof RenderDeployError && err.code === "RENDER_API_ERROR",
    );

    expect(
      harness.calls.some(
        (call) => call.method === "POST" && call.path.endsWith("/deploys"),
      ),
    ).toBe(false);
  });

  it("fails and restores the previous saved image when the Render deploy fails", async () => {
    let failure: unknown;
    try {
      await runScenario({
        deployStatuses: ["build_failed"],
        health: [() => healthy(SAMPLE_SHA)],
      });
    } catch (err) {
      failure = err;
    }

    expectGateError(failure, "DEPLOY_FAILED");
    const gateError = failure as RenderDeployError & {
      summary: { verified: boolean; error: string };
      harness: ReturnType<typeof scenarioFetch>;
    };
    expect(gateError.summary.verified).toBe(false);
    expect(gateError.summary.error).toMatch(/build_failed/);

    const { calls, getSavedImagePath } = gateError.harness;
    expect(calls.some((call) => call.method === "PATCH")).toBe(true);
    expect(
      calls.filter((call) => call.method === "PATCH").at(-1)?.body,
    ).toEqual({
      image: {
        ownerId: "tea-owner",
        imagePath: PREVIOUS_IMAGE,
        registryCredentialId: "rgc-credential",
      },
    });
    expect(getSavedImagePath()).toBe(PREVIOUS_IMAGE);
  });

  it("fails and restores the previous saved image when /api/healthz reports the wrong SHA", async () => {
    await expect(
      runScenario({
        deployStatuses: ["live"],
        health: [() => healthy(OTHER_SHA)],
      }),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof RenderDeployError)) return false;
      expect(err.code).toBe("HEALTH_MISMATCH");
      expect(err.summary.verified).toBe(false);
      expect(err.summary.restore).toMatchObject({ restored: true });
      return true;
    });
  });

  it("cancels a pending Render deploy and fails when origin/main moves during the deploy", async () => {
    const harness = scenarioFetch({
      deployStatuses: ["queued"],
      currentMainShas: [SAMPLE_SHA, SAMPLE_SHA, SAMPLE_SHA, OTHER_SHA],
      health: [() => healthy(SAMPLE_SHA)],
    });

    await expect(
      runRenderDeployment({
        apiKey: "rnd_synthetic_test_key",
        serviceId: SERVICE_ID,
        expectedSha: SAMPLE_SHA,
        imageRepo: IMAGE_REPO,
        imageDigestRef: IMAGE_REF,
        imageConfigDigest: CONFIG_DIGEST,
        healthUrl: HEALTH_URL,
        promotionMode: "automatic",
        getCurrentMainSha: harness.getCurrentMainSha,
        getLiveRevision: harness.getLiveRevision,
        getChangedPaths: harness.getChangedPaths,
        fetchImpl: harness.fetchImpl,
        sleepImpl: async () => {},
        pollIntervalMs: 1,
        deployTimeoutMs: 100,
        logger: { log: () => {}, error: () => {} },
      }),
    ).rejects.toSatisfy(
      (err: unknown) =>
        err instanceof RenderDeployError && err.code === "STALE_MAIN",
    );

    expect(
      harness.calls.some((call) => call.path.endsWith("/cancel")),
    ).toBe(true);
    expect(harness.getSavedImagePath()).toBe(PREVIOUS_IMAGE);
  });

  it("does not overwrite a newer saved image reference while restoring a failed release", async () => {
    const newerImage = `ghcr.io/${IMAGE_REPO}@${OTHER_DIGEST}`;
    await expect(
      runScenario({
        deployStatuses: ["build_failed"],
        restoreGetService: service({ imagePath: newerImage }),
        health: [() => healthy(SAMPLE_SHA)],
      }),
    ).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof RenderDeployError)) return false;
      expect(err.summary.restore).toMatchObject({
        restored: false,
        skipped: true,
      });
      return true;
    });
  });
});
