const BASE = 'http://127.0.0.1:43127';
const USAGE_URL = 'https://claude.ai/settings/usage';
const isUsageUrl = value => {
  try { const url = new URL(value); return url.origin === 'https://claude.ai' && url.pathname.replace(/\/$/, '') === '/settings/usage'; }
  catch { return false; }
};
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });

async function request(path, token, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(res.status === 401 ? '연결 키를 확인하세요.' : `앱 응답 오류 (${res.status})`);
  return res.json();
}
async function sendUsage(snapshot) {
  const { pairingKey } = await chrome.storage.local.get('pairingKey');
  if (!pairingKey) throw new Error('앱에서 연결 키를 복사해 먼저 연결하세요.');
  await request('/usage', pairingKey, snapshot);
  await chrome.storage.local.set({ lastSync: new Date().toISOString(), lastError: '' });
}
async function collect() {
  const tabs = (await chrome.tabs.query({ url: `${USAGE_URL}*` })).filter(tab => isUsageUrl(tab.url));
  if (!tabs.length) throw new Error('Claude 설정 → 사용량 페이지를 열어두세요.');
  let synced = false;
  for (const tab of tabs) {
    const snapshot = await chrome.tabs.sendMessage(tab.id, { type: 'collect' }).catch(() => null);
    if (snapshot) { await sendUsage(snapshot); synced = true; break; }
  }
  if (!synced) throw new Error('사용량 수치를 찾지 못했습니다. 페이지 로딩·언어를 확인하거나 새로고침하세요.');
}
chrome.alarms.create('sync', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => (async () => {
  const { pairingKey } = await chrome.storage.local.get('pairingKey');
  if (!pairingKey) return;
  const tabs = (await chrome.tabs.query({ url: `${USAGE_URL}*` })).filter(tab => isUsageUrl(tab.url));
  if (!tabs.length) throw new Error('Claude 사용량 페이지를 열어두세요.');
  // Refresh only the explicitly opened usage page, never other Claude chats.
  // Its newly injected content script sends the freshly rendered metrics.
  await chrome.tabs.reload(tabs[0].id);
})().catch(error => chrome.storage.local.set({ lastError: error.message })));
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.type === 'usage' && isUsageUrl(sender.tab?.url)) {
    sendUsage(message.snapshot).then(() => reply({ ok: true })).catch(error => reply({ ok: false, error: error.message }));
    return true;
  }
  // Pairing and manual refresh may only originate from this extension's popup.
  if (sender.url !== chrome.runtime.getURL('popup.html')) return false;
  if (message.type === 'pair') {
    (async () => {
      if (!/^[a-f0-9]{64}$/.test(message.key || '')) throw new Error('올바른 연결 키를 입력하세요.');
      const health = await request('/health', message.key);
      if (health.app !== 'AgentUsageV2') throw new Error('AgentUsageV2 앱을 찾지 못했습니다.');
      await chrome.storage.local.set({ pairingKey: message.key, lastError: '' });
      return { ok: true };
    })().then(reply).catch(error => reply({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === 'sync') {
    collect().then(() => reply({ ok: true })).catch(error => reply({ ok: false, error: error.message }));
    return true;
  }
});
