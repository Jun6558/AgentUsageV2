export const PORT = 43127;
export const STALE_AFTER_MS = 15 * 60 * 1000;

export function initialUsage() {
  return {
    chatgpt: { status: 'unsupported', windows: [], updatedAt: null },
    gemini: { status: 'unsupported', windows: [], updatedAt: null },
    claude: { status: 'waiting', windows: [], updatedAt: null },
  };
}

// Only normalized quota metrics cross the browser/desktop boundary.
export function validateSnapshot(input, now = Date.now()) {
  if (!input || input.provider !== 'claude' || !Array.isArray(input.windows) || input.windows.length < 1 || input.windows.length > 8) {
    throw new Error('Invalid provider or usage windows');
  }
  const seen = new Set();
  const windows = input.windows.map(item => {
    if (!item || !['session', 'weekly', 'weekly-sonnet', 'weekly-opus'].includes(item.id) || seen.has(item.id)) throw new Error('Invalid window');
    seen.add(item.id);
    if (typeof item.usedPercent !== 'number' || !Number.isFinite(item.usedPercent) || item.usedPercent < 0 || item.usedPercent > 100) throw new Error('Invalid percentage');
    if (item.resetText !== undefined && (typeof item.resetText !== 'string' || item.resetText.length > 160)) throw new Error('Invalid reset text');
    return { id: item.id, usedPercent: item.usedPercent, resetText: item.resetText || '' };
  });
  return { provider: 'claude', status: 'connected', windows, updatedAt: new Date(now).toISOString() };
}

export function remainingPercent(used) {
  return Math.max(0, Math.min(100, 100 - used));
}
