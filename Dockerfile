FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates unzip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/dist ./dist
COPY web ./web
COPY examples/clean-branch.ink ./examples/clean-branch.ink

ENV HOME=/opt/inkcheck
RUN mkdir -p /opt/inkcheck \
    && node dist/cli.js examples/clean-branch.ink --json >/dev/null \
    && rm -rf examples \
    && chmod -R a=rX /opt/inkcheck \
    && apt-get purge -y unzip \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

ENV HOME=/home/node \
    HOST=0.0.0.0 \
    PORT=8080 \
    NODE_ENV=production \
    INKLECATE_PATH=/opt/inkcheck/.cache/inkcheck/inklecate-1.2.1/inklecate

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/web.js"]
