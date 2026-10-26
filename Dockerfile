# Base image: node:24-bookworm-slim, pinned by digest (multi-arch index).
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /src/dist ./dist
COPY LICENSE NOTICE README.md ./

LABEL org.opencontainers.image.source="https://github.com/ylove/agent-roundtable" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.description="MCP server for multi-agent meetings and collaborations (stdio)" \
      io.modelcontextprotocol.server.name="io.github.ylove/agent-roundtable"

ENV ROUNDTABLE_HOME=/home/node/.agent-roundtable
RUN mkdir -p "$ROUNDTABLE_HOME" && chown node:node "$ROUNDTABLE_HOME"
USER node
VOLUME ["/home/node/.agent-roundtable"]
ENTRYPOINT ["node", "/app/dist/index.js"]
CMD ["mcp"]
