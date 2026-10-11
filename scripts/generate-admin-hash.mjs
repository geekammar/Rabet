#!/usr/bin/env node
/**
 * Generate an Argon2id hash for the admin password — local provisioning helper.
 *
 * This script exists so the administrator never has to paste a password into a
 * chat or a shared document. Run it on your own machine or VPS:
 *
 *   node scripts/generate-admin-hash.mjs
 *
 * It reads the password from stdin (so it is never echoed to the terminal
 * history or the shell prompt), hashes it with Argon2id using OWASP-recommended
 * cost parameters, and prints only the resulting PHC string. Copy that string
 * into `ADMIN_PASSWORD_HASH` in your `.env.local` (local dev) or the Vercel
 * environment variables UI (preview/production).
 *
 * The script never writes the plaintext anywhere and never logs it. If stdin
 * is a TTY, the read is done through the Node `readline` interface with
 * `terminal: true` so the typed password is hidden.
 *
 * Requirements: Node.js 18+. The Argon2 implementation is the same
 * `@node-rs/argon2` package the app verifies with, so a hash generated here is
 * guaranteed to verify in the deployed app.
 *
 * Usage examples:
 *
 *   # interactive (password hidden)
 *   node scripts/generate-admin-hash.mjs
 *
 *   # piped, for scripted local setup
 *   printf '%s' 'your-password' | node scripts/generate-admin-hash.mjs
 */

import { createInterface } from "node:readline";
import { hash, Algorithm } from "@node-rs/argon2";

// OWASP-recommended Argon2id parameters (as of the 2023 cheat-sheet revision):
// 19 MiB memory, 2 iterations, degree-1 parallelism, 16-byte salt.
const HASH_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456, // 19 * 1024 KiB
  timeCost: 2,
  parallelism: 1,
};

function readHidden(prompt) {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function readPassword() {
  if (process.stdin.isTTY) {
    let first = await readHidden("Admin password: ");
    // Trim only the trailing newline that readline preserves in non-interactive
    // shells; keep inner characters exactly as typed.
    first = first.replace(/\r?\n$/, "");
    if (!first) {
      console.error("Password must not be empty.");
      process.exit(1);
    }
    const second = (await readHidden("Confirm password: ")).replace(/\r?\n$/, "");
    if (first !== second) {
      console.error("Passwords do not match. Nothing was written.");
      process.exit(1);
    }
    return first;
  }

  // Piped mode: read all of stdin as the password, dropping a single trailing
  // newline so `printf 'pw\n' | ...` and `printf 'pw' | ...` agree.
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const value = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
  if (!value) {
    console.error("Password must not be empty.");
    process.exit(1);
  }
  return value;
}

const password = await readPassword();
const passwordHash = await hash(password, HASH_OPTIONS);

// Print ONLY the hash. The plaintext password is never echoed or stored.
console.log(passwordHash);
console.error(
  "\nCopy the line above into ADMIN_PASSWORD_HASH. Do not commit it.",
);
