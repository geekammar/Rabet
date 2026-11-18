import { describe, expect, it } from "vitest";

import {
  assertFreshMain,
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
const DIGEST = `sha256:${"a".repeat(64)}`;
const OTHER_DIGEST = `sha256:${"b".repeat(64)}`;
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
};

function scenarioFetch(scenario: Scenario) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = [];
  let savedImagePath = String(scenario.service?.imagePath ?? PREVIOUS_IMAGE);
  let deployIndex = 0;
  let healthIndex = 0;
  let mainIndex = 0;
  let deployAttempted = false;
  const deployStatuses = scenario.deployStatuses ?? ["queued", "live"];

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
        image: { ref: body.imageUrl, sha: DIGEST },
      });
    }

    if (path === `/v1/services/${SERVICE_ID}/deploys/dep-1` && method === "GET") {
      const status =
        deployStatuses[Math.min(deployIndex++, deployStatuses.length - 1)];
      return json({
        id: "dep-1",
        status,
        image: { ref: IMAGE_REF, sha: DIGEST },
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

  return {
    fetchImpl,
    getCurrentMainSha,
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
      healthUrl: HEALTH_URL,
      getCurrentMainSha: harness.getCurrentMainSha,
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

  it("requires a live deploy to resolve to the expected digest and reference", () => {
    expect(
      verifyDeployImage({
        deploy: {
          id: "dep-1",
          image: { ref: IMAGE_REF, sha: DIGEST },
        },
        expectedDigest: DIGEST,
        expectedImageRef: IMAGE_REF,
      }),
    ).toBe(DIGEST);

    expect(() =>
      verifyDeployImage({
        deploy: {
          id: "dep-1",
          image: { ref: `ghcr.io/${IMAGE_REPO}@${OTHER_DIGEST}`, sha: OTHER_DIGEST },
        },
        expectedDigest: DIGEST,
        expectedImageRef: IMAGE_REF,
      }),
    ).toThrow(/resolved to/);

    expect(() =>
      verifyDeployImage({
        deploy: { id: "dep-1" },
        expectedDigest: DIGEST,
        expectedImageRef: IMAGE_REF,
      }),
    ).toThrow(/no image provenance/);
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
});

describe("runRenderDeployment", () => {
  it("updates the saved image reference, deploys the same digest, and verifies live SHA", async () => {
    const { summary, calls, getSavedImagePath } = await runScenario({
      health: [() => healthy(SAMPLE_SHA)],
    });

    expect(summary.verified).toBe(true);
    expect(summary.expectedSha).toBe(SAMPLE_SHA);
    expect(summary.imageRef).toBe(IMAGE_REF);
    expect(summary.deployId).toBe("dep-1");
    expect(summary.deployStatus).toBe("live");
    expect(summary.deployImageRef).toBe(IMAGE_REF);
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
      (call) =>
        call.method === "POST" && call.path.endsWith("/deploys"),
    );
    expect(deploy?.body).toEqual({ imageUrl: IMAGE_REF });
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
        healthUrl: HEALTH_URL,
        getCurrentMainSha: harness.getCurrentMainSha,
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
        healthUrl: HEALTH_URL,
        getCurrentMainSha: harness.getCurrentMainSha,
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

    expect(failure).toBeInstanceOf(RenderDeployError);
    const gateError = failure as RenderDeployError & {
      summary: { verified: boolean; error: string };
      harness: ReturnType<typeof scenarioFetch>;
    };
    expect(gateError.code).toBe("DEPLOY_FAILED");
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
        healthUrl: HEALTH_URL,
        getCurrentMainSha: harness.getCurrentMainSha,
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
