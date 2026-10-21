import './style.css';
import { version } from '../package.json';
import { initialUsage, remainingPercent, STALE_AFTER_MS } from '../electron/model.js';

const brands = {
  chatgpt: { name: 'ChatGPT', mark: 'C', color: '#10a37f', note: 'ChatGPT 구독의 5시간·주간 잔여 한도를 자동으로 읽는 방식은 아직 지원하지 않습니다. Codex/API 사용량을 대신 표시하지 않습니다.' },
  gemini: { name: 'Gemini', mark: '✦', color: '#8c9bff', note: 'Gemini는 모델·기능·요금제별 제한이 다릅니다. 일괄적인 5시간·주간 한도 자동 연동은 아직 지원하지 않습니다.' },
  claude: { name: 'Claude', mark: '✺', color: '#d97757', note: '세션 쿠키를 등록하면 브라우저 없이 5분마다 조회합니다. 또는 사용량 페이지를 읽는 확장을 연결할 수 있습니다. 비공식 연동이며 실제 계정 검증은 아직 필요합니다.' },
};
const labels = { session: '현재 세션 · 5시간', weekly: '주간 · 모든 모델', 'weekly-sonnet': '주간 · Sonnet', 'weekly-opus': '주간 · Opus' };
const desktop = Boolean(window.agentUsage);
const api = window.agentUsage || {
  getState: async () => ({ usage: initialUsage(), bridge: 'web', expanded: false, autostart: false, canAutostart: false, platform: 'web' }),
  expand: async () => {}, hide: async () => {}, openProvider: async () => {},
  copyPairingKey: async () => {}, setAutostart: async () => false, onState: () => {},
  connectClaudeSession: async () => ({ ok: false }), refreshClaudeSession: async () => ({ ok: false }),
  forgetClaudeSession: async () => ({ ok: false }), selectClaudeOrganization: async () => ({ ok: false }),
};
let state = await api.getState();
let expanded = Boolean(state.expanded);
let tab = 'overview';
let notice = '';
let sessionBusy = false;
const root = document.querySelector('#app');
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const percent = used => `${Number(remainingPercent(used).toFixed(1))}%`;
const stale = usage => usage.updatedAt && Date.now() - Date.parse(usage.updatedAt) > STALE_AFTER_MS;
const time = value => new Date(value).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
const session = () => state.session || { configured: false, canStore: false, status: 'idle', organizations: [] };
const sessionError = usage => usage === state.usage.claude && session().configured && session().status === 'error';
const badge = usage => usage.status === 'unsupported' ? '미지원' : sessionError(usage) ? '갱신 오류' : stale(usage) ? '오래된 정보' : usage.status === 'connected' ? '연결됨' : '연결 대기';
const connectionLabel = () => session().configured ? session().status === 'error' ? '세션 갱신 오류' : '세션 자동 조회' : '브라우저 연결됨';
function meter(item, brand) {
  return `<div class="meter" role="meter" aria-label="${escape(labels[item.id])} 잔여 한도" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${remainingPercent(item.usedPercent)}"><span style="width:${remainingPercent(item.usedPercent)}%;background:${brand.color}"></span></div>`;
}
function compactRow(id) {
  const brand = brands[id], usage = state.usage[id];
  const session = usage.windows.find(w => w.id === 'session');
  return `<button class="compact-row" data-expand="${id}" aria-label="${brand.name} 상세 사용량 보기" style="--brand:${brand.color}">
    <span class="brand-mark">${brand.mark}</span><span class="brand-name">${brand.name}</span>
    ${session ? `<span class="tiny-meter">${meter(session, brand)}</span><span class="quota ${stale(usage) || sessionError(usage) ? 'stale' : ''}">${percent(session.usedPercent)}</span>` : `<span class="no-data">${usage.status === 'connected' && !sessionError(usage) ? '수치 없음' : badge(usage)}</span>`}
    <span class="row-arrow">›</span></button>`;
}
function card(id) {
  const brand = brands[id], usage = state.usage[id];
  const session = usage.windows.find(w => w.id === 'session');
  const windows = [...usage.windows].sort((a, b) => (a.id === 'session' ? -1 : b.id === 'session' ? 1 : a.id.localeCompare(b.id)));
  return `<section class="usage-card" style="--brand:${brand.color}" aria-label="${brand.name} 사용량">
    <div class="card-heading"><span class="brand-mark">${brand.mark}</span><h2>${brand.name}</h2><span class="status ${usage.status === 'connected' && !stale(usage) && !sessionError(usage) ? 'live' : ''}">${badge(usage)}</span></div>
    ${windows.length ? windows.map(item => `<div class="usage-window"><div class="metric-label"><span>${labels[item.id]}</span><strong>${percent(item.usedPercent)} <small>남음</small></strong></div>${meter(item, brand)}<div class="reset">${escape(item.resetText || '초기화 시점 미제공')}</div></div>`).join('') : `<div class="empty-state"><span class="empty-value">—</span><p>${id === 'claude' ? '확장을 연결하면 여기에 표시됩니다.' : '구독 한도 자동 연동 미지원'}</p></div>`}
    ${windows.length && !session ? '<p class="missing">현재 세션 수치는 읽지 못했습니다.</p>' : ''}
    ${windows.length && !windows.some(w => w.id === 'weekly') ? '<p class="missing">주간 전체 수치는 읽지 못했습니다.</p>' : ''}
    ${stale(usage) ? '<p class="stale-note">15분 이상 갱신되지 않았습니다. 연결 설정에서 갱신 상태를 확인하세요.</p>' : ''}
    ${sessionError(usage) ? `<p class="stale-note" role="alert">${escape(session().message)} 기존 수치는 마지막 성공 시점의 정보입니다.</p>` : ''}
    <div class="card-footer"><span>${usage.updatedAt ? `마지막 수신 ${time(usage.updatedAt)}` : '데이터 없음'}</span><button class="text-button" data-provider="${id}">${id === 'claude' ? '사용량 페이지' : '서비스 열기'} ↗</button></div>
  </section>`;
}
function sessionConnection() {
  const s = session();
  const busy = sessionBusy || s.status === 'polling';
  return `<section class="connection-card session-card"><div class="eyebrow">CLAUDE · SESSION</div><h2>사이트를 열지 않고 확인</h2>
    <p>Claude의 <code>sessionKey</code>를 한 번 등록하면 앱이 5분마다 직접 조회합니다. 쿠키는 이 PC의 Windows 계정으로 암호화해 저장합니다.</p>
    <details class="cookie-help"><summary>sessionKey 찾는 방법</summary><p>Claude에 로그인 → F12 → Application(애플리케이션) → Cookies → https://claude.ai → sessionKey의 Value를 복사하세요. 쿠키가 만료되면 다시 등록해야 합니다.</p><p>로그인 권한이 있는 값입니다. 채팅이나 공유 문서에 붙여 넣지 마세요.</p></details>
    <form id="session-form"><label for="session-key">Claude sessionKey</label><input id="session-key" name="session-key" type="password" autocomplete="off" spellcheck="false" maxlength="4096" placeholder="쿠키 값만 붙여 넣기" ${!s.canStore || busy ? 'disabled' : ''} required>
    <button class="primary-button" type="submit" ${!s.canStore || busy ? 'disabled' : ''}>${busy ? '조회 중…' : s.configured ? '로그인 세션 교체' : '저장하고 자동 조회'}</button></form>
    ${s.organizations.length > 1 ? `<form id="organization-form"><label for="organization">조회할 조직</label><select id="organization" ${busy ? 'disabled' : ''}><option value="">조직을 선택하세요</option>${s.organizations.map(org => `<option value="${escape(org.id)}" ${org.id === s.organizationId ? 'selected' : ''}>${escape(org.name)}</option>`).join('')}</select><button class="secondary-button" ${busy ? 'disabled' : ''}>이 조직 사용량 조회</button></form>` : ''}
    ${s.configured ? `<div class="session-actions"><button class="secondary-button" id="refresh-session" ${busy || s.status === 'choose-organization' ? 'disabled' : ''}>지금 갱신</button><button class="secondary-button danger-button" id="forget-session" ${busy ? 'disabled' : ''}>저장된 세션 삭제</button></div>` : ''}
    <p class="session-status ${s.status === 'error' ? 'error' : ''}" role="status">${escape(s.message || (s.canStore ? '실험적 연동 · 등록 후 사용량 페이지를 닫아도 됩니다.' : 'Windows 데스크톱 앱에서 암호화 저장을 지원합니다.'))}${s.nextRefreshAt ? `<br>다음 조회 ${time(s.nextRefreshAt)}` : ''}</p>
  </section>`;
}
function connection() {
  return `${sessionConnection()}<section class="connection-card"><div class="eyebrow">BROWSER BRIDGE · 대체 방식</div><h2>내 브라우저와 연결</h2><p>확장 연동을 사용하려면 저장된 세션을 삭제한 뒤 Claude 사용량 페이지를 열어두세요. 화면에 표시된 한도만 이 기기의 앱으로 전달합니다.</p>
    <ol><li>Chrome 또는 Edge의 확장 관리 화면에서 개발자 모드를 켜고, 프로젝트의 <code>extension</code> 폴더를 로드하세요.</li><li>아래 연결 키를 복사해 확장 아이콘의 입력란에 붙여 넣으세요.</li><li>Claude 사용량 페이지를 열고 확장에서 ‘지금 동기화’를 누르세요.</li></ol>
    <button class="primary-button" id="copy-key" ${!desktop || state.bridge !== 'ready' || session().configured ? 'disabled' : ''}>연결 키 복사 <span>↗</span></button>
    <p class="bridge-status"><span class="dot ${state.bridge === 'ready' ? 'green' : ''}"></span>${state.bridge === 'ready' ? '이 기기의 앱이 연결을 기다리고 있습니다.' : state.bridge === 'web' ? '브라우저 화면 미리보기 · 데스크톱 앱에서 연결하세요.' : '연결 서버를 시작하지 못했습니다. 다른 앱의 43127 포트 사용 여부를 확인하세요.'}</p>
  </section><section class="support-card"><h2>서비스별 지원 범위</h2>${Object.entries(brands).map(([id, b]) => `<div class="support-item"><strong style="color:${b.color}">${b.name}<span>${id === 'claude' ? '실험적 세션·화면 연동' : '미지원'}</span></strong><p>${b.note}</p></div>`).join('')}</section>`;
}
function render() {
  // Keep in-progress input in its DOM control, never app state or HTML.
  const previousInput = root.querySelector('#session-key');
  const keepInput = previousInput?.value && !sessionBusy && tab === 'connection';
  const hadFocus = document.activeElement === previousInput;
  root.innerHTML = `<main class="shell ${expanded ? 'expanded' : 'compact'}">
    <header class="titlebar"><div class="wordmark"><span class="logo-bars"><i></i><i></i><i></i></span>AgentUsage<span class="version">V2</span></div><div class="window-controls">${expanded ? '<button id="collapse" title="3줄 위젯으로 접기" aria-label="3줄 위젯으로 접기">⌄</button>' : '<span class="five-hour">5H LEFT</span>'}<button id="hide" title="트레이로 숨기기" aria-label="트레이로 숨기기">−</button></div></header>
    ${expanded ? `<div class="detail-heading"><div class="eyebrow">YOUR AI, AT A GLANCE</div><h1>사용량 한눈에</h1><p>다음 대화를 위한 여유를 확인하세요.</p></div><nav class="tabs" aria-label="상세 보기"><button data-tab="overview" class="${tab === 'overview' ? 'active' : ''}" aria-current="${tab === 'overview' ? 'page' : 'false'}">사용량</button><button data-tab="connection" class="${tab === 'connection' ? 'active' : ''}" aria-current="${tab === 'connection' ? 'page' : 'false'}">연결 설정</button></nav><div class="scroll-area">${tab === 'overview' ? `<div class="unit-note">잔여 구독 한도 (%)<span>토큰 수와 다를 수 있습니다</span></div>${Object.keys(brands).map(card).join('')}` : connection()}</div><footer class="detail-footer"><label><input id="autostart" type="checkbox" ${state.autostart ? 'checked' : ''} ${!state.canAutostart ? 'disabled' : ''}> Windows 시작 시 실행</label><span>v${escape(version)}</span></footer>` : `<div class="compact-rows">${Object.keys(brands).map(compactRow).join('')}</div><div class="compact-footer"><span class="dot ${state.usage.claude.status === 'connected' && !stale(state.usage.claude) && !sessionError(state.usage.claude) ? 'green' : ''}"></span><span>${stale(state.usage.claude) ? '갱신 필요' : state.usage.claude.status === 'connected' ? connectionLabel() : session().configured ? '세션 연결 확인' : '구독 한도'}</span><button id="details">주간 사용량 · 연결 <span>↗</span></button></div>`}
    <div class="toast ${notice ? 'visible' : ''}" role="status">${escape(notice)}</div>
  </main>`;
  const newInput = root.querySelector('#session-key');
  if (keepInput && newInput) {
    previousInput.disabled = newInput.disabled;
    newInput.replaceWith(previousInput);
    if (hadFocus && !previousInput.disabled) previousInput.focus();
  }
  root.querySelector('#hide').addEventListener('click', () => api.hide());
  root.querySelector('#collapse')?.addEventListener('click', () => setExpanded(false));
  root.querySelector('#details')?.addEventListener('click', () => setExpanded(true));
  root.querySelectorAll('[data-expand]').forEach(el => el.addEventListener('click', () => { tab = 'overview'; setExpanded(true); }));
  root.querySelectorAll('[data-tab]').forEach(el => el.addEventListener('click', () => { tab = el.dataset.tab; render(); }));
  root.querySelectorAll('[data-provider]').forEach(el => el.addEventListener('click', () => {
    if (desktop) api.openProvider(el.dataset.provider);
    else showNotice('데스크톱 앱에서 서비스를 열 수 있습니다.');
  }));
  root.querySelector('#copy-key')?.addEventListener('click', async () => {
    try { await api.copyPairingKey(); showNotice('연결 키를 복사했습니다. 확장에 붙여 넣으세요.'); }
    catch { showNotice('연결 키를 복사하지 못했습니다.'); }
  });
  root.querySelector('#session-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const input = root.querySelector('#session-key');
    const value = input.value;
    input.value = '';
    await sessionAction(() => api.connectClaudeSession(value));
  });
  root.querySelector('#refresh-session')?.addEventListener('click', () => sessionAction(() => api.refreshClaudeSession()));
  root.querySelector('#forget-session')?.addEventListener('click', () => sessionAction(() => api.forgetClaudeSession()));
  root.querySelector('#organization-form')?.addEventListener('submit', event => {
    event.preventDefault();
    const id = root.querySelector('#organization').value;
    if (id) void sessionAction(() => api.selectClaudeOrganization(id));
  });
  root.querySelector('#autostart')?.addEventListener('change', async event => {
    try { state.autostart = await api.setAutostart(event.target.checked); render(); }
    catch { showNotice('시작 설정을 변경하지 못했습니다.'); }
  });
}
async function sessionAction(action) {
  sessionBusy = true;
  render();
  try {
    const result = await action();
    if (!result?.ok) showNotice(result?.message || '연결 상태를 확인하세요.');
  } catch { showNotice('로그인 세션 작업을 완료하지 못했습니다.'); }
  finally { sessionBusy = false; render(); }
}
async function setExpanded(value) { expanded = value; await api.expand(value); render(); }
let noticeTimer;
function showNotice(message) { notice = message; render(); clearTimeout(noticeTimer); noticeTimer = setTimeout(() => { notice = ''; render(); }, 4000); }
api.onState(value => { state = value; expanded = Boolean(value.expanded); render(); });
render();
setInterval(render, 60_000);
