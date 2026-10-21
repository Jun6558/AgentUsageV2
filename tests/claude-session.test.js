import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCipheriv, createDecipheriv } from 'node:crypto';
import { createClaudeSessionClient, normalizeSessionKey, parseClaudeApiUsage, ClaudeSessionError, POLL_INTERVAL_MS } from '../electron/claude-session.js';
import { createSessionController } from '../electron/session-controller.js';
import { createSessionStore } from '../electron/session-store.js';

// Fixture-only credentials; no real login values are used by tests.
const KEY = 'fixture-session-value-1234567890';
const ORG = '00000000-0000-4000-8000-000000000001';
const OTHER_ORG = '00000000-0000-4000-8000-000000000002';
const organizations = [{ id: ORG, name: 'Personal' }];
const usage = { five_hour: { utilization: 28, resets_at: '2026-10-21T14:00:00Z' }, seven_day: { utilization: 62, resets_at: null }, seven_day_sonnet: null };
const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

test('session input accepts one cookie and rejects headers or injection', () => {
  assert.equal(normalizeSessionKey(`sessionKey=${KEY};`), KEY);
  for (const value of ['', null, 'short', `${KEY}; other=value`, `${KEY}\r\nX-Test: yes`, `${KEY} other`, 'a'.repeat(4097)]) {
    assert.throws(() => normalizeSessionKey(value), error => error.code === 'cookie');
  }
});

test('API usage maps real windows, preserves zeros, and rejects unknown data', () => {
  const result = parseClaudeApiUsage(usage, 0);
  assert.equal(result.windows[0].usedPercent, 28);
  assert.equal(result.windows[1].usedPercent, 62);
  assert.equal(result.windows[1].resetText, '');
  assert.equal(result.windows.length, 2);
  assert.equal(result.updatedAt, '1970-01-01T00:00:00.000Z');
  assert.equal(parseClaudeApiUsage({ five_hour: { utilization: 0 } }).windows[0].usedPercent, 0);
  for (const bad of [{}, { five_hour: { utilization: '28' } }, { five_hour: { utilization: 101 } }, { five_hour: { utilization: 1, resets_at: 'not a date' } }]) assert.throws(() => parseClaudeApiUsage(bad));
});

test('session requests only target fixed HTTPS Claude endpoints and never follow redirects', async () => {
  const calls = [];
  const client = createClaudeSessionClient({ fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return url.endsWith('/organizations') ? json([{ uuid: ORG, name: 'Personal', privateField: 'not returned' }]) : json(usage);
  } });
  assert.deepEqual(await client.organizations(KEY), organizations);
  assert.equal((await client.usage(KEY, ORG)).windows.length, 2);
  assert.deepEqual(calls.map(c => c.url), ['https://claude.ai/api/organizations', `https://claude.ai/api/organizations/${ORG}/usage`]);
  for (const { options } of calls) {
    assert.equal(options.headers.Cookie, `sessionKey=${KEY}`);
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal);
  }
  await assert.rejects(client.usage(KEY, '../evil'), error => error.code === 'organization');
  await assert.rejects(client.organizations('invalid'), error => error.code === 'cookie');
  assert.equal(calls.length, 2);
});

test('auth, access denial, redirect and rate limit errors are actionable and redact server bodies', async () => {
  for (const [status, code] of [[401, 'unauthorized'], [403, 'blocked'], [302, 'unauthorized'], [429, 'rate_limit'], [500, 'network']]) {
    const client = createClaudeSessionClient({ fetchImpl: async () => new Response(KEY, { status, headers: { 'Retry-After': '900', Location: 'https://other.invalid' } }) });
    await assert.rejects(client.organizations(KEY), error => {
      assert.equal(error.code, code);
      assert.ok(!error.message.includes(KEY));
      if (status === 429) assert.equal(error.retryAfterMs, 900_000);
      return true;
    });
  }
});

test('oversized, HTML and missing-organization responses never become valid usage', async () => {
  for (const response of [new Response('x'.repeat(200_001)), new Response('<html>login</html>'), json([])]) {
    const client = createClaudeSessionClient({ fetchImpl: async () => response });
    await assert.rejects(client.organizations(KEY));
  }
});

