# syntax=docker/dockerfile:1
# @app/web — Next.js standalone server (Part 10). Context: the repo root.
#   docker build -f apps/web/Dockerfile -t randomchat-web \
#     --build-arg NEXT_PUBLIC_API_URL=https://api.example.com ... .
# NEXT_PUBLIC_* values are inlined into the browser bundle at build time, so they are build
# arguments, not run-time variables. DEPLOY_ENV=production refuses Turnstile test keys.

FROM node:24.22.2-alpine3.24 AS base
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

FROM base AS prune
RUN npm install --global turbo@2.11.10
COPY . .
RUN turbo prune @app/web --docker

FROM base AS build
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG NEXT_PUBLIC_GATEWAY_URL=http://localhost:4001
ARG NEXT_PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA
ARG NEXT_PUBLIC_FORCE_TURN_RELAY=false
ARG DEPLOY_ENV=development
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL \
    NEXT_PUBLIC_GATEWAY_URL=$NEXT_PUBLIC_GATEWAY_URL \
    NEXT_PUBLIC_TURNSTILE_SITE_KEY=$NEXT_PUBLIC_TURNSTILE_SITE_KEY \
    NEXT_PUBLIC_FORCE_TURN_RELAY=$NEXT_PUBLIC_FORCE_TURN_RELAY \
    DEPLOY_ENV=$DEPLOY_ENV \
    NEXT_OUTPUT=standalone
COPY --from=prune /repo/out/json/ .
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --store-dir /pnpm/store
COPY --from=prune /repo/out/full/ .
# The build also converts the NSFWJS model into public/models/ (scripts/prepare-nsfw-model.mjs).
RUN pnpm turbo run build --filter=@app/web

FROM node:24.22.2-alpine3.24 AS runtime
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD wget -qO- http://127.0.0.1:3000/ > /dev/null || exit 1
CMD ["node", "apps/web/server.js"]
