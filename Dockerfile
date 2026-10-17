FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run typecheck && npx vite build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
COPY scripts ./scripts
# Raw responses live on a volume (mount one at /data on Railway).
ENV NODE_ENV=production BIDSCOUT_HOST=0.0.0.0 BIDSCOUT_DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 4328
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "--import", "tsx", "server/api.ts"]
