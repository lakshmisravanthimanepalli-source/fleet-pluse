const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const cors = require('cors');
const { WebSocketServer, WebSocket } = require('ws');

const PORT = Number(process.env.PORT || 4000);
const SECONDARY_PORT = Number(process.env.PORT_SECONDARY || (PORT === 4000 ? 4001 : 0));
const MAX_REPLAY_AGE_MS = 5 * 60 * 1000;
const MAX_REPLAY_EVENTS = 1_500_000;
const app = express();
const server = http.createServer(app);
const secondaryServer = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));

const users = [
  { id: 'u-1', email: 'operator@pulse.dev', password: 'pulse123', role: 'operator' },
  { id: 'u-2', email: 'viewer@pulse.dev', password: 'pulse123', role: 'viewer' }
];
const accessTokens = new Map();
const refreshTokens = new Map();
const rules = new Map();
const idempotency = new Map();
const services = Array.from({ length: 2000 }, (_, index) => {
  const id = `svc-${String(index + 1).padStart(4, '0')}`;
  const groups = ['payments', 'identity', 'search', 'checkout', 'platform', 'shipping'];
  return {
    id,
    name: `${['api', 'worker', 'gateway', 'processor'][index % 4]}-${groups[index % groups.length]}`,
    team: groups[index % groups.length],
    status: 'healthy'
  };
});

let chaos = { rate: 500 };
let globalOffset = 0;
const sequences = new Uint32Array(services.length);
const latest = new Array(services.length);
const replayEvents = [];
let replayStart = 0;
const wsClients = new Set();
const sseClients = new Set();
let shuffleBuffer = [];
let shuffleTimer = null;
let eventsPerTick = 0;
let tickRemainder = 0;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const makeError = (res, status, code, message, details = []) =>
  res.status(status).json({ error: { code, message, details } });

function issueTokens(user) {
  const accessToken = crypto.randomUUID();
  const refreshToken = crypto.randomUUID();
  const expiresIn = Math.max(1, Number(chaos.token_ttl || 60));
  accessTokens.set(accessToken, { user, expiresAt: Date.now() + expiresIn * 1000 });
  refreshTokens.set(refreshToken, user);
  return {
    accessToken,
    refreshToken,
    expiresIn,
    user: { id: user.id, email: user.email, role: user.role }
  };
}

function currentUser(req) {
  const header = req.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const entry = accessTokens.get(token);
  if (!entry) return { error: 'token_invalid' };
  if (entry.expiresAt <= Date.now()) {
    accessTokens.delete(token);
    return { error: 'token_expired' };
  }
  return { user: entry.user };
}

function applyAuth(req, res, next) {
  if (/^\/(auth|chaos|health)(\/|$)/.test(req.path)) return next();
  if (req.path.startsWith('/stream/') || req.path === '/assistant/stream') {
    const streamedUser = authQuery(req);
    if (streamedUser) {
      req.user = streamedUser;
      return next();
    }
    return makeError(res, 401, 'token_invalid', 'Invalid access token');
  }
  const result = currentUser(req);
  if (result.error) {
    return makeError(
      res,
      401,
      result.error,
      result.error === 'token_expired' ? 'Access token expired' : 'Invalid access token'
    );
  }
  req.user = result.user;
  next();
}

app.use((req, res, next) => {
  if (/^\/(auth|chaos|health|stream)(\/|$)/.test(req.path) || req.path === '/assistant/stream') return next();
  if (req.socket.localPort === SECONDARY_PORT) return next();
  if (chaos.http === '429') {
    res.set('Retry-After', '2');
    return makeError(res, 429, 'rate_limited', 'Request rate limited');
  }
  const httpChaos = String(chaos.http || '');
  const errorMatch = /^500:(\d+)$/.exec(httpChaos);
  if (errorMatch && Math.random() * 100 < Number(errorMatch[1])) {
    return makeError(res, 500, 'server_error', 'Simulated server error');
  }
  const slowMatch = /^slow:(\d+)$/.exec(httpChaos);
  if (slowMatch) {
    return setTimeout(next, clamp(Number(slowMatch[1]), 0, 60_000));
  }
  next();
});
app.use(applyAuth);

