# 🏗️ Stage 1: Build
FROM node:22-slim AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy source
COPY . .

# 🚀 Stage 2: Production Runtime
FROM node:22-slim

WORKDIR /app

# Install simple process manager (dumb-init)
RUN apt-get update && apt-get install -y dumb-init && rm -rf /var/lib/apt/lists/*

# Copy from builder
COPY --from=builder /app /app

# Non-root user
USER node

EXPOSE 8000
ENV NODE_ENV=production

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "index.js"]
