FROM node:18-alpine

WORKDIR /app

# Copy root config
COPY package.json package-lock.json* ./

# Copy all workspaces
COPY apps/supervisor ./apps/supervisor
COPY packages ./packages

# Install dependencies
RUN npm install

# Start the specific app
WORKDIR /app/apps/supervisor
CMD ["npm", "start"]