function authQuery(req) {
  const token = String(req.query.access_token || '');
  const entry = accessTokens.get(token);
  if (!entry || entry.expiresAt <= Date.now()) return null;
  return entry.user;
}

function sendEvent(client, event) {
  const payload = JSON.stringify(event);
  if (client.type === 'ws') {
    if (client.socket.readyState === WebSocket.OPEN) client.socket.send(payload);
  } else if (!client.res.writableEnded) {
    if (event.type === 'metric') client.res.write(`id: ${event.offset}\n`);
    client.res.write(`event: ${event.type}\ndata: ${payload}\n\n`);
  }
}

function recipientsFor(event, forced) {
  for (const client of [...wsClients, ...sseClients]) {
    const dropSetting = client.forced.drop || String(forced.drop || chaos.ws || '');
    const dropMatch = /^drop:(\d+)$/.exec(dropSetting);
    if (dropMatch && Math.random() * 100 < Number(dropMatch[1])) continue;
    if (client.forced.silent) continue;
    const garbage = /^(\d+)$/.exec(String(client.forced.garbage || forced.garbage || ''));
    const globalGarbage = /^garbage:(\d+)$/.exec(String(chaos.chaos || ''));
    const garbagePct = Number(garbage?.[1] || globalGarbage?.[1] || 0);
    let outgoing = event;
    if (garbagePct && Math.random() * 100 < garbagePct) {
      outgoing = Math.random() < 0.5 ? '{not-json' : { type: 'metric', offset: event.offset };
      if (client.type === 'ws' && client.socket.readyState === WebSocket.OPEN) {
        client.socket.send(typeof outgoing === 'string' ? outgoing : JSON.stringify(outgoing));
      } else if (client.type === 'sse' && !client.res.writableEnded) {
        client.res.write(`event: metric\ndata: ${typeof outgoing === 'string' ? outgoing : JSON.stringify(outgoing)}\n\n`);
      }
      continue;
    }
    sendEvent(client, outgoing);
    if (String(client.forced.dupe || forced.dupe || chaos.chaos || '').includes('dupe') && Math.random() < 0.1) {
      setTimeout(() => sendEvent(client, outgoing), Math.random() * 1000);
    }
  }
}

function dispatchMetric(event) {
  const shuffle = String(chaos.chaos || '').includes('shuffle') ||
    [...wsClients, ...sseClients].some((client) => client.forced.shuffle);
  if (!shuffle) return recipientsFor(event, {});
  shuffleBuffer.push(event);
  if (!shuffleTimer) {
    shuffleTimer = setTimeout(() => {
      shuffleTimer = null;
      for (let index = shuffleBuffer.length - 1; index > 0; index--) {
        const swap = Math.floor(Math.random() * (index + 1));
        [shuffleBuffer[index], shuffleBuffer[swap]] = [shuffleBuffer[swap], shuffleBuffer[index]];
      }
      for (const buffered of shuffleBuffer.splice(0)) recipientsFor(buffered, {});
    }, 350);
  }
}

function makeMetric(index) {
  const prev = latest[index];
  const p95 = clamp(Math.round((prev?.p95 || 120) + (Math.random() - 0.5) * 55), 20, 2000);
  const errRate = Number(clamp((prev?.errRate || 0.2) + (Math.random() - 0.5) * 0.7, 0, 20).toFixed(2));
  const rps = clamp(Math.round((prev?.rps || 500) + (Math.random() - 0.5) * 300), 0, 5000);
  const status = errRate > 5 || p95 > 900 ? 'down' : errRate > 2 || p95 > 500 ? 'degraded' : 'healthy';
  services[index].status = status;
  const event = {
    type: 'metric',
    offset: ++globalOffset,
    serviceId: services[index].id,
    seq: ++sequences[index],
    ts: Date.now(),
    p95,
    errRate,
    rps,
    status
  };
  latest[index] = event;
  replayEvents.push(event);
  return event;
}

