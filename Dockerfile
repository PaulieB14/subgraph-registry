# Discovery-only HTTP/SSE deployment.
#
# Deliberately ships NO Studio API key. /sse and /messages are unauthenticated,
# so a key here would be a key anyone reaching the port could spend — and the
# server drops the eight credentialed tools when none is set, leaving exactly
# the surface that works without one.
#
# Callers run their own queries: every result carries query_url (their Studio
# key, Authorization: Bearer) and query_url_x402 ($0.01 USDC on Base, no key).
# Discovery is the part worth centralising; execution should be billed to
# whoever asked for it.
FROM node:22-slim

WORKDIR /app

# better-sqlite3 ships prebuilds for this platform, so no compiler is needed.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# The 74 MB corpus and the ONNX embedding model. Copied last so a dependency
# change does not invalidate the layer holding ~95 MB of data.
COPY src ./src
COPY data ./data
COPY openapi.yaml ./

ENV NODE_ENV=production
# Bind all interfaces INSIDE the container — the platform maps the port. This
# is the one place 0.0.0.0 is correct, because the container is the boundary.
ENV MCP_HTTP_HOST=0.0.0.0
ENV MCP_HTTP_PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_HTTP_PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/index.js", "--http-only"]
