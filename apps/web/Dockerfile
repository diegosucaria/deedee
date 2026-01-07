FROM node:24-alpine AS base
RUN apk add --no-cache libc6-compat
RUN npm install turbo --global

# --- Pruner Stage ---
# This stage uses "turbo prune" to generate a minimal "lockfile slice" for this specific app.
# It isolates only the dependencies needed for "web", preventing unnecessary cache misses 
# when unrelated packages (like "agent" or "api") change.
FROM base AS pruner
WORKDIR /app
# Copy only package definitions first to cache the pruner layer
COPY package.json package-lock.json turbo.json ./
COPY apps/agent/package.json apps/agent/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/interfaces/package.json apps/interfaces/package.json
COPY apps/api/package.json apps/api/package.json
COPY apps/supervisor/package.json apps/supervisor/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/mcp-servers/package.json packages/mcp-servers/package.json
RUN turbo prune --scope=web --docker

# --- Builder Stage ---
FROM base AS builder
WORKDIR /app

# First, copy ONLY the pruned lockfile and package.json files
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/package-lock.json ./package-lock.json

# Install dependencies (this step is now cached unless "web" dependencies change)
RUN npm install

# Copy the source code
# Copy the source code
COPY . .

# Build the project
ENV NEXT_TELEMETRY_DISABLED 1
RUN turbo run build --filter=web...

# --- Runner Stage ---
FROM base AS runner
WORKDIR /app

ENV NODE_ENV production
ENV NEXT_TELEMETRY_DISABLED 1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy standalone output
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public

USER nextjs

EXPOSE 3000

ENV PORT 3000
ENV HOSTNAME "0.0.0.0"

CMD ["node", "apps/web/server.js"]
