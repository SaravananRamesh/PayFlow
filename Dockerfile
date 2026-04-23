FROM node:18-alpine

WORKDIR /app

# Copy dependency files first (layer caching)
COPY package*.json ./
RUN npm ci --only=production

# Copy application code
COPY server.js ./

# Run as non-root user for security
RUN addgroup -g 1001 -S appgroup && \
    adduser -S appuser -u 1001 -G appgroup
USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

CMD ["node", "server.js"]
