FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY server ./server
COPY tsconfig.json ./

EXPOSE 3003

CMD ["npx", "tsx", "server/index.ts"]