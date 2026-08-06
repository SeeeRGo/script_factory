FROM node:24-alpine

WORKDIR /app

RUN apk add --no-cache \
    chromium \
    freetype \
    harfbuzz \
    novnc \
    nss \
    ttf-freefont \
    websockify \
    x11vnc \
    xvfb \
    && ln -sf vnc.html /usr/share/novnc/index.html

COPY package.json package-lock.json ./
ENV PUPPETEER_SKIP_DOWNLOAD=true
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY demo/browser-replay-send-email.json ./demo/browser-replay-send-email.json
COPY demo/fixtures ./demo/fixtures
COPY openapi.yaml ./
COPY swagger-ru.js ./
COPY docker/start.sh /usr/local/bin/start-script-factory

RUN mkdir -p /app/data /app/demo-data/incoming /app/demo-data/loaded /app/demo-data/empty \
    && cp -R /app/demo/fixtures/. /app/demo-data/incoming/ \
    && chmod +x /usr/local/bin/start-script-factory

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DATA_DIR=/app/data
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV BROWSER_HEADLESS=true
ENV NOVNC_ENABLED=false
ENV NOVNC_INTERNAL_PORT=6080

EXPOSE 3000 6080

ENTRYPOINT ["start-script-factory"]
CMD ["node", "src/server.js"]
