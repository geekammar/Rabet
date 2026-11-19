# Transactional database client (Phase 2B-1)

The merchant invitation service needs interactive database transactions. The
application client in `src/db/client.ts` stays on Neon HTTP for every existing
read and write; HTTP has no interactive transaction, so this slice adds one
server-only `postgres-js` client for the invitation service only. No route,
Server Action, dashboard page, merchant session or operator flow imports it
yet.

## Configuration

Both clients read the same runtime `DATABASE_URL`. The transactional client is
created lazily by `getTransactionDb()` on first use and then reused for the
life of the process. Importing `src/db/transaction-client.ts` neither requires
the variable nor opens a connection. A missing or malformed value fails at
first use with a credential-free message.

Tests do not use `DATABASE_URL`. `createTransactionClient(url)` takes the
disposable database URL explicitly through the same construction path and
returns the real Drizzle client plus a `close()` that releases the pool before
the test database is dropped. The explicit path never falls back to the
runtime variable.

## Effective TLS configuration

The locked driver is `postgres` 3.4.9. It maps a URL's `sslmode` to its `ssl`
driver option. In that version, `ssl: "require"`, `"allow"` and `"prefer"` all
call `tls.connect` with `rejectUnauthorized: false`: the connection is
encrypted, but the server certificate and hostname are not verified. An
ordinary Neon URL with only `?sslmode=require` is therefore not equivalent to
`verify-full`.

For `*.neon.tech` hosts, `connectionOptions()` always passes the explicit
driver option `ssl: "verify-full"`. postgres.js selects an explicit driver
option ahead of the URL query, so the final options are verified TLS with
certificate and hostname checking regardless of the URL:

- An existing Neon `DATABASE_URL` with `?sslmode=require` needs no secret
  edit; its effective driver option becomes `verify-full`.
- An explicit `sslmode=verify-full` remains verified.
- A missing `sslmode`, weaker modes such as `disable`, `allow` or `prefer`,
  and duplicate or conflicting URL TLS parameters cannot weaken a Neon
  connection. The explicit driver option is final.
- Non-Neon hosts, including the disposable loopback cluster, use their URL as
  written, so the local test cluster stays plain TCP.
- The client uses the existing Drizzle schema map and returns
  `PostgresJsDatabase<typeof schema>`, the type `MerchantInvitationDb` already
  declares. No cast is needed at the service call site.

The tests assert the real postgres.js client's final `options.ssl` value. They
do not perform a live TLS handshake against Neon, and no isolated Neon or
Render target was used.

## Per-process limits

| Limit | Value |
| --- | --- |
| Maximum pooled connections | 5 |
| Connection timeout | 10 seconds |
| Idle timeout | 20 seconds |
| Maximum connection lifetime | 5 minutes |

The pool is process-wide, not per invitation. The HTTP client and its callers
are unchanged.

## Proof

`tests/db/transaction-client.test.ts` covers lazy initialization, missing and
invalid configuration, explicit construction without environment fallback,
pool bounds, and the effective Neon TLS option for `sslmode=require`, no
`sslmode`, weaker modes, explicit `verify-full`, duplicate/conflicting options
and plain loopback. `tests/db/merchant-invitation-transaction.test.ts`
runs the existing invitation service through the real client against a
disposable PostgreSQL database migrated through `0008`, including acceptance,
revocation and a terminal-update failure that rolls back the account,
credential, membership and accepted marker. The existing Phase 2A invitation
suite continues to run against the same harness.
