FROM node:18-alpine

WORKDIR /app

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

# Start the specific app
WORKDIR /app/apps/agent
CMD ["npm", "start"]
