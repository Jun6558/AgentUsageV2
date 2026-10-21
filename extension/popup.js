const status = document.querySelector('#status');
async function act(message) {
  status.textContent = '연결 중…';
  try {
    const result = await chrome.runtime.sendMessage(message);
    status.textContent = result?.ok ? (message.type === 'pair' ? '연결되었습니다. 사용량 페이지를 열고 동기화하세요.' : '사용량을 전달했습니다.') : result?.error || '연결 실패';
    if (result?.ok && message.type === 'pair') document.querySelector('#key').value = '';
  } catch { status.textContent = '앱을 실행하고 다시 시도하세요.'; }
}
document.querySelector('#pair-form').addEventListener('submit', event => {
  event.preventDefault(); act({ type: 'pair', key: document.querySelector('#key').value.trim() });
});
document.querySelector('#sync').addEventListener('click', () => act({ type: 'sync' }));
chrome.storage.local.get(['lastSync', 'lastError']).then(({ lastSync, lastError }) => {
  if (lastError) status.textContent = lastError;
  else if (lastSync) status.textContent = `마지막 전달: ${new Date(lastSync).toLocaleString('ko-KR')}`;
});
