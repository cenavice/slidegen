FROM node:24-alpine
WORKDIR /app
COPY server.js package.json ./
COPY design/ design/
COPY public/ public/
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
