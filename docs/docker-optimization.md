# Docker Optimization Guide

We use **Turbo Prune** to optimize Docker image builds in this monorepo. This allows us to benefit from Docker caching by only rebuilding layers when relevant dependencies change.

## How it works

Each Dockerfile implements a "Pruner" stage:

```dockerfile
# 1. Install Turbo
FROM node:24-alpine AS base
RUN npm install turbo --global

# 2. Prune Lockfile
# Generates a minimal "lockfile slice" for the specific app
FROM base AS pruner
WORKDIR /app
COPY . .
RUN turbo prune --scope=<APP_NAME> --docker

# 3. Build with Pruned Context
FROM base AS builder
WORKDIR /app
# Copy ONLY the pruned lockfile first (CACHE HIT if deps haven't changed)
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/package-lock.json ./package-lock.json
RUN npm install
# Copy source code
COPY --from=pruner /app/out/full/ .
# ... build steps ...
```

## Benefits

1.  **Cache Hits**: `npm install` is skipped if `package-lock.json` changes are unrelated to the current app.
2.  **Smaller Context**: `turbo prune` isolates only the necessary files for the build.
3.  **Smaller Images**: We use multi-stage builds to copy only the final artifacts to the runner image.

## Commands

- **Build All**: `docker-compose build`
- **Build Specific**: `docker-compose build agent`
