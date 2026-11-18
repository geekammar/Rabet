import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockConnection = vi.fn().mockResolvedValue(undefined);

vi.mock("next/server", () => ({
  connection: () => mockConnection(),
}));

vi.mock("@/auth", () => ({
  auth: (handler: unknown) => handler,
}));

import nextConfig from "../next.config";
import { config as proxyConfig } from "../src/proxy";
import { GET } from "../src/app/api/healthz/route";

describe("GET /api/healthz", () => {
  const originalBuildSha = process.env.RABET_BUILD_SHA;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.RABET_BUILD_SHA;
  });

  afterEach(() => {
    if (originalBuildSha === undefined) {
      delete process.env.RABET_BUILD_SHA;
    } else {
      process.env.RABET_BUILD_SHA = originalBuildSha;
    }
  });

  it("returns minimal 200 status and opts out of build-time prerendering and HTTP caching", async () => {
    const res = await GET();

    expect(mockConnection).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ status: "ok" });
  });

  it("includes normalized lowercase build sha when RABET_BUILD_SHA is a valid git revision", async () => {
    process.env.RABET_BUILD_SHA = "  F30A29D66ECAD4F174195E04F71A791D2C782FC2  ";

    const res = await GET();
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      status: "ok",
      sha: "f30a29d66ecad4f174195e04f71a791d2c782fc2",
    });
  });

  it("omits sha when RABET_BUILD_SHA is empty or not a valid hex revision", async () => {
    for (const candidate of ["", "   ", "not-a-git-sha", "12345", "xyz1234567"]) {
      process.env.RABET_BUILD_SHA = candidate;
      const res = await GET();
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({ status: "ok" });
    }
  });

  it("does not import database, Telegram, or authentication modules", () => {
    const routeSource = readFileSync(
      path.join(process.cwd(), "src/app/api/healthz/route.ts"),
      "utf8",
    );

    expect(routeSource).not.toMatch(/@\/db/);
    expect(routeSource).not.toMatch(/@\/lib\/data/);
    expect(routeSource).not.toMatch(/@\/lib\/telegram/);
    expect(routeSource).not.toMatch(/@\/auth/);
  });
});

describe("standalone build and proxy liveness configuration", () => {
  it("enables standalone output while preserving Cache Components", () => {
    expect(nextConfig.output).toBe("standalone");
    expect(nextConfig.cacheComponents).toBe(true);
    expect(nextConfig.partialPrefetching).toBe(true);
  });

  it("excludes /api/healthz from the Auth.js proxy matcher while keeping dashboard routes matched", () => {
    const pattern = proxyConfig.matcher[0];
    // Convert Next.js path-to-regexp matcher `/:rest` style into a pure regex check on pathname without leading slash
    const inner = pattern.replace(/^\//, "");
    const regex = new RegExp(`^${inner}$`);

    expect(regex.test("api/healthz")).toBe(false);
    expect(regex.test("api/auth/session")).toBe(false);
    expect(regex.test("manifest.webmanifest")).toBe(false);
    expect(regex.test("icons/icon-192x192.png")).toBe(false);

    expect(regex.test("overview")).toBe(true);
    expect(regex.test("settings")).toBe(true);
    expect(regex.test("inquiries/123")).toBe(true);
    expect(regex.test("api/telegram/webhook")).toBe(true);
  });
});
