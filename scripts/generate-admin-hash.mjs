#!/usr/bin/env node
/**
 * Generate an Argon2id hash for the admin password — local provisioning helper.
 *
 * This script exists so the administrator never has to paste a password into a
 * chat or a shared document. Run it on your own machine or VPS:
 *
 *   node scripts/generate-admin-hash.mjs
 *
 * It prompts for the password (twice, to guard against a typo), hashes it with
 * Argon2id using OWASP-recommended cost parameters, and prints only the
 * resulting PHC string. Copy that string into `ADMIN_PASSWORD_HASH` in your
 * `.env.local` (local dev) or the Vercel environment variables UI
 * (preview/production).
 *
 * The script never writes the plaintext anywhere and never logs it. On an
 * interactive terminal the password is read with the terminal switched to raw
 * mode, which disables the OS-level echo of keystrokes — the same mechanism
 * `sudo` and `read -s` use. Nothing is echoed, not even a placeholder, so not
 * even the password's length is revealed. (Node's `readline.question()` — even
 * with `terminal: true` — echoes each typed character, and is deliberately NOT
 * used here.)
 *
 * If stdin is not a terminal (a pipe or a redirect) the script reads all of
 * stdin as the password instead, for automated setups. Never put the password
 * literally on the shell command line — `printf 'pw' | ...` and similar forms
 * are recorded in the shell history and in the process list. Feed it from a
 * secret manager or a pipe that never touches the command line or a file.
 *
 * Requirements: Node.js 18+. The Argon2 implementation is the same
 * `@node-rs/argon2` package the app verifies with, so a hash generated here is
 * guaranteed to verify in the deployed app.
 *
 * Usage examples:
 *
 *   # interactive (recommended) — password is never echoed
 *   node scripts/generate-admin-hash.mjs
 *
 *   # piped from another process, for scripted local setup
 *   some-secret-provider | node scripts/generate-admin-hash.mjs
 */

import { hash, Algorithm } from "@node-rs/argon2";

// OWASP-recommended Argon2id parameters (as of the 2023 cheat-sheet revision):
// 19 MiB memory, 2 iterations, degree-1 parallelism, 16-byte salt.
const HASH_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456, // 19 * 1024 KiB
  timeCost: 2,
  parallelism: 1,
};

/**
 * Read a line from an interactive terminal without echoing it.
 *
 * `setRawMode(true)` hands the terminal to the process in raw mode, where the
 * kernel's line discipline no longer echoes keystrokes and no longer line-buffers
 * input. Bytes are collected here and never written to stdout, so the typed
 * password is not shown, not logged, and not recoverable from scrollback.
 *
 * Control characters are handled explicitly because raw mode disables their
 * default terminal behaviour: Enter (CR/LF) submits, Backspace/Delete drops the
 * last byte, Ctrl-U clears the line, Ctrl-C aborts like a normal interrupt, and
 * Ctrl-D on an empty line aborts.
 *
 * The terminal is always restored before the promise settles or the process
 * exits, so a prompt can never leave the user's shell stuck in raw mode.
 */
function readHidden(prompt) {
  return new Promise((resolve, reject) => {
    const { stdin, stdout } = process;

    stdout.write(prompt);
    const bytes = [];
    let settled = false;

    const restore = () => {
      if (settled) return;
      settled = true;
      stdin.removeListener("data", onData);
      stdin.removeListener("error", onError);
      stdin.removeListener("close", onClose);
      try {
        stdin.setRawMode(false);
      } catch {
        // The stream may already be closed; the terminal restores itself.
      }
      stdin.pause();
    };

    const onData = (chunk) => {
      // A Buffer iterates as raw byte values, which is what the control
      // handling below depends on.
      for (const byte of chunk) {
        if (byte === 0x03) {
          // Ctrl-C: mirror a normal terminal interrupt.
          restore();
          stdout.write("\n");
          process.exit(130);
          return;
        }
        if (byte === 0x04) {
          // Ctrl-D: end-of-input. On an empty line this is a cancellation;
          // mid-line it is ignored, matching shell behaviour.
          if (bytes.length === 0) {
            restore();
            stdout.write("\n");
            console.error("Aborted: no password was entered.");
            process.exit(1);
          }
          continue;
        }
        if (byte === 0x0d || byte === 0x0a) {
          // Enter: submit the collected bytes as UTF-8 and emit a newline so
          // the next prompt starts on its own line.
          const value = Buffer.from(bytes).toString("utf8");
          restore();
          stdout.write("\n");
          resolve(value);
          return;
        }
        if (byte === 0x7f || byte === 0x08) {
          // DEL (0x7f) or Backspace (0x08): drop the last character. Nothing
          // was echoed, so there is nothing to erase on screen. A UTF-8
          // character is one lead byte (0x00-0x7f or 0xc2-0xf4) followed by
          // continuation bytes (0x80-0xbf), so remove those first; without
          // this a single press on a multi-byte character would leave a stray
          // lead byte and corrupt the submitted password.
          while (bytes.length > 0) {
            const last = bytes[bytes.length - 1];
            bytes.pop();
            // Stop after removing a byte that can start a character.
            if (last <= 0x7f || last >= 0xc2) break;
          }
          continue;
        }
        if (byte === 0x15) {
          // Ctrl-U: clear the whole line.
          bytes.length = 0;
          continue;
        }
        // Any other byte is part of the input. Multi-byte UTF-8 sequences are
        // assembled correctly because the whole buffer is decoded at once.
        bytes.push(byte);
      }
    };

    const onError = (error) => {
      restore();
      reject(error);
    };

    const onClose = () => {
      restore();
      reject(new Error("stdin closed before a password was submitted"));
    };

    stdin.on("data", onData);
    stdin.on("error", onError);
    stdin.on("close", onClose);
    stdin.setRawMode(true);
    stdin.resume();
  });
}

async function readPassword() {
  // Piped / redirected stdin is not a terminal, so there is nothing to echo.
  // Read the whole stream and use it as the password, dropping a single
  // trailing newline so `printf 'pw\n' | ...` and `printf 'pw' | ...` agree.
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const value = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
    if (!value) {
      console.error("Password must not be empty.");
      process.exit(1);
    }
    return value;
  }

  // Interactive terminal. Echo can only be suppressed by switching the tty to
  // raw mode. If that is unavailable the password would be echoed in cleartext,
  // so fail closed instead of risking the exposure.
  if (typeof process.stdin.setRawMode !== "function") {
    console.error(
      "Refusing to prompt: this terminal does not support non-echoing input, " +
        "so the password would be displayed. Pipe it on stdin instead, e.g. " +
        "from a secret provider (never as a literal on the command line).",
    );
    process.exit(1);
  }

  const first = await readHidden("Admin password: ");
  if (!first) {
    console.error("Password must not be empty.");
    process.exit(1);
  }
  const second = await readHidden("Confirm password: ");
  if (first !== second) {
    console.error("Passwords do not match. Nothing was written.");
    process.exit(1);
  }
  return first;
}

const password = await readPassword();
const passwordHash = await hash(password, HASH_OPTIONS);

// Print ONLY the hash. The plaintext password is never echoed or stored.
console.log(passwordHash);
console.error(
  "\nCopy the line above into ADMIN_PASSWORD_HASH. Do not commit it.",
);
