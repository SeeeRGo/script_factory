FROM node:24-alpine

WORKDIR /app

RUN apk add --no-cache chromium nss freetype harfbuzz ttf-freefont

COPY package.json package-lock.json ./
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY demo/browser-replay-send-email.json ./demo/browser-replay-send-email.json
COPY demo/fixtures ./demo/fixtures
COPY openapi.yaml ./
COPY swagger-ru.js ./

RUN mkdir -p /app/data /app/demo-data/incoming /app/demo-data/loaded /app/demo-data/empty \
    && cp -R /app/demo/fixtures/. /app/demo-data/incoming/

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV BROWSER_HEADLESS=true

EXPOSE 3000

CMD ["node", "src/server.js"]
