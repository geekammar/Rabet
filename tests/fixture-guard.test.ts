import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  detectConflictingFixture,
  readPgState,
  verifyAndStopOwnedFixture,
} from "../scripts/fixture-guard.mjs";

describe("Disposable PostgreSQL Fixture Ownership & Conflict Guards", () => {
  let testTempDir: string;
  let testStateFile: string;

  beforeEach(() => {
    testTempDir = mkdtempSync(path.join(tmpdir(), "rabet-guard-test-"));
    testStateFile = path.join(testTempDir, "rabet-test-pg.json");
  });

  afterEach(() => {
    try {
      rmSync(testTempDir, { recursive: true, force: true });
    } catch {}
  });

  it("1. Failure before startup causes zero stop calls", () => {
    const mockStopFn = vi.fn();

    // When an error or early abort occurs before database startup, ownedFixture is null.
    const result = verifyAndStopOwnedFixture({
      stateFilePath: testStateFile,
      ownedFixture: null,
      stopFn: mockStopFn,
    });

    expect(result.stopped).toBe(false);
    expect(result.reason).toBe("no_owned_fixture");
    expect(mockStopFn).toHaveBeenCalledTimes(0);
  });

  it("2. Pre-existing/conflicting fixture state remains untouched", () => {
    const mockStopFn = vi.fn();

    // Simulate an existing fixture started by another process
    const foreignFixture = {
      port: 54399,
      datadir: path.join(testTempDir, "foreign-datadir"),
      url: "postgresql://rabet@127.0.0.1:54399/postgres",
    };
    writeFileSync(testStateFile, JSON.stringify(foreignFixture, null, 2), "utf8");

    // Pre-startup check detects conflicting fixture
    const conflict = detectConflictingFixture(testStateFile);
    expect(conflict).not.toBeNull();
    expect(conflict?.conflict).toBe(true);
    expect(conflict?.port).toBe(54399);
    expect(conflict?.datadir).toBe(foreignFixture.datadir);

    // If cleanup is invoked with a different owned fixture (or null), foreign fixture is preserved
    const anotherRunFixture = {
      port: 54321,
      datadir: path.join(testTempDir, "another-datadir"),
      url: "postgresql://rabet@127.0.0.1:54321/postgres",
    };

    const cleanupResult = verifyAndStopOwnedFixture({
      stateFilePath: testStateFile,
      ownedFixture: anotherRunFixture,
      stopFn: mockStopFn,
    });

    expect(cleanupResult.stopped).toBe(false);
    expect(cleanupResult.reason).toBe("foreign_fixture_preserved");
    expect(mockStopFn).toHaveBeenCalledTimes(0);

    // Verify foreign state file remains completely untouched
    expect(existsSync(testStateFile)).toBe(true);
    const stateOnDisk = readPgState(testStateFile);
    expect(stateOnDisk?.port).toBe(foreignFixture.port);
    expect(stateOnDisk?.datadir).toBe(foreignFixture.datadir);
  });

  it("3. Successful startup and cleanup stop only the matching owned fixture", () => {
    const mockStopFn = vi.fn();

    // Record the owned fixture created by this run
    const ownedFixture = {
      port: 54311,
      datadir: path.join(testTempDir, "owned-datadir"),
      url: "postgresql://rabet@127.0.0.1:54311/postgres",
    };
    writeFileSync(testStateFile, JSON.stringify(ownedFixture, null, 2), "utf8");

    // Cleanup when state matches owned fixture
    const cleanupResult = verifyAndStopOwnedFixture({
      stateFilePath: testStateFile,
      ownedFixture,
      stopFn: (fixture) => {
        mockStopFn(fixture);
        // Simulate stop removing state file
        rmSync(testStateFile, { force: true });
      },
    });

    expect(cleanupResult.stopped).toBe(true);
    expect(cleanupResult.ownedFixture).toEqual(ownedFixture);
    expect(mockStopFn).toHaveBeenCalledTimes(1);
    expect(mockStopFn).toHaveBeenCalledWith(ownedFixture);
    expect(existsSync(testStateFile)).toBe(false);

    // Subsequent cleanup call causes zero stop calls
    const secondCleanup = verifyAndStopOwnedFixture({
      stateFilePath: testStateFile,
      ownedFixture,
      stopFn: mockStopFn,
    });
    expect(secondCleanup.stopped).toBe(false);
    expect(secondCleanup.reason).toBe("state_file_missing");
    expect(mockStopFn).toHaveBeenCalledTimes(1);
  });
});
