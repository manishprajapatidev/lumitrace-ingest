# --- builder ---------------------------------------------------------------
FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build && npm prune --omit=dev

# --- runner ----------------------------------------------------------------
FROM node:20-bookworm-slim AS runner
ENV NODE_ENV=production
WORKDIR /app
RUN useradd -r -u 1001 -g root app && chown -R app:root /app
USER app
COPY --from=builder --chown=app:root /app/node_modules ./node_modules
COPY --from=builder --chown=app:root /app/dist ./dist
COPY --from=builder --chown=app:root /app/public ./public
COPY --from=builder --chown=app:root /app/package.json ./package.json
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
