/**
 * No real Neon credential can be committed to this repository.
 *
 * The wizard's fixtures deliberately use obviously fake Neon endpoint hosts so
 * the redaction and masking paths are exercised on realistic-looking strings.
 * This test is the guard that keeps that honest: it scans every tracked file
 * for a connection string that carries a password and points at a Neon
 * endpoint, and fails unless that endpoint is one of the documented fake
 * fixtures.
 *
 * A real `ep-…-<region>.aws.neon.tech` string pasted into a script, a config
 * file, a workflow, a document or a test would be caught here, so the owner's
 * `Rabet_dev` password can never reach a public log or a clone. It also
 * asserts the only committed env file is the placeholder template.
 */

import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/**
 * The fake endpoint hosts the fixtures use. Every one is invented; none
 * resolves. A new fixture host is added here deliberately, which is the point:
 * a host that is not on this list fails the test and gets reviewed.
 */
const FAKE_FIXTURE_HOSTS = new Set([
  "ep-abc.eu-central-1.aws.neon.tech",
  "ep-abc.neon.tech",
  "ep-cool-12345.us-east-2.aws.neon.tech",
  "ep-cool-name-12345.us-east-2.aws.neon.tech",
  "ep-cool-pooler-12345.us-east-2.aws.neon.tech",
  "ep-example.neon.tech",
  "ep-flaky.us-east-2.aws.neon.tech",
  "ep-unreachable.us-east-2.aws.neon.tech",
  "host.neon.tech",
]);

/** A connection string that carries credentials and points at a Neon endpoint. */
const CREDENTIAL_NEON_URL = /postgres(?:ql)?:\/\/[^:@\s]+:[^@\s]+@[^@\s]*\.neon\.tech/gi;

function trackedFiles(): string[] {
  const stdout = execFileSync("git", ["ls-files"], {
    encoding: "utf8",
    cwd: process.cwd(),
  });

  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

describe("no real Neon credential is committed", () => {
  it("uses only the documented fake fixture endpoints", () => {
    const offenders: string[] = [];

    for (const file of trackedFiles()) {
      let contents: string;

      try {
        contents = readFileSync(file, "utf8");
      } catch {
        // Not readable as text (a binary asset); it cannot hold a URL.
        continue;
      }

      for (const match of contents.matchAll(CREDENTIAL_NEON_URL)) {
        const host = String(match[0])
          .split("@")
          .pop()!
          .split(/[/?:]/)[0]
          .toLowerCase();

        if (!FAKE_FIXTURE_HOSTS.has(host)) {
          offenders.push(`${file}: an endpoint that is not a fixture (${host})`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("commits no environment file but the placeholder template", () => {
    const envFiles = trackedFiles().filter((file) => /(^|\/)\.env/.test(file));

    expect(envFiles).toEqual([".env.example"]);
  });
});
