# Thriftly — Express + Postgres/SQLite + sharp
# Runtime honors PORT (Render injects it). In production DATABASE_URL is set and
# the app uses Supabase Postgres + Storage, so the image writes nothing durable;
# without it (local dev, tests) SQLite and photos live under /app/data.
FROM node:22-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# npm ci is reproducible (lockfile-pinned). Build tools cover the rare case
# where better-sqlite3/sharp have no prebuilt binary for the target arch.
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-slim
ENV NODE_ENV=production
ENV PORT=10000
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json package-lock.json* ./
COPY server.js db.js db-pg.js backup.js auth.js mailer.js gemini.js photos.js ./
COPY scripts ./scripts
COPY public ./public
# Runs as root by default: there is no disk to mount, but sharp/build artefacts
# and the app's own data dir are root-owned, and a non-root user would need an
# entrypoint chown for the SQLite fallback. Single-tenant container — acceptable.
EXPOSE 10000
CMD ["node", "server.js"]
