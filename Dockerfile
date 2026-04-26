FROM node:18-alpine

WORKDIR /app

# Create non-root user early
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup

# Copy dependency files and install
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY server.js ./

# Give appuser ownership of all app files
RUN chown -R appuser:appgroup /app

# Create data directory and give appuser ownership
RUN mkdir -p /data && chown -R appuser:appgroup /data

USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
