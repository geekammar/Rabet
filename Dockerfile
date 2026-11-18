# syntax=docker/dockerfile:1

# -----------------------------------------------------------------------------
# Stage 1: Install locked dependencies on Node 22 (linux/amd64, Debian glibc)
# -----------------------------------------------------------------------------
FROM --platform=linux/amd64 node:22-bookworm-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# -----------------------------------------------------------------------------
# Stage 2: Build Next.js standalone server and static assets
# No runtime secrets (no AUTH_SECRET, ADMIN_*, DATABASE_URL, or TELEGRAM_*)
# are passed to or persisted in the build.
# -----------------------------------------------------------------------------
FROM --platform=linux/amd64 node:22-bookworm-slim AS builder
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json next.config.ts tsconfig.json ./
COPY public ./public
COPY src ./src

RUN npm run build \
 && test -f .next/standalone/server.js \
 && test -d .next/standalone/node_modules/@node-rs/argon2 \
 && test -d .next/standalone/node_modules/@node-rs/argon2-linux-x64-gnu \
 && test -d .next/static

# -----------------------------------------------------------------------------
# Stage 3: Minimal non-root runtime image
# Runs precompiled standalone server directly — no install, build, or migrate
# on container startup.
# -----------------------------------------------------------------------------
FROM --platform=linux/amd64 node:22-bookworm-slim AS runner
WORKDIR /app

ARG GIT_SHA=""

LABEL org.opencontainers.image.source="https://github.com/geekammar/Rabet" \
      org.opencontainers.image.description="Rabet single-store runtime image for Render" \
      org.opencontainers.image.revision="${GIT_SHA}"

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=10000 \
    RABET_BUILD_SHA="${GIT_SHA}"

RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs --home-dir /app --shell /usr/sbin/nologin nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

# Keep application code, public assets, and traced node_modules immutable to
# the runtime user while allowing Next.js Cache Components to write `.next/cache`.
RUN mkdir -p /app/.next/cache \
 && chown -R nextjs:nodejs /app/.next

USER nextjs
EXPOSE 10000

CMD ["node", "server.js"]
