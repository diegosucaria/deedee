# Builder Stage
FROM node:18-alpine AS builder
WORKDIR /app
ENV LANG=C.UTF-8

# Install build dependencies
RUN apk add --no-cache python3 py3-pip make g++ git

# Copy root config
COPY package.json package-lock.json* ./

# Copy workspaces
COPY apps/supervisor ./apps/supervisor
COPY packages ./packages

# Install dependencies (production + dev for build)
RUN npm install

# Prune dev dependencies
RUN npm prune --production

# Runner Stage
FROM node:18-alpine AS runner
WORKDIR /app
ENV LANG=C.UTF-8
ENV NODE_ENV=production

# Install Runtime Dependencies: Git (required for Supervisor)
RUN apk add --no-cache git

# Copy built node_modules and app source from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/supervisor ./apps/supervisor
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/package.json ./package.json

WORKDIR /app/apps/supervisor
CMD ["npm", "start"]
