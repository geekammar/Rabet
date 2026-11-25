#!/usr/bin/env node
import fs from "node:fs";
import postgres from "postgres";

const RENDER_API_KEY = process.env.RENDER_API_KEY ?? "";
const SERVICE_ID = "srv-dc3jiiff3r2c738okfsg";
const OUT = process.env.SUMMARY_OUT ?? "/tmp/pr59-readonly-summary.json";

async function dbUrl() {
  const response = await fetch(`https://api.render.com/v1/services/${SERVICE_ID}/env-vars?limit=100`, {
    headers: { Authorization: `Bearer ${RENDER_API_KEY}`, Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Render env read failed HTTP ${response.status}`);
  const payload = JSON.parse(text);
  const rows = Array.isArray(payload) ? payload : payload?.envVars ?? [];
  for (const entry of rows) {
    const row = entry?.envVar ?? entry;
    if (row?.key === "DATABASE_URL" && typeof row.value === "string") return row.value;
  }
  throw new Error("DATABASE_URL missing");
}

async function main() {
  if (!RENDER_API_KEY) throw new Error("RENDER_API_KEY missing");
  const sql = postgres(await dbUrl(), { max: 1, connect_timeout: 30, ssl: "require" });
  try {
    const summary = await sql.begin("read only", async (tx) => {
      await tx`set transaction read only`;
      const [identity] = await tx`
        select current_database() as database, current_user as role,
          current_setting('transaction_read_only') as read_only,
          (select count(*)::int from drizzle.__drizzle_migrations) as ledger,
          (select hash from drizzle.__drizzle_migrations order by id desc limit 1) as last_hash
      `;
      const stores = await tx`
        select s.slug, s.name, s.status,
          c.id as connection_id, c.bot_id::text as bot_id, c.bot_username,
          c.status as connection_status, c.webhook_url
        from store s
        left join telegram_connection c on c.store_id = s.id
        order by s.slug, c.bot_id
      `;
      const defaults = await tx`
        select s.slug, l.locale
        from store_language_setting l join store s on s.id = l.store_id
        order by s.slug
      `;
      const languages = await tx`
        select code, is_enabled from language order by code
      `;
      const fixtures = await tx`
        select p.slug, p.price, i.on_hand, i.reserved, s.slug as store_slug
        from product p
        join product_inventory i on i.product_id = p.id
        join store s on s.id = p.store_id
        where p.slug like 'buyer-lang-qa-pr59-%' or p.slug like 'pr59-qa-%'
        order by p.slug
      `;
      const [counts] = await tx`
        select
          (select count(*)::int from store) as stores,
          (select count(*)::int from "order") as orders,
          (select count(*)::int from inventory_reservation) as reservations,
          (select count(*)::int from cart) as carts
      `;
      return {
        generatedAt: new Date().toISOString(),
        serviceId: SERVICE_ID,
        identity,
        counts,
        languages,
        defaults,
        fixtures,
        stores,
      };
    });
    fs.writeFileSync(OUT, JSON.stringify(summary, null, 2), { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(summary)}\n`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  process.stderr.write(`[pr59-readonly:FAIL] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
