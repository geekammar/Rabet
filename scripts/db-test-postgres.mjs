#!/usr/bin/env node
/**
 * scripts/db-test-postgres.mjs — a disposable, isolated PostgreSQL instance
 * for database migration and integration tests.
 *
 * Rabet's database tests must run against **real PostgreSQL** — the integrity
 * rules under test (cycles, cross-product parents, write-once snapshots,
 * partial unique indexes) are enforced by the server, so no amount of
 * TypeScript unit testing can prove them. This script provides the isolated
 * instance they run against, without ever touching a shared or production
 * database and without requiring Docker:
 *
 *   - `node scripts/db-test-postgres.mjs start` — initialize a brand-new
 *     cluster in a temporary directory (a throwaway `initdb`), start it on a
 *     free port bound to 127.0.0.1 with trust authentication, and print the
 *     connection string the tests connect to.
 *   - `node scripts/db-test-postgres.mjs stop` — stop it and delete the whole
 *     data directory. Nothing survives.
 *   - `node scripts/db-test-postgres.mjs run -- <command>` — start the
 *     instance, run `<command>` with `RABET_TEST_PG_URL` in its environment,
 *     then stop the instance and exit with the command's status, whatever
 *     happened. This is what `npm run test:db` uses.
 *
 * In CI the same tests run against a PostgreSQL service container, and the
 * workflow sets `RABET_TEST_PG_URL` directly, so this script is not needed
 * there.
 *
 * The instance is a superuser-own throwaway on a random port: it holds no real
 * data, it is not reachable off the loopback, and its entire data directory is
 * removed on stop. Standard library only — no dependency.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const STATE_FILE = path.join(os.tmpdir(), "rabet-test-pg.json");
const PG_SUPERUSER = "rabet";
const PG_OS_USER = process.env.PG_OS_USER ?? "postgres";
const MAX_PORT_PROBES = 20;

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`db-test-postgres: ${message}\n`);
  process.exit(1);
}

/** Locates the PostgreSQL server binaries (`initdb`, `pg_ctl`, `pg_isready`). */
function bindir() {
  const explicit = process.env.PG_BINDIR;

  if (explicit) return explicit;

  const { stdout, status } = spawnSync("pg_config", ["--bindir"], {
    encoding: "utf8",
  });

  if (status === 0 && stdout.trim()) return stdout.trim();

  fail(
    "could not locate the PostgreSQL server binaries. Install PostgreSQL " +
      "server tools, or set PG_BINDIR to the directory containing initdb " +
      "and pg_ctl. (The client tools alone are not enough to start an " +
      "instance.)",
  );
}

/**
 * Runs a command as the operating-system user that PostgreSQL is allowed to
 * run as. PostgreSQL refuses to run as root, so when this script is root it
 * delegates to the unprivileged `postgres` account and hands it a data
 * directory it owns.
 */
function runAsPgUser(command, args, options = {}) {
  if (process.getuid && process.getuid() === 0) {
    const sudo = spawnSync("sudo", ["-n", "-u", PG_OS_USER, command, ...args], {
      encoding: "utf8",
      ...options,
    });

    if (sudo.error && sudo.error.code === "ENOENT") {
      fail(
        `this script is running as root and passwordless 'sudo -u ${PG_OS_USER}' ` +
          "is unavailable, which PostgreSQL requires to start a server. Run " +
          "the tests as an unprivileged user, or provide RABET_TEST_PG_URL " +
          "pointing at an existing cluster instead.",
      );
    }

    return sudo;
  }

  return spawnSync(command, args, { encoding: "utf8", ...options });
}

/** Finds a free TCP port on 127.0.0.1 by briefly listening on it. */
async function freePort() {
  for (let attempt = 0; attempt < MAX_PORT_PROBES; attempt++) {
    const server = net.createServer();
    const port = await new Promise((resolve) => {
      server.once("listening", () => resolve(server.address().port));
      server.once("error", () => resolve(0));
      server.listen(0, "127.0.0.1");
    });

    server.close();

    if (port > 0) return port;
  }

  fail("could not find a free TCP port for the disposable PostgreSQL instance.");
}

function pgIsready(bin, port) {
  return spawnSync(path.join(bin, "pg_isready"), [
    "-h",
    "127.0.0.1",
    "-p",
    String(port),
    "-U",
    PG_SUPERUSER,
    "-d",
    "postgres",
    "-t",
    "2",
  ]);
}

