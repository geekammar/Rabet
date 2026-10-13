/**
 * The wizard's process boundary: real exit codes and real stdin handling.
 *
 * The flow suite drives `runWizard()` in-process, which is where every branch
 * is covered. This file is the smaller, slower complement: it spawns the real
 * CLI as a child process and asserts the contract an operator's terminal (or
 * an SSH client on an Android phone) actually sees:
 *
 *   - `--help` exits 0 and prints the usage;
 *   - an unknown option exits 2 with the help;
 *   - an unresolved problem exits NON-zero, so a script can tell it failed;
 *   - an interrupted session (stdin closed, no answer possible) stops instead
 *     of hanging, and exits non-zero;
 *   - a connection failure reports actionable, credential-free guidance.
 *
 * No database is contacted. The connection failure test points at a loopback
 * port nothing listens on, so it fails in milliseconds and the only thing under
 * test is the wizard's handling of that failure.
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

const script = path.resolve(process.cwd(), "scripts", "setup-neon-dev.mjs");

/** Runs the real CLI, returning its exit status and combined output. */
function runCli(args: string[], env: Record<string, string> = {}, input = "") {
  const result = spawnSync(process.execPath, [script, ...args], {
    input,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });

  return {
    code: typeof result.status === "number" ? result.status : -1,
    output: [result.stdout, result.stderr].join(""),
  };
}

describe("cli process boundary", () => {
  it("prints the usage and exits 0 for --help", () => {
    const { code, output } = runCli(["--help"]);

    expect(code).toBe(0);
    expect(output).toContain("Usage:");
    expect(output).toContain("npm run db:setup:dev");
    expect(output).toContain("--check");
  });

  it("exits 2 for an unknown option and shows the help", () => {
    const { code, output } = runCli(["--nope"]);

    expect(code).toBe(2);
    expect(output).toContain("Unknown option: --nope");
    expect(output).toContain("Usage:");
  });

  it("exits non-zero when nothing was entered, instead of hanging", () => {
    // An interrupted session: stdin ends before any prompt can be answered.
    const { code, output } = runCli(["--check"], {}, "");

    expect(code).not.toBe(0);
    expect(output).toContain("Cancelled");
    expect(output).toContain("nothing was written");
  });

  it("exits non-zero on an unreachable database and never prints the password", () => {
    // A loopback port nothing listens on, so the connection fails fast. The
    // exported value is offered first, and the closed stdin accepts the
    // default — the wizard then fails bounded and credential-free.
    const { code, output } = runCli(
      ["--check"],
      {
        DATABASE_URL: "postgresql://rabet:never-print-this@127.0.0.1:1/nonexistent",
      },
      "",
    );

    expect(code).not.toBe(0);
    expect(output).not.toContain("never-print-this");
    expect(output).toMatch(/Input ended|unreachable|Could not connect/);
  });
});