const baselineTs = Date.now();
for (let index = 0; index < services.length; index++) latest[index] = makeMetric(index);
replayEvents.length = 0;
replayStart = 0;
globalOffset = 0;
for (let index = 0; index < services.length; index++) {
  latest[index].offset = 0;
  latest[index].seq = 0;
}

setInterval(() => {
  const rate = clamp(Number(chaos.rate || 500), 1, 5000);
  const exactCount = rate / 10 + tickRemainder;
  eventsPerTick = Math.floor(exactCount);
  tickRemainder = exactCount - eventsPerTick;
  for (let index = 0; index < eventsPerTick; index++) dispatchMetric(makeMetric(Math.floor(Math.random() * services.length)));
  const cutoff = Date.now() - MAX_REPLAY_AGE_MS;
  while (replayStart < replayEvents.length &&
    (replayEvents.length - replayStart > MAX_REPLAY_EVENTS || replayEvents[replayStart].ts < cutoff)) replayStart++;
  if (replayStart > 10_000 && replayStart > replayEvents.length / 2) {
    replayEvents.splice(0, replayStart);
    replayStart = 0;
  }
}, 100);

setInterval(() => {
  const ping = { type: 'ping', ts: Date.now() };
  for (const client of [...wsClients, ...sseClients]) {
    if (!client.forced.silent) sendEvent(client, ping);
  }
}, 5000);

function closeTransport(type) {
  if (type === 'ws') {
    for (const client of wsClients) client.socket.close(1012, 'Transport disabled by chaos switch');
  } else {
    for (const client of sseClients) {
      client.res.end();
      sseClients.delete(client);
    }
  }
}

function applyChaosUpdate(body) {
  chaos = { ...chaos, ...body };
  if (chaos.ws === 'down') closeTransport('ws');
  if (chaos.sse === 'down') closeTransport('sse');
}

app.post('/auth/login', (req, res) => {
  const user = users.find((item) => item.email === req.body?.email && item.password === req.body?.password);
  if (!user) return makeError(res, 401, 'invalid_credentials', 'Email or password is incorrect');
  res.json(issueTokens(user));
});

app.post('/auth/refresh', (req, res) => {
  const oldToken = req.body?.refreshToken;
  const user = refreshTokens.get(oldToken);
  if (!user) return makeError(res, 401, 'refresh_invalid', 'Refresh token is invalid');
  refreshTokens.delete(oldToken);
  res.json(issueTokens(user));
});

app.get('/services', (_req, res) => res.json(services));

app.get('/metrics/snapshot', (_req, res) => {
  res.json({ offset: globalOffset, ts: Date.now(), metrics: latest });
});

app.get('/metrics/history', (req, res) => {
  const serviceId = String(req.query.serviceId || '');
  const minutes = Number(req.query.minutes || 15);
  const index = Number(serviceId.slice(4)) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= services.length || !Number.isInteger(minutes) || minutes < 1 || minutes > 60) {
    return makeError(res, 400, 'bad_request', 'Invalid serviceId or minutes');
  }
  const current = latest[index];
  const now = Date.now();
  const points = Array.from({ length: minutes * 60 }, (_, pointIndex) => ({
    ts: now - (minutes * 60 - pointIndex) * 1000,
    p95: current.p95 + Math.round((Math.random() - 0.5) * 30),
    errRate: Number(clamp(current.errRate + (Math.random() - 0.5) * 0.2, 0, 100).toFixed(2)),
    rps: clamp(current.rps + Math.round((Math.random() - 0.5) * 100), 0, 5000)
  }));
  res.json({ serviceId, points });
});

