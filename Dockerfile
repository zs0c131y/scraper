FROM node:20-slim

# Install Chromium and all system libs it needs
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    chromium-sandbox \
    # Graphics/font stack
    libglib2.0-0 \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    # For better-sqlite3 native compile
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to skip downloading its own Chrome bundle — use system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    CHROMIUM_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app

# Install deps (no cache mounts, no Docker BuildKit cache weirdness)
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000
CMD ["node", "server.js"]
