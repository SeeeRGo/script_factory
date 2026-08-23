import puppeteer from 'puppeteer';

const baseUrl = process.env.DEMO_API_URL || 'http://127.0.0.1:33001';
const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
const login = process.env.WEB_LOGIN;
const password = process.env.WEB_PASSWORD;

if (!executablePath || !login || !password) {
  throw new Error('Задайте PUPPETEER_EXECUTABLE_PATH, WEB_LOGIN и WEB_PASSWORD');
}

const browser = await puppeteer.launch({
  executablePath,
  headless: false,
  defaultViewport: null,
  args: ['--start-maximized', '--no-first-run'],
  protocolTimeout: 120_000
});

const [page] = await browser.pages();
await page.goto(`${baseUrl}/login?next=/queue`, { waitUntil: 'domcontentloaded' });
await page.type('#login', login);
await page.type('#password', password);
await Promise.all([
  page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
  page.click('#submit')
]);

console.log(`Монитор очереди открыт: ${baseUrl}/queue`);
console.log('Закройте окно браузера-монитора после завершения наблюдения.');
await new Promise((resolve) => browser.on('disconnected', resolve));
