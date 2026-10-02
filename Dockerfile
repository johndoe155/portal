# ─────────────────────────────────────────────────────────────────────────────
# School Portal — multi-stage build. One image serves all three roles; the
# command decides which:
#   api     → node apps/api/dist/main.js
#   worker  → node apps/api/dist/worker/main.js
#   web     → node apps/web/server.js  (next start via npm -w @portal/web)
#
# review-2: the runtime image ships PRODUCTION dependencies only — a separate
# `prod-deps` stage runs `npm ci --omit=dev`, so typescript/supertest/@types
# and the rest of the dev toolchain never reach the deployed layer. The build
# stage's per-workspace node_modules are removed before the artifact copy so
# no dev module can ride along inside apps/*/.
# ─────────────────────────────────────────────────────────────────────────────
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --ignore-scripts=false

FROM deps AS build
WORKDIR /app
COPY packages packages
COPY apps apps
COPY db db
# ops CLIs (mfa-token.mjs — first-admin bootstrap path; backup/restore drills).
# NOTE: never put a trailing `#` comment on a COPY/ADD line — Docker parses it
# as an extra source argument and the build fails.
COPY scripts scripts
# contracts → api (tsc) → web (next build)
RUN npm run build
# Strip any per-workspace node_modules (dev tree) from the artifact dirs.
RUN rm -rf apps/api/node_modules apps/web/node_modules packages/contracts/node_modules

# Production dependency tree only (no devDependencies).
FROM node:24-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --omit=dev --ignore-scripts=false \
 && mkdir -p apps/api/node_modules apps/web/node_modules packages/contracts/node_modules

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# non-root runtime user (container hardening)
RUN addgroup -S portal && adduser -S portal -G portal
# built artifacts (api dist, web .next, contracts, migrations) — from `build`
COPY --from=build --chown=portal:portal /app/package.json ./
COPY --from=build --chown=portal:portal /app/packages ./packages
COPY --from=build --chown=portal:portal /app/apps ./apps
COPY --from=build --chown=portal:portal /app/db ./db
COPY --from=build --chown=portal:portal /app/scripts ./scripts
# runtime node_modules — from `prod-deps` ONLY (devDeps excluded); workspace
# dirs exist (possibly empty) so the copy always succeeds and never re-adds
# dev modules.
COPY --from=prod-deps --chown=portal:portal /app/node_modules ./node_modules
COPY --from=prod-deps --chown=portal:portal /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=prod-deps --chown=portal:portal /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=prod-deps --chown=portal:portal /app/packages/contracts/node_modules ./packages/contracts/node_modules
# PGlite fallback dir + push sink (used only when DATABASE_URL is absent —
# and PGlite is FATAL in production, see apps/api/src/db/client.ts)
RUN mkdir -p /app/data && chown -R portal:portal /app/data
USER portal
EXPOSE 3000 8080
# default = API; compose overrides command per service
CMD ["node", "apps/api/dist/main.js"]
