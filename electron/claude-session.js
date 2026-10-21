import { validateSnapshot } from './model.js';

export const POLL_INTERVAL_MS = 5 * 60 * 1000;
const BASE = 'https://claude.ai/api';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const messages = {
  cookie: 'sessionKey 쿠키 값만 입력하세요. 전체 쿠키 헤더는 필요하지 않습니다.',
  unauthorized: '로그인 세션이 만료되었거나 유효하지 않습니다. sessionKey를 다시 등록하세요.',
  blocked: 'Claude가 직접 조회를 차단했습니다. 브라우저에서 로그인 상태를 확인하거나 확장 연동을 사용하세요.',
  rate_limit: '조회가 너무 잦습니다. 잠시 뒤 자동으로 다시 시도합니다.',
  network: 'Claude에 연결하지 못했습니다. 네트워크 연결을 확인하세요.',
  response: '사용량 응답을 읽지 못했습니다. 서비스 형식이 변경되었을 수 있습니다.',
  unsupported: '이 계정에서 읽을 수 있는 사용량 한도를 찾지 못했습니다.',
  organization: '사용량을 조회할 조직을 선택하세요.',
  storage: '로그인 세션을 암호화해 저장하지 못했습니다.',
};

export class ClaudeSessionError extends Error {
  constructor(code, details = {}) { super(messages[code] || messages.response); this.code = code; Object.assign(this, details); }
}

export function normalizeSessionKey(value) {
  if (typeof value !== 'string') throw new ClaudeSessionError('cookie');
  const key = value.trim().replace(/^sessionKey=/, '').replace(/;$/, '');
  if (key.length < 20 || key.length > 4096 || !/^[\x21-\x7E]+$/.test(key) || /[;,"\\]/.test(key)) throw new ClaudeSessionError('cookie');
  return key;
}

export function parseClaudeApiUsage(data, now = Date.now()) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ClaudeSessionError('response');
  const fields = { five_hour: 'session', seven_day: 'weekly', seven_day_sonnet: 'weekly-sonnet', seven_day_opus: 'weekly-opus' };
  const windows = [];
  for (const [field, id] of Object.entries(fields)) {
    const item = data[field];
    if (item == null) continue;
    if (typeof item.utilization !== 'number' || !Number.isFinite(item.utilization) || item.utilization < 0 || item.utilization > 100) throw new ClaudeSessionError('response');
    let resetText = '';
    if (item.resets_at != null) {
      if (typeof item.resets_at !== 'string' || !Number.isFinite(Date.parse(item.resets_at))) throw new ClaudeSessionError('response');
      resetText = `${new Date(item.resets_at).toLocaleString('ko-KR')} 초기화`;
    }
    windows.push({ id, usedPercent: item.utilization, resetText });
  }
  if (!windows.length) throw new ClaudeSessionError('unsupported');
  return validateSnapshot({ provider: 'claude', windows }, now);
}

export function createClaudeSessionClient({ fetchImpl = fetch } = {}) {
  async function get(path, key, signal) {
    const sessionKey = normalizeSessionKey(key);
    let response;
    try {
      response = await fetchImpl(`${BASE}${path}`, {
        method: 'GET', headers: { Cookie: `sessionKey=${sessionKey}`, Accept: 'application/json' },
        redirect: 'manual', cache: 'no-store', signal: AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]),
      });
    } catch { throw new ClaudeSessionError('network'); }
    if (!response.ok) {
      const status = response.status;
      const retryHeader = response.headers.get('retry-after');
      const retrySeconds = Number(retryHeader);
      const retryDate = Date.parse(retryHeader);
      const suggestedDelay = Number.isFinite(retrySeconds) && retrySeconds > 0 ? retrySeconds * 1000 : Number.isFinite(retryDate) ? retryDate - Date.now() : POLL_INTERVAL_MS;
      const retryAfterMs = Math.min(86400_000, Math.max(POLL_INTERVAL_MS, suggestedDelay));
      await response.body?.cancel();
      if (status === 401 || (status >= 300 && status < 400)) throw new ClaudeSessionError('unauthorized');
      if (status === 403) throw new ClaudeSessionError('blocked');
      if (status === 429) throw new ClaudeSessionError('rate_limit', { retryAfterMs });
      throw new ClaudeSessionError('network');
    }
    try {
      const reader = response.body.getReader();
      let bytes = 0;
      const chunks = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 200_000) { await reader.cancel(); throw new Error('large'); }
        chunks.push(Buffer.from(value));
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { throw new ClaudeSessionError('response'); }
  }
  return {
    async organizations(key, { signal } = {}) {
      const data = await get('/organizations', key, signal);
      if (!Array.isArray(data) || data.length > 100) throw new ClaudeSessionError('response');
      const organizations = data.filter(item => UUID.test(item?.uuid || '')).map(item => ({ id: item.uuid, name: typeof item.name === 'string' ? item.name.slice(0, 120) : item.uuid }));
      if (!organizations.length) throw new ClaudeSessionError('unsupported');
      return organizations;
    },
    async usage(key, organizationId, { signal } = {}) {
      if (!UUID.test(organizationId || '')) throw new ClaudeSessionError('organization');
      return parseClaudeApiUsage(await get(`/organizations/${organizationId}/usage`, key, signal));
    },
  };
}
