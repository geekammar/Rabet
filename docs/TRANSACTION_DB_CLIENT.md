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

## Verified connection assumptions

- `postgres` 3.4.9 reads `sslmode` from the connection URL. Neon URLs keep
  their `?sslmode=require` behaviour.
- A `*.neon.tech` host is also forced to `ssl: "require"` when the URL omits
  `sslmode` or requests an insecure mode. An explicit `sslmode=verify-full`
  is left intact.
- Non-Neon hosts, including the disposable loopback cluster, use their URL as
  written, so the local test cluster stays plain TCP.
- The client uses the existing Drizzle schema map and returns
  `PostgresJsDatabase<typeof schema>`, the type `MerchantInvitationDb` already
  declares. No cast is needed at the service call site.

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
pool bounds and Neon TLS. `tests/db/merchant-invitation-transaction.test.ts`
runs the existing invitation service through the real client against a
disposable PostgreSQL database migrated through `0008`, including acceptance,
revocation and a terminal-update failure that rolls back the account,
credential, membership and accepted marker. The existing Phase 2A invitation
suite continues to run against the same harness.
