FROM node:24-alpine
RUN apk add --no-cache chromium
WORKDIR /app
COPY server.js package.json ./
COPY audit.js ./
RUN npm install --no-save puppeteer-core@23
COPY design/ design/
COPY public/ public/
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
