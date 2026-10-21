import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialUsage, validateSnapshot, remainingPercent } from '../electron/model.js';
import { startBridge } from '../electron/bridge.js';
import '../extension/parser.js';

const { parseUsage } = globalThis.AgentUsageParser;
const snapshot = { provider: 'claude', windows: [{ id: 'session', usedPercent: 28, resetText: 'Resets in 2 hr 30 min' }, { id: 'weekly', usedPercent: 62 }] };

test('unconnected subscriptions have no fabricated usage', () => {
  const usage = initialUsage();
  assert.equal(usage.chatgpt.status, 'unsupported');
  assert.equal(usage.gemini.status, 'unsupported');
  assert.equal(usage.claude.status, 'waiting');
  assert.ok(Object.values(usage).every(p => p.windows.length === 0));
});
test('English session and weekly limits are parsed independently', () => {
  assert.deepEqual(parseUsage('Usage\nCurrent session\nResets in 2 hr 30 min\n28% used\nWeekly limits\nAll models\n62% used\nResets Fri 3:00 PM\nSonnet only\n12% used\nExtra usage\n$10 used'), {
    provider: 'claude', windows: [
      { id: 'session', usedPercent: 28, resetText: 'Resets in 2 hr 30 min' },
      { id: 'weekly', usedPercent: 62, resetText: 'Resets Fri 3:00 PM' },
      { id: 'weekly-sonnet', usedPercent: 12, resetText: '' },
    ],
  });
});
test('Korean text and remaining percentages preserve direction', () => {
  const result = parseUsage('현재 세션\n72% 남음\n2시간 후 초기화\n주간 한도\n모든 모델\n62% 사용됨');
  assert.equal(result.windows[0].usedPercent, 28);
  assert.equal(result.windows[0].resetText, '2시간 후 초기화');
  assert.equal(result.windows[1].usedPercent, 62);
  assert.equal(remainingPercent(28), 72);
});
test('missing, unknown and out-of-range numbers do not become zero', () => {
  for (const text of ['', 'Loading...', 'Current session\n—', 'Current session\n101% used', 'Current session\n37%']) assert.equal(parseUsage(text), null);
  assert.equal(parseUsage('Current session\n0% used').windows[0].usedPercent, 0);
  assert.equal(parseUsage('Current session\n100% used').windows[0].usedPercent, 100);
});
test('partial page does not invent a weekly or session limit', () => {
  assert.equal(parseUsage('All models\n44% used').windows.length, 1);
  assert.equal(parseUsage('All models\n44% used').windows[0].id, 'weekly');
});
test('validation stamps receipt time and removes unrelated fields', () => {
  const result = validateSnapshot({ ...snapshot, cookie: 'not-to-be-stored' }, 0);
  assert.equal(result.updatedAt, '1970-01-01T00:00:00.000Z');
  assert.equal(result.cookie, undefined);
  assert.equal(result.status, 'connected');
});
test('validation rejects ambiguous or malformed metrics', () => {
  for (const value of [null, {}, { ...snapshot, provider: 'chatgpt' }, { ...snapshot, windows: [] },
    { ...snapshot, windows: [{ id: 'session', usedPercent: NaN }] },
    { ...snapshot, windows: [{ id: 'session', usedPercent: -1 }] },
    { ...snapshot, windows: [{ id: 'session', usedPercent: '28' }] },
    { ...snapshot, windows: [snapshot.windows[0], snapshot.windows[0]] },
    { ...snapshot, windows: [{ id: 'session', usedPercent: 2, resetText: 'x'.repeat(161) }] },
  ]) assert.throws(() => validateSnapshot(value));
});
test('bridge authenticates, validates and delivers actual HTTP requests', async t => {
  const received = [];
  const server = await startBridge({ token: 'a'.repeat(64), port: 0, onSnapshot: v => received.push(v) });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${'a'.repeat(64)}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/health`)).status, 401);
  assert.equal((await fetch(`${base}/health`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/usage`, { method: 'POST', headers, body: JSON.stringify(snapshot) })).status, 200);
  assert.equal(received.length, 1);
  assert.equal(received[0].windows[0].usedPercent, 28);
  assert.equal((await fetch(`${base}/usage`, { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(`${base}/usage`, { method: 'POST', headers, body: JSON.stringify({ ...snapshot, provider: 'gemini' }) })).status, 400);
  assert.equal((await fetch(`${base}/usage`, { method: 'POST', headers, body: JSON.stringify({ data: 'x'.repeat(9000) }) })).status, 413);
  assert.equal((await fetch(`${base}/usage`, { method: 'POST', headers: { Authorization: headers.Authorization }, body: '{}' })).status, 415);
  assert.equal(received.length, 1);
});
test('bridge reports persistence failures without claiming a sync', async t => {
  const server = await startBridge({ token: 'b'.repeat(64), port: 0, onSnapshot: () => { throw Error('disk'); } });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/usage`, {
    method: 'POST', headers: { Authorization: `Bearer ${'b'.repeat(64)}`, 'Content-Type': 'application/json' }, body: JSON.stringify(snapshot),
  });
  assert.equal(response.status, 500);
});