app.get('/metrics/replay', (req, res) => {
  const since = Number(req.query.since);
  if (!Number.isSafeInteger(since) || since < 0) return makeError(res, 400, 'bad_request', 'since must be a non-negative offset');
  if (replayStart < replayEvents.length && since < replayEvents[replayStart].offset - 1) return makeError(res, 410, 'replay_too_old', 'Requested events are no longer retained');
  res.json({ events: replayEvents.slice(replayStart).filter((event) => event.offset > since), offset: globalOffset });
});

app.get('/rules', (_req, res) => res.json([...rules.values()]));
app.get('/rules/check-name', (req, res) => {
  const name = String(req.query.name || '').trim().toLowerCase();
  const excludeId = String(req.query.excludeId || '');
  res.json({ available: ![...rules.values()].some((rule) => rule.id !== excludeId && rule.name.toLowerCase() === name) });
});
app.get('/rules/:id', (req, res) => {
  const rule = rules.get(req.params.id);
  return rule ? res.json(rule) : makeError(res, 404, 'not_found', 'Rule not found');
});

function validateRule(body) {
  const details = [];
  if (typeof body?.name !== 'string' || !body.name.trim()) details.push({ field: 'name', message: 'A rule name is required' });
  if (!Array.isArray(body?.conditions) || body.conditions.length < 1) details.push({ field: 'conditions', message: 'Add at least one condition' });
  for (const [index, condition] of (body?.conditions || []).entries()) {
    if (!['p95', 'errRate', 'rps'].includes(condition.metric)) details.push({ field: `conditions.${index}.metric`, message: 'Invalid metric' });
    if (!['>', '>=', '<', '<='].includes(condition.operator)) details.push({ field: `conditions.${index}.operator`, message: 'Invalid operator' });
    if (!Number.isFinite(condition.threshold) || !Number.isFinite(condition.durationSec) || condition.durationSec < 0) {
      details.push({ field: `conditions.${index}`, message: 'Threshold and duration must be valid numbers' });
    }
  }
  return details;
}

app.post('/rules', (req, res) => {
  if (req.user.role !== 'operator') return makeError(res, 403, 'forbidden', 'Operator role required');
  const key = String(req.get('Idempotency-Key') || '');
  if (!key) return makeError(res, 400, 'bad_request', 'Idempotency-Key header is required');
  if (idempotency.has(key)) return res.status(201).json(idempotency.get(key));
  const details = validateRule(req.body);
  if (details.length) return makeError(res, 422, 'validation', 'Rule validation failed', details);
  if ([...rules.values()].some((rule) => rule.name.toLowerCase() === req.body.name.trim().toLowerCase())) {
    return makeError(res, 409, 'name_taken', 'Rule name is already in use');
  }
  const now = Date.now();
  const rule = { ...req.body, id: `r-${crypto.randomUUID().slice(0, 8)}`, name: req.body.name.trim(), createdAt: now, updatedAt: now };
  rules.set(rule.id, rule);
  idempotency.set(key, rule);
  res.status(201).json(rule);
});

app.put('/rules/:id', (req, res) => {
  if (req.user.role !== 'operator') return makeError(res, 403, 'forbidden', 'Operator role required');
  const previous = rules.get(req.params.id);
  if (!previous) return makeError(res, 404, 'not_found', 'Rule not found');
  const details = validateRule(req.body);
  if (details.length) return makeError(res, 422, 'validation', 'Rule validation failed', details);
  if ([...rules.values()].some((rule) => rule.id !== previous.id && rule.name.toLowerCase() === req.body.name.trim().toLowerCase())) {
    return makeError(res, 409, 'name_taken', 'Rule name is already in use');
  }
  const rule = { ...previous, ...req.body, id: previous.id, updatedAt: Date.now() };
  rules.set(rule.id, rule);
  res.json(rule);
});

app.delete('/rules/:id', (req, res) => {
  if (req.user.role !== 'operator') return makeError(res, 403, 'forbidden', 'Operator role required');
  if (!rules.delete(req.params.id)) return makeError(res, 404, 'not_found', 'Rule not found');
  res.status(204).end();
});

