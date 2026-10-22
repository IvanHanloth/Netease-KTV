# Netease-KTV app: Node backend + built web frontend + ffmpeg.

FROM node:24-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci
COPY apps ./apps
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=8686 \
    WEB_DIST=/app/apps/web/dist
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/apps/server/package.json ./apps/server/
COPY --from=build /src/apps/server/dist ./apps/server/dist
COPY --from=build /src/apps/web/dist ./apps/web/dist
VOLUME /data
EXPOSE 8686
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8686/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "apps/server/dist/index.js"]
