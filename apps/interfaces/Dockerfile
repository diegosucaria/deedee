FROM node:18-alpine

WORKDIR /app
ENV LANG=C.UTF-8

# Copy root config
COPY package.json package-lock.json* ./

# Copy all workspaces
COPY apps/interfaces ./apps/interfaces
COPY packages ./packages

# Install dependencies
RUN npm install

# Start the specific app
WORKDIR /app/apps/interfaces
CMD ["npm", "start"]
