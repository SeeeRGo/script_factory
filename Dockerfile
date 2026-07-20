FROM node:24-alpine

WORKDIR /app

COPY package.json ./
COPY src ./src
COPY public ./public
COPY openapi.yaml ./
COPY swagger-ru.js ./

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data

EXPOSE 3000

CMD ["node", "src/server.js"]
