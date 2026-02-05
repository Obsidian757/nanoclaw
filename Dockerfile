FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy built app
COPY dist/ ./dist/

# Create data directories
RUN mkdir -p data groups store

# Environment
ENV NODE_ENV=production
ENV KIMI_MODEL=kimi-k2-5
ENV KIMI_BASE_URL=https://api.moonshot.cn/v1

# Run
CMD ["node", "dist/index.js"]
