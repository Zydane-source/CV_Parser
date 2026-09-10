# syntax=docker/dockerfile:1
# Multi-stage build producing two runnable targets from one image:
#   --target web    : Next.js standalone server (HTTP)
#   --target worker : BullMQ worker (CV parsing + Drive sync)
# Both share the same code/deps so the parsing pipeline is identical everywhere.

FROM node:20-bookworm-slim AS base
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    OCR_CACHE_PATH=/data/tesseract-cache \
    LOCAL_STORAGE_PATH=/data/uploads
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

# ── deps ────────────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json prisma.config.ts ./
COPY database ./database
RUN npm ci --ignore-scripts && npx prisma generate

# ── build ───────────────────────────────────────────────────────────────────
FROM deps AS build
COPY . .
RUN npm run build

# ── worker ──────────────────────────────────────────────────────────────────
FROM base AS worker
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/prisma.config.ts ./
COPY --from=build /app/database ./database
COPY --from=build /app/workers ./workers
COPY --from=build /app/services ./services
COPY --from=build /app/backend ./backend
COPY --from=build /app/lib ./lib
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/tsconfig.json ./
RUN mkdir -p /data/uploads /data/tesseract-cache && chown -R node:node /data /app
USER node
CMD ["npx", "tsx", "workers/index.ts"]

# ── web ─────────────────────────────────────────────────────────────────────
FROM base AS web
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
COPY --from=build /app/database ./database
COPY --from=build /app/prisma.config.ts ./
# Prisma CLI for `migrate deploy` at release time (small enough to keep).
COPY --from=build /app/node_modules/prisma ./node_modules/prisma
COPY --from=build /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
RUN mkdir -p /data/uploads /data/tesseract-cache && chown -R node:node /data /app
USER node
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
