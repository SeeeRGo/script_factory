import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'script_factory_demo_mail';
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const MAX_BODY_SIZE = 128 * 1024;

function secureEqual(provided, expected) {
  const left = Buffer.from(String(provided ?? ''), 'utf8');
  const right = Buffer.from(String(expected ?? ''), 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf('=');
      return separator === -1
        ? [part, '']
        : [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
    }));
}

function sendJson(res, statusCode, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (Buffer.byteLength(raw) > MAX_BODY_SIZE) {
        reject(Object.assign(new Error('Тело запроса слишком большое'), { statusCode: 413 }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error('Некорректный JSON'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

export function createDemoMail(options) {
  const login = options.login;
  const password = options.password;
  const sessions = new Map();
  const messages = [];

  function activeSession(req) {
    const token = parseCookies(req)[COOKIE_NAME];
    const session = sessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
      if (token) sessions.delete(token);
      return null;
    }
    return session;
  }

  function requireSession(req, res) {
    const session = activeSession(req);
    if (session) return session;
    sendJson(res, 401, { error: { code: 'MAIL_UNAUTHORIZED', message: 'Войдите в демонстрационную почту' } });
    return null;
  }

  return {
    get messageCount() {
      return messages.length;
    },

    async handle(req, res, requestUrl) {
      const pathname = requestUrl.pathname;
      if (!pathname.startsWith('/demo/mail/api/')) return false;

      try {
        if (req.method === 'GET' && pathname === '/demo/mail/api/state') {
          const session = activeSession(req);
          sendJson(res, 200, {
            authenticated: Boolean(session),
            account: session ? login : null,
            messages: session ? messages.slice().reverse() : []
          });
          return true;
        }

        if (req.method === 'POST' && pathname === '/demo/mail/api/login') {
          const payload = await readJsonBody(req);
          if (!secureEqual(payload.login, login) || !secureEqual(payload.password, password)) {
            sendJson(res, 401, { error: { code: 'MAIL_INVALID_CREDENTIALS', message: 'Неверный логин или пароль' } });
            return true;
          }
          const token = randomBytes(24).toString('base64url');
          sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
          sendJson(res, 200, { authenticated: true, account: login }, {
            'Set-Cookie': `${COOKIE_NAME}=${token}; Path=/demo/mail; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`
          });
          return true;
        }

        if (req.method === 'POST' && pathname === '/demo/mail/api/logout') {
          const token = parseCookies(req)[COOKIE_NAME];
          if (token) sessions.delete(token);
          sendJson(res, 200, { authenticated: false }, {
            'Set-Cookie': `${COOKIE_NAME}=; Path=/demo/mail; HttpOnly; SameSite=Lax; Max-Age=0`
          });
          return true;
        }

        if (req.method === 'POST' && pathname === '/demo/mail/api/send') {
          if (!requireSession(req, res)) return true;
          const payload = await readJsonBody(req);
          const to = String(payload.to || '').trim();
          const subject = String(payload.subject || '').trim();
          const body = String(payload.body || '').trim();
          if (!to || !subject || !body || !to.includes('@')) {
            sendJson(res, 422, {
              error: { code: 'MAIL_VALIDATION_ERROR', message: 'Заполните корректный адрес, тему и текст письма' }
            });
            return true;
          }
          const message = {
            message_id: `mail_${randomUUID()}`,
            from: login,
            to,
            subject,
            body,
            sent_at: new Date().toISOString()
          };
          messages.push(message);
          sendJson(res, 201, { message });
          return true;
        }

        sendJson(res, 404, { error: { code: 'MAIL_NOT_FOUND', message: 'Маршрут почты не найден' } });
        return true;
      } catch (error) {
        sendJson(res, error?.statusCode || 500, {
          error: { code: 'MAIL_INTERNAL_ERROR', message: error?.message || 'Ошибка демонстрационной почты' }
        });
        return true;
      }
    }
  };
}
