import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import postgres from "postgres";

import {
  CANDIDATE, SERVICE_ID, candidateMigrations, databaseAction, deployCandidate,
  ledgerState, renderClient, stagingDatabaseOptions, validateService,
} from "../batch01-staging.mjs";

const migrations = candidateMigrations();
const prefix = migrations.slice(0, -1).map(({ hash, when }) => ({ hash, created_at: when }));
const previous = "d914f6c10ade37559b77d8652e3add6738a6c3ba";
const current = { id: "dep-dc4ue0h7lnhs739tujr0", status: "live", commit: { id: previous } };
const stageUrl = "https://nokmel-cod-staging.onrender.com";
const validDsn = "postgresql://rabet_cod_pr56:fixture@ep-tiny-star-b4dpybus.c-6.us-east-2.aws.neon.tech/rabet_cod_pr56?sslmode=require";

test("write modes require their own exact manual confirmation", () => {
  for (const args of [["migrate"], ["deploy", "MIGRATE_BATCH01_0021_STAGING"], ["inspect", "extra"]]) {
    const result = spawnSync(process.execPath, ["scripts/batch01-staging.mjs", ...args], {
      encoding: "utf8", env: { ...process.env, NOKMEL_STAGING_RENDER_API_KEY: "" },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /^Usage:/);
  }
});

test("database configuration is pinned and cannot weaken TLS or redirect the connection", () => {
  assert.deepEqual(stagingDatabaseOptions(validDsn).ssl, { rejectUnauthorized: true });
  for (const bad of [
    validDsn.replace("star-b4", "star-pooler-b4"),
    validDsn.replace("/rabet_cod_pr56?", "/wrong_database?"),
    validDsn.replace("rabet_cod_pr56:", "wrong_role:"),
    validDsn.replace("require", "disable"),
    validDsn + "&host=other.invalid",
    validDsn.replace(".tech/", ".tech:5433/"),
  ]) assert.throws(() => stagingDatabaseOptions(bad), /approved Staging/);
});

test("ledger requires every hash and timestamp through 0020 or the exact applied 0021", () => {
  assert.equal(ledgerState(prefix, migrations), "0021_pending");
  const last = migrations.at(-1);
  const applied = [...prefix, { hash: last.hash, created_at: last.when }];
  assert.equal(ledgerState(applied, migrations), "0021_applied");
  for (const ledger of [
    prefix.slice(1),
    [...applied, applied.at(-1)],
    [{ ...prefix[0], hash: "drift" }, ...prefix.slice(1)],
    [{ ...prefix[0], created_at: 1 }, ...prefix.slice(1)],
  ]) assert.throws(() => ledgerState(ledger, migrations), /ledger/);
});

test("Render client is pinned to the service and keeps provider errors out of diagnostics", async () => {
  const service = {
    id: SERVICE_ID, name: "nokmel-cod-staging", type: "web_service", suspended: "not_suspended",
    serviceDetails: { url: stageUrl }, repo: "https://github.com/geekammar/nokmel",
    autoDeployTrigger: "off",
  };
  assert.doesNotThrow(() => validateService(service));
  for (const bad of [{ id: "srv-other" }, { autoDeployTrigger: "commit" }, { repo: "https://github.com/other/repo" }]) {
    assert.throws(() => validateService({ ...service, ...bad }), /approved Staging/);
  }
  const render = renderClient("fixture-token", async (url, init) => {
    assert.equal(url, `https://api.render.com/v1/services/${SERVICE_ID}`);
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    return new Response("provider body with sensitive fixture", { status: 403 });
  });
  await assert.rejects(render("GET", ""), { message: "Render GET returned HTTP 403" });
});

function deployFixture({ deployments = [current], commit = CANDIDATE, healthSha = CANDIDATE } = {}) {
  const calls = [];
  let label = previous;
  let posted = false;
  const request = async (url, init) => {
    assert.equal(url, stageUrl + "/api/healthz");
    assert(!init.headers.Authorization);
    return Response.json({ status: "ok", sha: posted ? healthSha : (deployments[0]?.commit.id ?? previous) });
  };
  const render = async (method, path, body) => {
    calls.push([method, path, body]);
    if (path === "/deploys?limit=20") return deployments.map((deploy) => ({ deploy }));
    if (path === "/env-vars/RABET_BUILD_SHA") {
      if (method === "PUT") label = body.value;
      return { envVar: { key: "RABET_BUILD_SHA", value: label } };
    }
    if (path === "/deploys" && method === "POST") {
      posted = true;
      return { id: "dep-candidate" };
    }
    assert.equal(path, "/deploys/dep-candidate");
    return { id: "dep-candidate", commit: { id: commit }, status: "live" };
  };
  return { calls, run: () => deployCandidate(render, request, async () => {}, 2) };
}

test("deployment changes only the SHA label, sends commitId and requires the full health SHA", async () => {
  const fixture = deployFixture();
  assert.equal(await fixture.run(), "dep-candidate");
  assert.deepEqual(fixture.calls.filter(([method]) => method !== "GET"), [
    ["PUT", "/env-vars/RABET_BUILD_SHA", { value: CANDIDATE }],
    ["POST", "/deploys", { commitId: CANDIDATE }],
  ]);
  await assert.rejects(deployFixture({ commit: previous }).run(), /pinned candidate/);
  await assert.rejects(deployFixture({ healthSha: CANDIDATE.slice(0, 7) }).run(), /full candidate/);
});

test("unexpected or in-progress deploys stop before writing and the verified candidate is reusable", async () => {
  for (const deployments of [
    [{ ...current, id: "dep-other" }],
    [current, { ...current, status: "build_in_progress" }],
  ]) {
    const fixture = deployFixture({ deployments });
    await assert.rejects(fixture.run(), /Staging/);
    assert(fixture.calls.every(([method]) => method === "GET"));
  }
  const fixture = deployFixture({ deployments: [{ ...current, commit: { id: CANDIDATE } }] });
  assert.equal(await fixture.run(), current.id);
  assert(fixture.calls.every(([method]) => method === "GET"));
});

test("PostgreSQL fixture applies only 0021 atomically and rejects drift or a second write", {
  skip: !process.env.RABET_TEST_PG_URL,
}, async () => {
  const fixtureUrl = new URL(process.env.RABET_TEST_PG_URL);
  assert.equal(fixtureUrl.hostname, "127.0.0.1", "Use the disposable test harness");
  assert.equal(fixtureUrl.username, "rabet");
  assert.equal(fixtureUrl.pathname, "/postgres");
  assert(fixtureUrl.port && !fixtureUrl.password && !fixtureUrl.search);
  const admin = postgres(fixtureUrl.href, { ssl: false, onnotice: () => {} });
  let db;
  try {
    await admin`create role rabet_cod_pr56 login`;
    await admin`create database rabet_cod_pr56 owner rabet_cod_pr56`;
    db = postgres({
      host: "127.0.0.1", port: Number(fixtureUrl.port), database: "rabet_cod_pr56",
      username: "rabet_cod_pr56", ssl: false, onnotice: () => {},
    });
    await db.begin(async (tx) => {
      await tx`create schema drizzle`;
      await tx`
        create table drizzle.__drizzle_migrations (
          id serial primary key, hash text not null, created_at bigint
        )
      `;
      for (const entry of migrations.slice(0, -1)) {
        for (const statement of entry.sql.split("--> statement-breakpoint")) {
          if (statement.trim()) await tx.unsafe(statement);
        }
        await tx`insert into drizzle.__drizzle_migrations (hash, created_at) values (${entry.hash}, ${entry.when})`;
      }
      await tx`insert into store (name, slug) values ('Paid', 'paid-fixture'), ('Zero', 'zero-fixture')`;
      await tx`
        insert into store_commerce_setting (store_id, currency, delivery_fee)
        select id, 'EGP', case when slug = 'paid-fixture' then 25 else 0 end from store
      `;
    });
    assert.equal(await databaseAction(db, migrations, false), "0021_pending");
    await db`update drizzle.__drizzle_migrations set hash = 'wrong' where id = 1`;
    await assert.rejects(databaseAction(db, migrations, true), /ledger differs/);
    await db`update drizzle.__drizzle_migrations set hash = ${prefix[0].hash} where id = 1`;
    const last = migrations.at(-1);
    const broken = [...migrations.slice(0, -1), {
      ...last,
      sql: last.sql.replace("WHERE \"delivery_fee\" > 0", "WHERE false"),
    }];
    await assert.rejects(databaseAction(db, broken, true), /backfill verification failed/);
    assert.equal(await databaseAction(db, migrations, false), "0021_pending");
    assert.equal(await databaseAction(db, migrations, true), "0021_applied");
    assert.equal(await databaseAction(db, migrations, false), "0021_applied");
    await assert.rejects(databaseAction(db, migrations, true), /exactly 0021 pending/);
    const fees = await db`select delivery_fee_configured from store_commerce_setting order by delivery_fee`;
    assert.deepEqual(fees.map((row) => row.delivery_fee_configured), [false, true]);
  } finally {
    await db?.end({ timeout: 3 });
    await admin.end({ timeout: 3 });
  }
});
