FROM node:24-bookworm-slim
# Debian's chromium is a supported build; Alpine's crashes Puppeteer with
# "Protocol error: Connection closed". apt pulls the Chromium runtime libraries,
# fonts-liberation gives PDF text a real font instead of tofu.
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-liberation \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server.js package.json ./
COPY audit.js ./
RUN npm install --no-save puppeteer-core@23
COPY design/ design/
COPY public/ public/
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
