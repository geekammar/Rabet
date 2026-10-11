/**
 * Tests for the local admin password provisioning helper
 * (`scripts/generate-admin-hash.mjs`).
 *
 * Two properties matter:
 *
 * 1. The script still produces an Argon2id PHC string that the application's
 *    own verifier accepts — a hash generated here must work in the deployed
 *    app, using the same OWASP-recommended cost parameters.
 * 2. The interactive prompt must never echo the typed password. The previous
 *    `readline.question()` implementation echoed every character; these tests
 *    drive the script through a real pseudo-terminal to prove the fix.
 *
 * Every password here is synthetic and exists only for the duration of the
 * test. None is written to disk, logged or printed, and the child processes are
 * fed on stdin so nothing ever lands on a shell command line.
 */

import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verify } from "@node-rs/argon2";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.resolve(dirname, "..", "scripts", "generate-admin-hash.mjs");

/** A synthetic password long enough for any minimum-length check. */
const SYNTHETIC_PASSWORD = "provisioning-test-password-8842";
/** A different synthetic password, used for the mismatch control. */
const OTHER_PASSWORD = "a-totally-different-synthetic-password";

/**
 * Run the script with a piped (non-TTY) stdin. Returns the collected output and
 * exit code. Piping is the non-interactive path: the script reads all of stdin
 * and never prompts, so no terminal is involved.
 */
function runPiped(input: string): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    // Write the password and close stdin so the script's stdin loop ends.
    child.stdin.write(input);
    child.stdin.end();
  });
}

/**
 * Run the script inside a real pseudo-terminal (via `script`) and drive the two
 * prompts. `script` allocates a PTY, so the child sees stdin as a TTY and takes
 * the interactive code path — the only path that can echo.
 *
 * Keystrokes are written only *after* each prompt appears, mirroring a human,
 * so the terminal is already in raw mode when they arrive. The full byte stream
 * the terminal produced is captured for the echo assertion.
 */
function runInteractive(password: string, confirm: string): Promise<{
  code: number;
  transcript: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "script",
      ["-qec", `${process.execPath} ${scriptPath}`, "/dev/null"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );

    let transcript = "";
    const onData = (chunk: Buffer) => (transcript += chunk.toString());
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    const waitFor = (needle: string, timeout = 15_000) =>
      new Promise<void>((resolveWait, rejectWait) => {
        const timer = setTimeout(() => {
          rejectWait(
            new Error(
              `timed out waiting for prompt "${needle}"; transcript: ${JSON.stringify(transcript)}`,
            ),
          );
        }, timeout);
        const interval = setInterval(() => {
          if (transcript.includes(needle)) {
            clearTimeout(timer);
            clearInterval(interval);
            resolveWait();
          }
        }, 50);
      });

    (async () => {
      await waitFor("Admin password:");
      child.stdin.write(`${password}\r`);
      await waitFor("Confirm password:");
      child.stdin.write(`${confirm}\r`);
      const code = await new Promise<number>((resolveExit) =>
        child.on("exit", (code) => resolveExit(code ?? -1)),
      );
      // Give the final bytes (the hash) time to arrive through the PTY.
      await new Promise((resolveTick) => setTimeout(resolveTick, 300));
      resolve({ code, transcript });
    })().catch(reject);
  });
}

describe("piped (non-interactive) provisioning", () => {
  it("emits an Argon2id PHC string that the app verifier accepts", async () => {
    const { code, stdout } = await runPiped(SYNTHETIC_PASSWORD);
    expect(code).toBe(0);

    const lines = stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    const phc = lines[0];
    expect(phc).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    // The hash must verify with the same package the application uses.
    await expect(verify(phc, SYNTHETIC_PASSWORD)).resolves.toBe(true);
    // A wrong password must not verify — proves the hash is real, not a stub.
    await expect(verify(phc, OTHER_PASSWORD)).resolves.toBe(false);
  });

  it("accepts a trailing newline and treats it as part of the pipe, not the password", async () => {
    const { stdout } = await runPiped(`${SYNTHETIC_PASSWORD}\n`);
    const phc = stdout.trim();
    expect(phc).toMatch(/^\$argon2id\$/);
    await expect(verify(phc, SYNTHETIC_PASSWORD)).resolves.toBe(true);
  });

  it("rejects an empty password and prints no hash", async () => {
    const { code, stdout, stderr } = await runPiped("");
    expect(code).toBe(1);
    expect(stderr).toContain("Password must not be empty.");
    expect(stdout).not.toMatch(/\$argon2id\$/);
  });

  it("never writes the plaintext password to stdout or stderr", async () => {
    const { code, stdout, stderr } = await runPiped(SYNTHETIC_PASSWORD);
    expect(code).toBe(0);
    // The plaintext must not appear anywhere in either stream. The emitted hash
    // is the only secret-derived value allowed in the output.
    expect(stdout).not.toContain(SYNTHETIC_PASSWORD);
    expect(stderr).not.toContain(SYNTHETIC_PASSWORD);
  });
});

