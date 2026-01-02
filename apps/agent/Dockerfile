FROM node:18-alpine

WORKDIR /app
ENV LANG=C.UTF-8

# Install Python and UV for local MCP servers
RUN apk add --no-cache python3 py3-pip curl gcompat
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:/root/.cargo/bin:$PATH"


# Copy root config
COPY package.json package-lock.json* ./

# Copy all workspaces
COPY apps/agent ./apps/agent
COPY packages ./packages

# Install dependencies (from root to link workspaces)
RUN npm install --workspaces --if-present
# Also install root devDeps if needed for build (though we want prod)
# We can just install everything for now to be safe with monorepo linking
RUN npm install

# Install Plex MCP Server dependencies (using uv for speed/reliability)
# We use --system to install into the container's python environment so 'python3' command works directly
RUN uv pip install --system -r packages/plex-mcp-server/requirements.txt

# Start the specific app
WORKDIR /app/apps/agent
CMD ["npm", "start"]
