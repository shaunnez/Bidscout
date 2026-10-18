FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run typecheck && npx vite build

FROM node:22-bookworm-slim
# tesseract reads specs from lot photos; chromium runs Trade Me searches for the Trade Me prices button.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tini tesseract-ocr tesseract-ocr-eng chromium fonts-liberation && rm -rf /var/lib/apt/lists/*
ENV CHROMIUM_PATH=/usr/bin/chromium
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
COPY scripts ./scripts
COPY deploy/entrypoint.sh /usr/local/bin/bidscout-entrypoint
# Raw responses live on a volume (mount one at /data on Railway). The entrypoint gives it
# to the "node" user and drops root before starting the app.
ENV NODE_ENV=production BIDSCOUT_HOST=0.0.0.0 BIDSCOUT_DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
EXPOSE 4328
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/bidscout-entrypoint"]
CMD ["node", "--import", "tsx", "server/api.ts"]
