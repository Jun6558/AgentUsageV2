import { ClaudeSessionError, normalizeSessionKey, POLL_INTERVAL_MS } from './claude-session.js';

export function createSessionController({ store, client, onState, onUsage, schedule = setTimeout, cancel = clearTimeout }) {
  let key = null, organizationId = null, active = null, timer = null;
  let state = { configured: false, canStore: store.available(), status: 'idle', message: '', organizations: [], organizationId: null, nextRefreshAt: null };
  const publish = patch => { state = { ...state, ...patch }; onState(structuredClone(state)); };
  function stopRequest() {
    if (timer) cancel(timer);
    timer = null;
    active?.abort.abort();
    active = null;
  }
  async function refresh() {
    if (!key) return { ok: false, message: '먼저 로그인 세션을 등록하세요.' };
    if (active) return active.promise;
    if (timer) cancel(timer);
    timer = null;
    const request = { abort: new AbortController(), promise: null };
    active = request;
    const requestKey = key;
    request.promise = (async () => {
      let delay = null;
      publish({ status: 'polling', message: 'Claude 사용량을 조회하고 있습니다.', nextRefreshAt: null });
      try {
        if (!organizationId) {
          const organizations = await client.organizations(requestKey, { signal: request.abort.signal });
          if (active !== request) return { ok: false };
          publish({ organizations });
          if (organizations.length !== 1) throw new ClaudeSessionError('organization');
          organizationId = organizations[0].id;
        }
        const snapshot = await client.usage(requestKey, organizationId, { signal: request.abort.signal });
        if (active !== request) return { ok: false };
        store.save(requestKey, organizationId);
        onUsage(snapshot);
        delay = POLL_INTERVAL_MS;
        publish({ status: 'connected', message: '브라우저를 열지 않아도 5분마다 갱신합니다.', organizationId });
        return { ok: true };
      } catch (error) {
        if (active !== request) return { ok: false };
        const known = error instanceof ClaudeSessionError ? error : new ClaudeSessionError('network');
        if (['network', 'response', 'rate_limit'].includes(known.code)) delay = known.retryAfterMs || POLL_INTERVAL_MS;
        publish({ status: known.code === 'organization' ? 'choose-organization' : 'error', message: known.message });
        return { ok: false, message: known.message };
      } finally {
        if (active === request) {
          active = null;
          if (delay && key) {
            timer = schedule(() => { timer = null; void refresh(); }, delay);
            publish({ nextRefreshAt: new Date(Date.now() + delay).toISOString() });
          }
        }
      }
    })();
    return request.promise;
  }
  return {
    getState: () => structuredClone(state),
    async restore() {
      try {
        const saved = store.load();
        if (!saved) return;
        key = saved.key;
        organizationId = saved.organizationId;
        publish({ configured: true, organizationId });
        return await refresh();
      } catch { publish({ configured: true, status: 'error', message: '저장된 로그인 세션을 복호화하지 못했습니다. 삭제 후 다시 등록하세요.' }); }
    },
    async connect(value) {
      try {
        const next = normalizeSessionKey(value);
        store.save(next);
        stopRequest();
        key = next;
        organizationId = null;
        onUsage(null);
        publish({ configured: true, organizations: [], organizationId: null, nextRefreshAt: null });
        return await refresh();
      } catch (error) { return { ok: false, message: error instanceof ClaudeSessionError ? error.message : '로그인 세션을 저장하지 못했습니다.' }; }
    },
    async selectOrganization(id) {
      if (!key || !state.organizations.some(item => item.id === id)) return { ok: false, message: '목록에서 조직을 선택하세요.' };
      try { store.save(key, id); }
      catch { return { ok: false, message: '조직 선택을 저장하지 못했습니다.' }; }
      stopRequest();
      organizationId = id;
      onUsage(null);
      publish({ organizationId: id, nextRefreshAt: null });
      return refresh();
    },
    refresh,
    forget() {
      try { store.clear(); }
      catch { return { ok: false, message: '저장된 세션을 삭제하지 못했습니다.' }; }
      stopRequest();
      key = null;
      organizationId = null;
      onUsage(null);
      publish({ configured: false, status: 'idle', message: '', organizations: [], organizationId: null, nextRefreshAt: null });
      return { ok: true };
    },
    dispose() { stopRequest(); key = null; },
  };
}
