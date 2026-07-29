ARG RUNTIME_BASE_IMAGE=ghcr.io/naruto-823/macro-influencer:4abfbaaf7cb371c6019f620756c1886664bc24e8

FROM node:22-bookworm-slim AS build

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json biome.json vitest.config.ts ./
COPY src ./src
COPY assets ./assets
RUN pnpm build && cp src/viz/index.html dist/viz/index.html && pnpm prune --prod

FROM ${RUNTIME_BASE_IMAGE} AS runtime

ENV NODE_ENV=production \
    VIZ_PORT=5180 \
    LLM_BACKEND=fox \
    CHROMIUM_PATH=/usr/bin/chromium
WORKDIR /app

USER root
COPY --from=build /app/dist ./dist
RUN chown -R node:node /app/dist
USER node

EXPOSE 5180
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:5180/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/viz/server.js"]
