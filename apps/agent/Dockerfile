# syntax=docker/dockerfile:1
FROM node:24-alpine AS base
RUN apk add --no-cache libc6-compat python3 py3-pip make g++ git
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

# Copy all package.json files from inside mcp-servers too if they exist, 
# or we can rely on workspace definitions. 
# For now, let's copy the specific one we know exists:
# (Note: Plex MCP server is Python and not a workspace, so safe to skip here for turbo)

RUN turbo prune --scope=@deedee/agent --docker

# --- Builder Stage ---
FROM base AS builder
WORKDIR /app

# Copy pruned lockfile and package.json
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/package-lock.json ./package-lock.json

# Install dependencies (cached)
# Install dependencies (cached)
RUN npm install
RUN npm prune --production

# Copy source code
COPY . .

# --- Runner Stage ---
FROM node:24-alpine AS runner
WORKDIR /app
ENV LANG=C.UTF-8
ENV NODE_ENV=production

# Install Runtime Dependencies: Python, UV, curl
RUN --mount=type=cache,target=/var/cache/apk apk add --no-cache python3 py3-pip curl gcompat
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:/root/.cargo/bin:$PATH"

# Create Virtual Environment for MCP Servers
ENV VIRTUAL_ENV=/opt/venv
RUN uv venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

# Copy packages from builder to allow pip install
# Note: "out/full" structure maintains paths
COPY --from=builder /app/packages ./packages
# Copy plex-mcp-server manually
COPY packages/plex-mcp-server ./packages/plex-mcp-server

# Pre-install MCP Servers
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install -r packages/plex-mcp-server/requirements.txt
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install ha-mcp

# Copy built node_modules and app source
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/agent ./apps/agent
COPY --from=builder /app/package.json ./package.json

WORKDIR /app/apps/agent
CMD ["npm", "start"]
