FROM node:24-alpine

WORKDIR /app

COPY apps/api/package.json ./

RUN npm install --production

COPY apps/api/src ./src

EXPOSE 3001

CMD ["node", "src/server.js"]