function harness(overrides = {}) {
  let saved = null;
  const snapshots = [], states = [], scheduled = [];
  const store = {
    available: () => true, load: () => saved,
    save: (key, organizationId = null) => { saved = { key, organizationId }; }, clear: () => { saved = null; },
  };
  const controller = createSessionController({
    store, client: { organizations: async () => organizations, usage: async () => parseClaudeApiUsage(usage), ...overrides },
    onUsage: value => snapshots.push(value), onState: value => states.push(value),
    schedule: (fn, delay) => { const task = { fn, delay }; scheduled.push(task); return task; },
    cancel: task => { task.cancelled = true; },
  });
  return { controller, snapshots, states, scheduled, store, saved: () => saved };
}

test('connect saves a session, polls without a browser, and exposes no credential in app state', async () => {
  const h = harness();
  assert.equal((await h.controller.connect(KEY)).ok, true);
  assert.equal(h.controller.getState().status, 'connected');
  assert.equal(h.saved().organizationId, ORG);
  assert.equal(h.snapshots.at(-1).windows[0].usedPercent, 28);
  assert.equal(h.scheduled[0].delay, POLL_INTERVAL_MS);
  assert.ok(!JSON.stringify(h.states).includes(KEY));
  h.scheduled[0].fn();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.snapshots.filter(Boolean).length, 2);
  h.controller.dispose();
});

test('multiple organizations require an explicit choice before reading usage', async () => {
  const h = harness({ organizations: async () => [...organizations, { id: OTHER_ORG, name: 'Work' }] });
  assert.equal((await h.controller.connect(KEY)).ok, false);
  assert.equal(h.controller.getState().status, 'choose-organization');
  assert.equal(h.snapshots.filter(Boolean).length, 0);
  assert.equal((await h.controller.selectOrganization('unlisted')).ok, false);
  assert.equal((await h.controller.selectOrganization(OTHER_ORG)).ok, true);
  assert.equal(h.saved().organizationId, OTHER_ORG);
  h.controller.dispose();
});

test('expired authentication stops polling; temporary throttling respects backoff', async () => {
  for (const code of ['unauthorized', 'blocked', 'rate_limit']) {
    const h = harness({ usage: async () => { throw new ClaudeSessionError(code, { retryAfterMs: 900_000 }); } });
    assert.equal((await h.controller.connect(KEY)).ok, false);
    assert.equal(h.controller.getState().status, 'error');
    assert.equal(h.scheduled.length, code === 'rate_limit' ? 1 : 0);
    if (code === 'rate_limit') assert.equal(h.scheduled[0].delay, 900_000);
    h.controller.dispose();
  }
});

test('disconnect cancels outstanding reads and discards a late response', async () => {
  let complete;
  const h = harness({ usage: () => new Promise(resolve => { complete = resolve; }) });
  const pending = h.controller.connect(KEY);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.controller.forget().ok, true);
  complete(parseClaudeApiUsage(usage));
  await pending;
  assert.equal(h.saved(), null);
  assert.equal(h.controller.getState().configured, false);
  assert.equal(h.snapshots.filter(Boolean).length, 0);
  assert.equal(h.scheduled.length, 0);
});

test('unavailable secure storage refuses to persist credentials', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentusage-session-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'session.enc');
  const store = createSessionStore({ filePath, supported: true, encryption: { isEncryptionAvailable: () => false } });
  assert.equal(store.available(), false);
  assert.throws(() => store.save(KEY), error => error.code === 'storage');
  await assert.rejects(readFile(filePath), { code: 'ENOENT' });
});

test('store persists only encrypted bytes and restores or deletes a saved session', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agentusage-session-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'session.enc');
  // Real DPAPI is verified on Windows; this fixture tests the storage boundary.
  const cipherKey = Buffer.alloc(32, 1), iv = Buffer.alloc(16, 2);
  const encryption = {
    isEncryptionAvailable: () => true,
    encryptString: value => { const cipher = createCipheriv('aes-256-cbc', cipherKey, iv); return Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]); },
    decryptString: value => { const cipher = createDecipheriv('aes-256-cbc', cipherKey, iv); return Buffer.concat([cipher.update(value), cipher.final()]).toString('utf8'); },
  };
  const store = createSessionStore({ filePath, encryption, supported: true });
  store.save(KEY, ORG);
  assert.ok(!(await readFile(filePath)).includes(Buffer.from(KEY)));
  assert.deepEqual(store.load(), { key: KEY, organizationId: ORG });
  store.clear();
  assert.equal(store.load(), null);
});
