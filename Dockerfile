# ─── Stage 1: build ───────────────────────────────────────────────────────
# Use the official Node 22 LTS slim image. Pinning to a major-only tag so
# we get security patches automatically; pin to a specific minor in
# production if reproducible builds are required.
FROM node:22-slim AS build

WORKDIR /app

COPY package.json package-lock.json* ./
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm ci --omit=optional

# Copy source + tsconfig + supabase migrations (workers may reference them
# in scripts/, though prod migrations apply via supabase CLI not the app).
COPY tsconfig.json ./
COPY src ./src

# Compile TypeScript → dist/
RUN npm run build

# Prune dev dependencies before copying to runtime stage
RUN npm prune --omit=dev

# ─── Stage 2: runtime ─────────────────────────────────────────────────────
FROM node:22-slim AS runtime

WORKDIR /app

# Run as non-root for defense-in-depth (the official node image already
# ships a `node` user with uid 1000; chown app dir to it).
USER node

# Copy ONLY what the runtime needs: compiled JS, production node_modules,
# package.json (for `npm start` and version metadata).
COPY --chown=node:node --from=build /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/package.json ./package.json

# Defaults — Fly overrides PORT via the [services] section but be explicit.
ENV NODE_ENV=production
ENV PORT=3001

# Fly's [http_service] uses PORT to figure out where to send traffic.
EXPOSE 3001

# Both web and worker entry points are in dist/. Fly's [processes] in
# fly.toml picks which to run via `npm start` vs `npm run start:worker`;
# the default CMD here is the web server so `docker run` outside Fly
# still does something sensible.
CMD ["npm", "start"]
