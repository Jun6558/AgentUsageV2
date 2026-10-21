// Conservative parsing of visible text. Unknown layouts are never reported as 0%.
// Shared with Node tests; no cookies, request interception, or private endpoints.
(() => {
  function parseUsage(text) {
    if (typeof text !== 'string') return null;
    const lines = text.split(/\n/).map(line => line.trim()).filter(Boolean);
    const windows = [];
    let current = null;
    const flush = () => {
      if (current && current.usedPercent !== null && !windows.some(w => w.id === current.id)) {
        windows.push({ id: current.id, usedPercent: current.usedPercent, resetText: current.resetText });
      }
      current = null;
    };
    for (const line of lines) {
      if (/extra usage|추가 사용량|monthly spending|월간 지출/i.test(line)) { flush(); continue; }
      let id = null;
      if (/^(current session|현재 세션|현재 세션 사용량)$/i.test(line)) id = 'session';
      else if (/^(all models|모든 모델)$/i.test(line)) id = 'weekly';
      else if (/^(sonnet only|sonnet만|sonnet 전용)$/i.test(line)) id = 'weekly-sonnet';
      else if (/^(opus only|opus만|opus 전용)$/i.test(line)) id = 'weekly-opus';
      if (id) { flush(); current = { id, usedPercent: null, resetText: '' }; continue; }
      if (!current) continue;
      const used = line.match(/^(\d{1,3}(?:\.\d+)?)\s*%\s*(?:used|사용(?:됨|함|량)?)$/i);
      const remaining = line.match(/^(\d{1,3}(?:\.\d+)?)\s*%\s*(?:remaining|남음|남았음)$/i);
      if (used || remaining) {
        const value = Number((used || remaining)[1]);
        if (value >= 0 && value <= 100) current.usedPercent = remaining ? 100 - value : value;
      }
      if (/^(resets?\b|초기화|재설정)|후\s*(초기화|재설정)/i.test(line)) current.resetText = line.slice(0, 160);
    }
    flush();
    return windows.length ? { provider: 'claude', windows } : null;
  }
  globalThis.AgentUsageParser = { parseUsage };
})();
