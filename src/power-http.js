import { powerError } from './power-management.js';
// Authentication and the final-transition mutation gate are enforced by server.js before dispatch.
export async function handlePowerRequest({ req, res, method, resourcePath, powerManager, readJsonBody, sendJson, logger = console }) {
  if (method === 'GET' && resourcePath === '/system/power/status') { sendJson(res, 200, powerManager.status()); return true; }
  if (method === 'GET' && resourcePath === '/system/power/sessions') { sendJson(res, 200, await powerManager.inspect()); return true; }
  if (method === 'GET' && resourcePath === '/system/power/config') { sendJson(res, 200, { config: powerManager.config }); return true; }
  if (method === 'PATCH' && resourcePath === '/system/power/config') { sendJson(res, 200, { config: await powerManager.update(await readJsonBody(req)) }); return true; }
  if (method !== 'POST' || !['/system/power/suspend', '/system/power/cancel'].includes(resourcePath)) return false;
  const body = await readJsonBody(req);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) throw powerError('INVALID_PAYLOAD', 'Метод принимает пустой JSON-объект {}');
  if (resourcePath.endsWith('/cancel')) { powerManager.cancel(); sendJson(res, 200, { status: 'accepted' }); }
  else {
    powerManager.assertAvailable();
    res.once('finish', () => setImmediate(() => { void powerManager.request('api').catch(error => logger.error('Power check failed:', error.code)); }));
    sendJson(res, 202, { status: 'accepted' });
  }
  return true;
}