app.post('/telemetry', (_req, res) => res.status(202).end());
app.get('/assistant/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const question = String(req.query.q || 'How is the fleet doing?');
  for (const [index, text] of [`You asked: ${question}. `, 'This demo assistant streams mock responses. ', 'Check the incident panel for active alerts.'].entries()) {
    setTimeout(() => res.write(`event: token\ndata: ${JSON.stringify({ text })}\n\n`), index * 300);
  }
  setTimeout(() => res.end('event: done\ndata: {}\n\n'), 1000);
});
app.get('/chaos', (_req, res) => res.json(chaos));
app.post('/chaos', (req, res) => {
  applyChaosUpdate(req.body || {});
  res.json(chaos);
});
app.delete('/chaos', (_req, res) => {
  chaos = { rate: 500 };
  res.json(chaos);
});
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

function parseConnectionChaos(url) {
  const parsed = new URL(url, `http://localhost:${PORT}`);
  const has = (key) => parsed.searchParams.has(key);
  return {
    wsDown: has('ws') && parsed.searchParams.get('ws') === 'down',
    sseDown: has('sse') && parsed.searchParams.get('sse') === 'down',
    silent: parsed.searchParams.get('ws') === 'silent',
    drop: parsed.searchParams.get('ws')?.startsWith('drop:') ? parsed.searchParams.get('ws') : '',
    dupe: parsed.searchParams.get('chaos')?.includes('dupe') ? 'dupe' : '',
    shuffle: parsed.searchParams.get('chaos')?.includes('shuffle') || false,
    garbage: parsed.searchParams.get('chaos')?.match(/garbage:(\d+)/)?.[1] || ''
  };
}

app.get('/stream/sse', (req, res) => {
  if (!req.user && !authQuery(req)) return makeError(res, 401, 'token_invalid', 'Invalid access token');
  const forced = parseConnectionChaos(req.originalUrl);
  if (forced.sseDown || chaos.sse === 'down') return makeError(res, 503, 'unavailable', 'SSE transport unavailable');
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const client = { type: 'sse', res, forced };
  sseClients.add(client);
  req.on('close', () => sseClients.delete(client));
});

app.use((_req, res) => makeError(res, 404, 'not_found', 'Endpoint not found'));
app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  const status = Number(error.status || error.statusCode || 500);
  if (status >= 500) console.error('Unhandled API error:', error);
  const code = status === 400 ? 'bad_request' : status >= 500 ? 'server_error' : 'bad_request';
  return makeError(res, status, code, status === 400 ? 'Malformed request body' : 'Request could not be completed');
});

server.on('upgrade', (req, socket, head) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  if (parsed.pathname !== '/stream') return socket.destroy();
  const auth = currentUser({ get: () => `Bearer ${parsed.searchParams.get('access_token') || ''}` });
  const forced = parseConnectionChaos(req.url);
  if (!auth.user || forced.wsDown || chaos.ws === 'down') {
    socket.write(`HTTP/1.1 ${auth.user ? '503 Service Unavailable' : '401 Unauthorized'}\r\n\r\n`);
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const client = { type: 'ws', socket: ws, forced };
    wsClients.add(client);
    ws.on('close', () => wsClients.delete(client));
  });
});

setInterval(() => {
  const interval = Number(chaos.kill || 0);
  if (interval > 0 && Math.floor(Date.now() / 1000) % interval === 0) {
    closeTransport('ws');
    closeTransport('sse');
  }
}, 1000);

server.listen(PORT, () => console.log(`Fleet Pulse mock API listening on http://localhost:${PORT} (started ${new Date(baselineTs).toISOString()})`));
if (SECONDARY_PORT > 0) {
  secondaryServer.listen(SECONDARY_PORT, () => console.log(`Circuit-breaker secondary listener on http://localhost:${SECONDARY_PORT}`));
}
