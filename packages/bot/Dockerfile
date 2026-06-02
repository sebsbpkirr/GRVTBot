# Multi-stage build for the GRVT Grid bot.
#
# Stage 1 (bot-builder): build the bot TypeScript + compile sqlite3 native
# bindings against a glibc base.
# Stage 2 (dashboard-builder): build the React SPA into static assets.
# Stage 3 (runtime): slim runtime image. Copies the bot dist + node_modules
# from stage 1 and the dashboard dist from stage 2, drops everything else.
# Runs as non-root grvtbot (fixed UID 10000) for predictable bind-mount
# ownership on the host.

# ── Stage 1: bot builder ──────────────────────────────────────────────────
FROM node:22-bookworm-slim AS bot-builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

COPY package.json package-lock.json ./
COPY packages/bot/package.json packages/bot/
COPY packages/bot/tsconfig.json packages/bot/

RUN npm ci --workspace=@grvt-grid/bot --include-workspace-root

COPY packages/bot/src packages/bot/src
COPY packages/bot/tests packages/bot/tests
RUN npm run build --workspace=@grvt-grid/bot

# ── Stage 2: dashboard builder ────────────────────────────────────────────
FROM node:22-bookworm-slim AS dashboard-builder

WORKDIR /build

ARG VITE_BASE_PATH=/dashboard/
ARG VITE_API_BASE_URL=

ENV VITE_BASE_PATH=${VITE_BASE_PATH} \
    VITE_API_BASE_URL=${VITE_API_BASE_URL}

COPY package.json package-lock.json ./
COPY packages/dashboard/package.json packages/dashboard/

RUN npm ci --workspace=@grvt-grid/dashboard --include-workspace-root

COPY packages/dashboard packages/dashboard
RUN npm run build --workspace=@grvt-grid/dashboard

# ── Stage 3: runtime ──────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    tini \
    curl \
    && rm -rf /var/lib/apt/lists/*

RUN groupadd -g 10000 grvtbot && \
    useradd -u 10000 -g grvtbot -m -s /usr/sbin/nologin grvtbot

WORKDIR /app

COPY --from=bot-builder --chown=grvtbot:grvtbot /build/packages/bot/dist ./dist
COPY --from=bot-builder --chown=grvtbot:grvtbot /build/node_modules ./node_modules
COPY --chown=grvtbot:grvtbot packages/bot/package.json ./package.json

# Recompile native addons (sqlite3, better-sqlite3) for this exact runtime
USER root
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/* \
    && npm rebuild sqlite3 better-sqlite3 --build-from-source

COPY --from=dashboard-builder --chown=grvtbot:grvtbot /build/packages/dashboard/dist ./dashboard-dist

RUN mkdir -p /app/data && chown grvtbot:grvtbot /app/data
VOLUME /app/data

USER grvtbot
EXPOSE 3848

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fs http://127.0.0.1:3848/api/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/dashboard/server.js"]
