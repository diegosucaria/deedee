FROM node:24-alpine AS base
RUN apk add --no-cache libc6-compat python3 py3-pip make g++ git
RUN npm install turbo --global

# --- Pruner Stage ---
# This stage uses "turbo prune" to generate a minimal "lockfile slice" for this specific app.
FROM base AS pruner
WORKDIR /app
COPY . .
RUN turbo prune --scope=@deedee/agent --docker

# --- Builder Stage ---
FROM base AS builder
WORKDIR /app

# Copy pruned lockfile and package.json
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/package-lock.json ./package-lock.json

# Install dependencies (cached)
RUN npm install

# Copy source code
COPY --from=pruner /app/out/full/ .

# No build step needed for agent (it's node), but we can prune dev deps here if we want specific install
# But typically we just use the node_modules we have. 
# However, to be clean, we can do:
RUN npm prune --production

# --- Runner Stage ---
FROM node:24-alpine AS runner
WORKDIR /app
ENV LANG=C.UTF-8
ENV NODE_ENV=production

# Install Runtime Dependencies: Python, UV, curl
RUN apk add --no-cache python3 py3-pip curl gcompat
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:/root/.cargo/bin:$PATH"

# Create Virtual Environment for MCP Servers
ENV VIRTUAL_ENV=/opt/venv
RUN uv venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

# Copy packages from builder to allow pip install
# Note: "out/full" structure maintains paths
COPY --from=builder /app/packages ./packages

# Pre-install MCP Servers
RUN uv pip install -r packages/plex-mcp-server/requirements.txt
RUN uv pip install ha-mcp

# Copy built node_modules and app source
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/agent ./apps/agent
COPY --from=builder /app/package.json ./package.json

WORKDIR /app/apps/agent
CMD ["npm", "start"]
