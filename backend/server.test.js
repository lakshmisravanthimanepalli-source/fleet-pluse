const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const net = require('node:net');

let child;
let baseUrl;
let secondaryUrl;
let operatorToken;

async function unusedPort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error('Backend process exited before becoming ready');
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error('Backend did not become ready');
}

async function waitForEndpoint(url) {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Backend did not become ready at ${url}`);
}

before(async () => {
  const port = await unusedPort();
  let secondaryPort = await unusedPort();
  while (secondaryPort === port) secondaryPort = await unusedPort();
  baseUrl = `http://127.0.0.1:${port}`;
  secondaryUrl = `http://127.0.0.1:${secondaryPort}`;
  child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    cwd: __dirname,
    env: { ...process.env, PORT: String(port), PORT_SECONDARY: String(secondaryPort) },
    stdio: 'ignore',
  });
  await waitForHealth();
  await waitForEndpoint(`${secondaryUrl}/health`);
  const login = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'operator@pulse.dev', password: 'pulse123' }),
  });
  operatorToken = (await login.json()).accessToken;
});

after(() => {
  if (child && child.exitCode === null) child.kill();
});

test('health and initial fleet snapshot match the API contract', async () => {
  const health = await fetch(`${baseUrl}/health`);
  assert.deepEqual(await health.json(), { status: 'ok' });
  const services = await fetch(`${baseUrl}/services`, { headers: { Authorization: `Bearer ${operatorToken}` } });
  assert.equal(services.status, 200);
  assert.equal((await services.json()).length, 2000);
  const snapshot = await fetch(`${baseUrl}/metrics/snapshot`, { headers: { Authorization: `Bearer ${operatorToken}` } });
  const body = await snapshot.json();
  assert.equal(body.metrics.length, 2000);
  assert.equal(typeof body.offset, 'number');
});

test('refresh tokens rotate and old tokens cannot be reused', async () => {
  const login = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'viewer@pulse.dev', password: 'pulse123' }),
  });
  const first = await login.json();
  const refresh = await fetch(`${baseUrl}/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: first.refreshToken }),
  });
  const second = await refresh.json();
  assert.equal(refresh.status, 200);
  assert.notEqual(second.refreshToken, first.refreshToken);
  const reused = await fetch(`${baseUrl}/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: first.refreshToken }),
  });
  assert.equal(reused.status, 401);
});

test('rules require operator permission and create idempotently', async () => {
  const viewerLogin = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'viewer@pulse.dev', password: 'pulse123' }),
  });
  const viewerToken = (await viewerLogin.json()).accessToken;
  const denied = await fetch(`${baseUrl}/rules`, {
    method: 'POST', headers: { Authorization: `Bearer ${viewerToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'viewer-denied' },
    body: JSON.stringify({ name: 'Viewer rule', conditions: [{ metric: 'p95', operator: '>', threshold: 200, durationSec: 1 }] }),
  });
  assert.equal(denied.status, 403);

  const payload = { name: 'Test latency rule', conditions: [{ metric: 'p95', operator: '>', threshold: 200, durationSec: 1 }] };
  const headers = { Authorization: `Bearer ${operatorToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'test-create-once' };
  const created = await fetch(`${baseUrl}/rules`, { method: 'POST', headers, body: JSON.stringify(payload) });
  const firstRule = await created.json();
  const nameCheck = await fetch(`${baseUrl}/rules/check-name?name=${encodeURIComponent(payload.name)}`, {
    headers: { Authorization: `Bearer ${operatorToken}` },
  });
  assert.deepEqual(await nameCheck.json(), { available: false });
  const repeated = await fetch(`${baseUrl}/rules`, { method: 'POST', headers, body: JSON.stringify(payload) });
  const repeatedRule = await repeated.json();
  assert.equal(created.status, 201);
  assert.equal(repeated.status, 201);
  assert.equal(repeatedRule.id, firstRule.id);
  await fetch(`${baseUrl}/rules/${firstRule.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${operatorToken}` } });
});

test('secondary listener shares reads and bypasses HTTP chaos', async () => {
  await fetch(`${baseUrl}/chaos`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ http: '500:100' }),
  });
  const headers = { Authorization: `Bearer ${operatorToken}` };
  const primary = await fetch(`${baseUrl}/services`, { headers });
  const secondary = await fetch(`${secondaryUrl}/services`, { headers });
  assert.equal(primary.status, 500);
  assert.equal(secondary.status, 200);
  await fetch(`${baseUrl}/chaos`, { method: 'DELETE' });
});

test('assistant endpoint accepts stream query auth and sends token events', async () => {
  const response = await fetch(
    `${baseUrl}/assistant/stream?access_token=${encodeURIComponent(operatorToken)}&q=${encodeURIComponent('fleet status')}`,
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const reader = response.body.getReader();
  const firstChunk = await reader.read();
  assert.match(new TextDecoder().decode(firstChunk.value), /event: token/);
  await reader.cancel();
});

test('SSE fallback accepts query auth and rejects missing credentials', async () => {
  const unauthorized = await fetch(`${baseUrl}/stream/sse?access_token=invalid`);
  assert.equal(unauthorized.status, 401);

  await fetch(`${baseUrl}/chaos`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ws: 'down' }),
  });
  const response = await fetch(
    `${baseUrl}/stream/sse?access_token=${encodeURIComponent(operatorToken)}`,
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  await response.body.cancel();
  await fetch(`${baseUrl}/chaos`, { method: 'DELETE' });
});
