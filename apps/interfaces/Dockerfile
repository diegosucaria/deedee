# syntax=docker/dockerfile:1
FROM node:24-alpine AS base
RUN apk add --no-cache libc6-compat python3 py3-pip make g++
RUN npm install turbo --global

# --- Pruner Stage ---
# This stage uses "turbo prune" to generate a minimal "lockfile slice" for this specific app.
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
RUN turbo prune --scope=@deedee/interfaces --docker

# --- Builder Stage ---
FROM base AS builder
WORKDIR /app

# Copy pruned lockfile and package.json
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/package-lock.json ./package-lock.json

# Install dependencies
# Install dependencies
RUN npm install
RUN npm prune --production

# Copy source code
COPY . .

# --- Runner Stage ---
FROM node:24-alpine AS runner
WORKDIR /app
ENV LANG=C.UTF-8

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/interfaces ./apps/interfaces
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/package.json ./package.json

WORKDIR /app/apps/interfaces
CMD ["npm", "start"]
