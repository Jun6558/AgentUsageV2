import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { startBridge } from '../electron/bridge.js';

const source = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');

function loadBackground(base) {
  const storage = {};
  let listener, alarm, reloads = 0;
  const chrome = {
    runtime: { getURL: p => `chrome-extension://fixture/${p}`, onMessage: { addListener: fn => { listener = fn; } } },
    storage: { local: {
      setAccessLevel: async () => {},
      get: async () => ({ ...storage }),
      set: async values => Object.assign(storage, values),
    } },
    alarms: { create: () => {}, onAlarm: { addListener: fn => { alarm = fn; } } },
    tabs: {
      query: async () => [{ id: 1, url: 'https://claude.ai/settings/usage' }],
      reload: async () => { reloads++; },
      sendMessage: async () => ({ provider: 'claude', windows: [{ id: 'session', usedPercent: 35 }] }),
    },
  };
  vm.runInNewContext(source, { chrome, URL, AbortSignal, fetch: (url, options) => fetch(url.replace('http://127.0.0.1:43127', base), options) });
  const send = (message, sender = { url: 'chrome-extension://fixture/popup.html' }) => new Promise(resolve => {
    const pending = listener(message, sender, resolve);
    if (!pending) resolve(undefined);
  });
  return { send, storage, alarm: () => alarm(), reloads: () => reloads };
}

test('extension pairs and syncs metrics through the real authenticated bridge', async t => {
  const received = [];
  const key = 'a'.repeat(64);
  const server = await startBridge({ token: key, port: 0, onSnapshot: data => received.push(data) });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const extension = loadBackground(`http://127.0.0.1:${server.address().port}`);
  assert.equal((await extension.send({ type: 'pair', key: 'invalid' })).ok, false);
  assert.equal((await extension.send({ type: 'pair', key: 'b'.repeat(64) })).ok, false);
  assert.equal((await extension.send({ type: 'pair', key })).ok, true);
  assert.equal((await extension.send({ type: 'sync' })).ok, true);
  assert.equal(received[0].windows[0].usedPercent, 35);
  assert.ok(extension.storage.lastSync);
  await extension.alarm();
  assert.equal(extension.reloads(), 1);
});

test('only the popup can pair; only the exact usage page can submit metrics', async t => {
  const received = [];
  const key = 'c'.repeat(64);
  const server = await startBridge({ token: key, port: 0, onSnapshot: data => received.push(data) });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const extension = loadBackground(`http://127.0.0.1:${server.address().port}`);
  const snapshot = { provider: 'claude', windows: [{ id: 'weekly', usedPercent: 10 }] };
  assert.equal(await extension.send({ type: 'pair', key }, { url: 'https://claude.ai/settings/usage' }), undefined);
  await extension.send({ type: 'pair', key });
  for (const url of ['https://example.com/settings/usage', 'https://claude.ai/chat/123', 'https://claude.ai/settings/usage-fake']) {
    assert.equal(await extension.send({ type: 'usage', snapshot }, { tab: { url } }), undefined);
  }
  assert.equal(received.length, 0);
  assert.equal((await extension.send({ type: 'usage', snapshot }, { tab: { url: 'https://claude.ai/settings/usage' } })).ok, true);
  assert.equal(received.length, 1);
});
