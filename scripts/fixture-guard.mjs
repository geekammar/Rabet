/**
 * scripts/fixture-guard.mjs
 *
 * Guard utilities ensuring disposable PostgreSQL fixtures are:
 * 1. Checked for pre-existing conflicting state before startup (preserving foreign fixtures).
 * 2. Tracked with explicit ownership for the current run.
 * 3. Stopped upon cleanup if and only if the recorded helper state still matches the owned fixture.
 * 4. Never stopped if cleanup runs before successful startup.
 */

import { existsSync, readFileSync } from "node:fs";

/**
 * Safely reads and parses the PostgreSQL test state file.
 * Returns null if the file does not exist or contains invalid JSON.
 *
 * @param {string} stateFilePath
 * @returns {{ url?: string, datadir?: string, port?: number | string } | null}
 */
export function readPgState(stateFilePath) {
  if (!stateFilePath || !existsSync(stateFilePath)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(stateFilePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Checks whether an active disposable PostgreSQL fixture is already recorded.
 *
 * @param {string} stateFilePath
 * @returns {{ conflict: true, port: number | string, datadir: string, url?: string } | null}
 */
export function detectConflictingFixture(stateFilePath) {
  const existing = readPgState(stateFilePath);
  if (!existing || !existing.datadir) {
    return null;
  }
  return {
    conflict: true,
    port: existing.port,
    datadir: existing.datadir,
    url: existing.url,
  };
}

/**
 * Verifies that the state file still references the owned fixture before invoking stopFn.
 * Ensures:
 * - Failure before startup causes zero stop calls (when ownedFixture is null/falsy).
 * - Pre-existing/conflicting foreign fixture state remains untouched.
 * - Successful startup and cleanup stops only the matching owned fixture.
 *
 * @param {{
 *   stateFilePath: string,
 *   ownedFixture: { port: number | string, datadir: string, url?: string } | null,
 *   stopFn: (fixture: { port: number | string, datadir: string, url?: string }) => void,
 * }} options
 * @returns {{ stopped: boolean, reason?: string, ownedFixture?: object }}
 */
export function verifyAndStopOwnedFixture({ stateFilePath, ownedFixture, stopFn }) {
  if (!ownedFixture) {
    return { stopped: false, reason: "no_owned_fixture" };
  }

  const currentState = readPgState(stateFilePath);
  if (!currentState) {
    return { stopped: false, reason: "state_file_missing" };
  }

  const matches =
    currentState.datadir === ownedFixture.datadir &&
    String(currentState.port) === String(ownedFixture.port);

  if (!matches) {
    return { stopped: false, reason: "foreign_fixture_preserved" };
  }

  if (typeof stopFn === "function") {
    stopFn(ownedFixture);
  }

  return { stopped: true, ownedFixture };
}
