FROM node:24-alpine AS base
RUN apk add --no-cache libc6-compat python3 py3-pip make g++ git gettext sqlite-dev
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
COPY packages/node-red-mcp/package.json packages/node-red-mcp/package.json

# Copy all package.json files from inside mcp-servers too if they exist, 
# or we can rely on workspace definitions. 
COPY packages/mcp-servers/browser/package.json packages/mcp-servers/browser/package.json

RUN turbo prune --scope=@deedee/agent --docker

# --- Builder Stage ---
FROM base AS builder
WORKDIR /app

# Copy pruned lockfile and package.json
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/package-lock.json ./package-lock.json
RUN mkdir -p patches

# Install dependencies (cached)
RUN npm install
RUN npm prune --production

# Build sqlite-vec from source for musl (Alpine) compatibility.
# The npm prebuilt binaries are glibc-only; compiling natively gives us a
# musl .so that works on Alpine ARM64 without compatibility hacks.
# We skip the Makefile (its -Wall -Wextra flags fail on newer GCC) and
# compile directly, generating the header template ourselves.
RUN git clone --depth 1 --branch v0.1.6 https://github.com/asg017/sqlite-vec.git /tmp/sqlite-vec \
    && cd /tmp/sqlite-vec \
    && export VERSION=0.1.6 VERSION_MAJOR=0 VERSION_MINOR=1 VERSION_PATCH=6 \
    && export DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ) SOURCE=$(git rev-parse HEAD) \
    && envsubst < sqlite-vec.h.tmpl > sqlite-vec.h \
    && gcc -fPIC -shared -O3 -w -Ivendor/ sqlite-vec.c -o vec0.so -lm \
    && mkdir -p /app/native-extensions \
    && cp vec0.so /app/native-extensions/vec0.so \
    && rm -rf /tmp/sqlite-vec

# Copy source code
COPY . .

# --- Runner Stage ---
FROM node:24-alpine AS runner
WORKDIR /app
ENV LANG=C.UTF-8
ENV NODE_ENV=production

# Install Runtime Dependencies: Python, UV, curl, chromium (for browser MCP)
# Full Chromium dependencies for Alpine: nss, freetype, harfbuzz, ca-certificates, ttf-freefont
RUN apk add --no-cache python3 py3-pip curl gcompat \
    chromium nss freetype harfbuzz ca-certificates ttf-freefont

RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:/root/.cargo/bin:$PATH"

# Install Google Workspace CLI globally so `gws` command is instantly available
RUN npm install -g @googleworkspace/cli@0.6.3

# Playwright Config for Alpine/ARM
ENV BROWSER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

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
RUN uv pip install -r packages/plex-mcp-server/requirements.txt
RUN uv pip install ha-mcp youtube-transcript-api

# Copy built node_modules and app source
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/agent ./apps/agent
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/native-extensions ./native-extensions

WORKDIR /app/apps/agent
CMD ["npm", "start"]
