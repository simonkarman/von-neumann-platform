FROM docker:29-cli AS docker-cli
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY server ./server
RUN npm run build
COPY dashboard-base/package*.json ./dashboard-base/
RUN cd dashboard-base && npm ci --ignore-scripts

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/dashboard-base/node_modules ./dashboard-base/node_modules
COPY dashboard-base ./dashboard-base
COPY web ./web
COPY package.json ./
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data NEXT_TELEMETRY_DISABLED=1
RUN mkdir /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/index.js"]
