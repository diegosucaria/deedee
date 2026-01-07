FROM node:24-alpine AS base
RUN apk add --no-cache libc6-compat
RUN npm install turbo --global

# --- Pruner Stage ---
# This stage uses "turbo prune" to generate a minimal "lockfile slice" for this specific app.
FROM base AS pruner
WORKDIR /app
COPY . .
RUN turbo prune --scope=@deedee/interfaces --docker

# --- Builder Stage ---
FROM base AS builder
WORKDIR /app

# Copy pruned lockfile and package.json
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/package-lock.json ./package-lock.json

# Install dependencies
RUN npm install

# Copy source code
COPY --from=pruner /app/out/full/ .

RUN npm prune --production

# --- Runner Stage ---
FROM node:24-alpine AS runner
WORKDIR /app
ENV LANG=C.UTF-8

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/interfaces ./apps/interfaces
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/package.json ./package.json

WORKDIR /app/apps/interfaces
CMD ["npm", "start"]
