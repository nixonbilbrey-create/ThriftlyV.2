# Thriftly — Express + SQLite (better-sqlite3) + sharp
# Runtime honors PORT (Render injects it); disk is mounted over /app/data,
# which is where the SQLite db and photo files live by default.
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
COPY server.js db.js auth.js mailer.js gemini.js photos.js ./
COPY public ./public
# Runs as root by default: Render bind-mounts its persistent disk at /app/data
# root-owned, which a non-root user can't write to without an entrypoint chown.
# Single-tenant container — acceptable; note it in the deploy checklist.
EXPOSE 10000
CMD ["node", "server.js"]