async function start() {
  const bin = bindir();
  const datadir = path.join(os.tmpdir(), `rabet-pg-${process.pid}-${Date.now()}`);

  // PostgreSQL needs to own its data directory. Root creates it and hands
  // ownership over; an unprivileged caller already owns it.
  mkdirSync(datadir, { recursive: true });

  if (process.getuid && process.getuid() === 0) {
    const chown = spawnSync("chown", ["-R", `${PG_OS_USER}:${PG_OS_USER}`, datadir]);

    if (chown.status !== 0) {
      fail(`could not hand ownership of ${datadir} to ${PG_OS_USER}.`);
    }
  }

  log(`Initializing a disposable cluster at ${datadir}`);

  const init = runAsPgUser(path.join(bin, "initdb"), [
    "-D",
    datadir,
    "-A",
    "trust",
    "-U",
    PG_SUPERUSER,
    "--no-instructions",
  ]);

  if (init.status !== 0) {
    process.stderr.write(init.stderr ?? "");
    fail("initdb failed; see the output above.");
  }

  const port = await freePort();
  const logfile = path.join(datadir, "logfile");

  log(`Starting PostgreSQL on 127.0.0.1:${port}`);

  // Unix sockets are disabled so nothing else on the box can reach the
  // instance through the default socket directory; loopback TCP only.
  const started = runAsPgUser(path.join(bin, "pg_ctl"), [
    "-D",
    datadir,
    "-o",
    `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''`,
    "-l",
    logfile,
    "-w",
    "-t",
    "30",
    "start",
  ]);

  if (started.status !== 0) {
    process.stderr.write(started.stderr ?? "");
    fail("PostgreSQL did not start; see the log file in the data directory.");
  }

  // pg_ctl's -w waits for the postmaster; pg_isready confirms the port
  // actually accepts connections before we hand the URL out.
  let ready = { status: 0 };

  for (let attempt = 0; attempt < 15; attempt++) {
    ready = pgIsready(bin, port);

    if (ready.status === 0) break;

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (ready.status !== 0) {
    fail("the disposable PostgreSQL instance started but never accepted connections.");
  }

  // No password: trust authentication, loopback only, throwaway data.
  const url = `postgresql://${PG_SUPERUSER}@127.0.0.1:${port}/postgres`;

  writeFileSync(STATE_FILE, JSON.stringify({ url, datadir, port }, null, 2));

  log(url);
  log(
    "Set RABET_TEST_PG_URL to this value, or use 'run -- <command>' which " +
      "sets it for you. Stop with: node scripts/db-test-postgres.mjs stop",
  );
}

function readState() {
  if (!existsSync(STATE_FILE)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function stop() {
  const state = readState();

  if (!state) {
    log("No disposable instance is recorded as running. Nothing to stop.");
    return;
  }

  const bin = bindir();

  log(`Stopping the disposable PostgreSQL instance on port ${state.port}`);

  runAsPgUser(path.join(bin, "pg_ctl"), [
    "-D",
    state.datadir,
    "-m",
    "immediate",
    "stop",
  ]);

  rmSync(state.datadir, { recursive: true, force: true });
  rmSync(STATE_FILE, { force: true });

  log("Stopped and the throwaway data directory was deleted.");
}

async function run(rest) {
  // The documented form is `run -- <command...>`. `process.argv` keeps the
  // literal `--`, so strip exactly one leading separator if it is present; the
  // bare `run <command...>` form works too.
  const args = rest.length > 0 && rest[0] === "--" ? rest.slice(1) : rest;
  const [command, ...commandArgs] = args;

  if (!command) {
    fail("'run' needs a command after '--', e.g. run -- npx vitest run tests/db");
  }

  await start();

  const state = readState();

  const child = spawn(command, commandArgs, {
    stdio: "inherit",
    env: {
      ...process.env,
      RABET_TEST_PG_URL: state.url,
    },
  });

  child.on("exit", (code, signal) => {
    stop();

    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 1);
    }
  });
}

const [, , mode, ...rest] = process.argv;

switch (mode) {
  case "start":
    await start();
    break;
  case "stop":
    stop();
    break;
  case "run":
    await run(rest);
    break;
  default:
    fail(
      "usage: db-test-postgres.mjs <start|stop|run -- command...>\n" +
        "  start  initialize and start a disposable PostgreSQL instance\n" +
        "  stop   stop it and delete its data directory\n" +
        "  run    start, run a command with RABET_TEST_PG_URL set, then stop",
    );
}