describe("interactive prompt never echoes the password", () => {
  // PTY-driven tests require the `script` utility, which is absent on Windows.
  const hasScript = process.platform !== "win32";
  const maybe = hasScript ? it : it.skip;

  maybe("hides both prompts' input in a real terminal", async () => {
    const { code, transcript } = await runInteractive(
      SYNTHETIC_PASSWORD,
      SYNTHETIC_PASSWORD,
    );
    expect(code).toBe(0);

    // The prompts and the hash are expected; the password is not. Even its
    // length must not leak, so no placeholder characters are echoed either.
    expect(transcript).toContain("Admin password:");
    expect(transcript).toContain("Confirm password:");
    expect(transcript).not.toContain(SYNTHETIC_PASSWORD);
    expect(transcript).not.toContain("*".repeat(SYNTHETIC_PASSWORD.length));

    const match = transcript.match(/\$argon2id\$[^\s]+/);
    expect(match).not.toBeNull();
    await expect(verify(match![0], SYNTHETIC_PASSWORD)).resolves.toBe(true);
  });

  maybe("reports a mismatch and exits without printing a hash", async () => {
    const { code, transcript } = await runInteractive(
      SYNTHETIC_PASSWORD,
      OTHER_PASSWORD,
    );
    expect(code).toBe(1);
    expect(transcript.toLowerCase()).toContain("do not match");
    expect(transcript).not.toContain(SYNTHETIC_PASSWORD);
    expect(transcript).not.toContain(OTHER_PASSWORD);
    expect(transcript).not.toMatch(/\$argon2id\$/);
  });
});

describe("documentation does not encourage password exposure", () => {
  it("script header never shows a password literal piped on the command line", () => {
    const source = readFileSync(scriptPath, "utf8");
    // The old example piped a literal `'your-password'`, which would land in
    // shell history. The header must no longer suggest that.
    expect(source).not.toContain("'your-password'");
    expect(source).not.toMatch(/printf\s+'%s'\s+'[^']/);
  });
});

describe("generated hash is accepted by the app's own configuration check", () => {
  it("passes getAdminConfig() so an operator cannot be locked out by a format mismatch", async () => {
    // The script's PHC output must satisfy exactly the validation the
    // application performs at startup — otherwise a correctly-generated hash
    // would leave the deployment failing closed.
    const { getAdminConfig } = await import("../src/lib/auth/admin-config");

    const previousEmail = process.env.ADMIN_EMAIL;
    const previousHash = process.env.ADMIN_PASSWORD_HASH;
    try {
      const { code, stdout } = await runPiped(SYNTHETIC_PASSWORD);
      expect(code).toBe(0);
      const phc = stdout.trim();

      process.env.ADMIN_EMAIL = "admin@example.test";
      process.env.ADMIN_PASSWORD_HASH = phc;
      expect(getAdminConfig()).toEqual({
        email: "admin@example.test",
        passwordHash: phc,
      });
    } finally {
      // Restore the suite-wide synthetic environment set by tests/setup.ts.
      if (previousEmail === undefined) delete process.env.ADMIN_EMAIL;
      else process.env.ADMIN_EMAIL = previousEmail;
      if (previousHash === undefined) delete process.env.ADMIN_PASSWORD_HASH;
      else process.env.ADMIN_PASSWORD_HASH = previousHash;
    }
  });
});
