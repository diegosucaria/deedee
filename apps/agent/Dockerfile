# Builder Stage
FROM node:24-alpine AS builder
WORKDIR /app
ENV LANG=C.UTF-8

# Install build dependencies (python, make, g++) for native modules
RUN apk add --no-cache python3 py3-pip make g++ git

# Copy root config
COPY package.json package-lock.json* ./

# Copy workspaces
COPY apps/agent ./apps/agent
COPY packages ./packages

# Install dependencies (production + dev for build)
RUN npm install

# Prune dev dependencies to reduce size for the next stage
RUN npm prune --production

# Runner Stage
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

# Copy packages first to allow pip install
COPY --from=builder /app/packages ./packages

# Pre-install MCP Servers
RUN uv pip install -r packages/plex-mcp-server/requirements.txt
RUN uv pip install ha-mcp

# Copy built node_modules and app source from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/agent ./apps/agent
COPY --from=builder /app/package.json ./package.json

WORKDIR /app/apps/agent
CMD ["npm", "start"]
