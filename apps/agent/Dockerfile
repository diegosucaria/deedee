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
# We use a virtual environment to respect PEP 668 on Alpine
ENV VIRTUAL_ENV=/opt/venv
RUN uv venv $VIRTUAL_ENV
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

# Install requirements into the venv
RUN uv pip install -r packages/plex-mcp-server/requirements.txt

# Start the specific app
WORKDIR /app/apps/agent
CMD ["npm", "start"]
