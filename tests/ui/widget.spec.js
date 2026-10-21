import { test, expect } from '@playwright/test';

async function mockDesktop(page, { old = false, partial = false } = {}) {
  await page.addInitScript(({ old, partial }) => {
    let callback;
    const state = {
      usage: {
        chatgpt: { status: 'unsupported', windows: [], updatedAt: null },
        gemini: { status: 'unsupported', windows: [], updatedAt: null },
        claude: { status: 'connected', updatedAt: new Date(Date.now() - (old ? 3600000 : 0)).toISOString(), windows: [
          ...(!partial ? [{ id: 'session', usedPercent: 28, resetText: 'Resets in 2 hr 30 min' }] : []),
          { id: 'weekly', usedPercent: 62, resetText: '<img src=x onerror=alert(1)>' },
        ] },
      }, bridge: 'ready', expanded: false, autostart: false, canAutostart: true, platform: 'win32',
      session: { configured: false, canStore: true, status: 'idle', message: '', organizations: [], nextRefreshAt: null },
    };
    window.agentUsage = {
      getState: async () => state,
      expand: async value => { state.expanded = value; callback?.(state); },
      hide: async () => { window.didHide = true; },
      openProvider: async id => { window.openedProvider = id; },
      copyPairingKey: async () => { window.didCopy = true; },
      connectClaudeSession: async value => {
        window.receivedSessionFixture = value;
        state.session = { ...state.session, configured: true, status: 'connected', message: '브라우저를 열지 않아도 5분마다 갱신합니다.' };
        callback?.(state);
        return { ok: true };
      },
      refreshClaudeSession: async () => { window.didRefresh = true; return { ok: true }; },
      forgetClaudeSession: async () => {
        state.session = { ...state.session, configured: false, status: 'idle', message: '' };
        state.usage.claude = { status: 'waiting', windows: [], updatedAt: null };
        callback?.(state);
        return { ok: true };
      },
      setAutostart: async value => value,
      onState: fn => { callback = fn; },
    };
  }, { old, partial });
}

test('three-row widget has honest unavailable states and opens weekly details', async ({ page }) => {
  await page.setViewportSize({ width: 308, height: 166 });
  await page.goto('/');
  await expect(page.locator('.compact-row')).toHaveCount(3);
  await expect(page.getByText('미지원', { exact: true })).toHaveCount(2);
  await expect(page.getByText('연결 대기', { exact: true })).toBeVisible();
  await expect(page.locator('[role=meter]')).toHaveCount(0);
  expect(await page.locator('.compact-row').last().evaluate(el => el.getBoundingClientRect().bottom)).toBeLessThan(166);
  await page.getByRole('button', { name: 'Claude 상세 사용량 보기' }).click();
  await page.setViewportSize({ width: 420, height: 680 });
  await expect(page.getByRole('heading', { name: '사용량 한눈에' })).toBeVisible();
  await page.getByRole('button', { name: '3줄 위젯으로 접기' }).click();
  await expect(page.locator('.compact-row')).toHaveCount(3);
});

test('received session and weekly quotas render with correct remaining percentages', async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
  await expect(page.getByText('72%', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Claude 상세 사용량 보기' }).click();
  const claude = page.getByRole('region', { name: 'Claude 사용량' });
  await expect(claude.getByRole('meter', { name: '현재 세션 · 5시간 잔여 한도' })).toHaveAttribute('aria-valuenow', '72');
  await expect(claude.getByRole('meter', { name: '주간 · 모든 모델 잔여 한도' })).toHaveAttribute('aria-valuenow', '38');
  await expect(claude.locator('img')).toHaveCount(0);
  await expect(claude.getByText('<img src=x onerror=alert(1)>')).toBeAttached();
  await claude.getByRole('button', { name: '사용량 페이지' }).click();
  expect(await page.evaluate(() => window.openedProvider)).toBe('claude');
});

test('stale data is clearly marked', async ({ page }) => {
  await mockDesktop(page, { old: true });
  await page.goto('/');
  await expect(page.getByText('갱신 필요')).toBeVisible();
  await page.getByRole('button', { name: 'Claude 상세 사용량 보기' }).click();
  await expect(page.getByText('오래된 정보', { exact: true })).toBeAttached();
  await expect(page.getByText('15분 이상 갱신되지 않았습니다.', { exact: false })).toBeAttached();
});

test('weekly-only data does not invent a five-hour value', async ({ page }) => {
  await mockDesktop(page, { partial: true });
  await page.goto('/');
  await expect(page.locator('.quota')).toHaveCount(0);
  await page.getByRole('button', { name: 'Claude 상세 사용량 보기' }).click();
  await expect(page.getByText('현재 세션 수치는 읽지 못했습니다.')).toBeAttached();
});

test('pairing, autostart and hide actions reach the desktop bridge', async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: '주간 사용량 · 연결' }).click();
  await page.getByRole('button', { name: '연결 설정', exact: true }).click();
  await page.getByRole('button', { name: '연결 키 복사' }).click();
  expect(await page.evaluate(() => window.didCopy)).toBe(true);
  await expect(page.locator('.toast')).toContainText('연결 키를 복사했습니다');
  await page.getByRole('checkbox', { name: 'Windows 시작 시 실행' }).check();
  await expect(page.getByRole('checkbox', { name: 'Windows 시작 시 실행' })).toBeChecked();
  await page.getByRole('button', { name: '트레이로 숨기기' }).click();
  expect(await page.evaluate(() => window.didHide)).toBe(true);
});

test('web mode does not pretend the desktop bridge is available', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '주간 사용량 · 연결' }).click();
  await page.getByRole('button', { name: '연결 설정', exact: true }).click();
  await expect(page.getByRole('button', { name: '연결 키 복사' })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: 'Windows 시작 시 실행' })).toBeDisabled();
  await expect(page.getByLabel('Claude sessionKey')).toBeDisabled();
});

test('session setup clears the secret field and supports refresh and disconnect without a browser tab', async ({ page }) => {
  await mockDesktop(page);
  await page.goto('/');
  await page.getByRole('button', { name: '주간 사용량 · 연결' }).click();
  await page.getByRole('button', { name: '연결 설정', exact: true }).click();
  const fixture = 'fixture-session-value-1234567890';
  await page.getByLabel('Claude sessionKey').fill(fixture);
  await page.getByRole('button', { name: '저장하고 자동 조회' }).click();
  expect(await page.evaluate(() => window.receivedSessionFixture)).toBe(fixture);
  await expect(page.getByLabel('Claude sessionKey')).toHaveValue('');
  expect(await page.content()).not.toContain(fixture);
  await expect(page.locator('.session-status')).toContainText('브라우저를 열지 않아도');
  await expect(page.getByRole('button', { name: '연결 키 복사' })).toBeDisabled();
  await page.getByRole('button', { name: '지금 갱신', exact: true }).click();
  expect(await page.evaluate(() => window.didRefresh)).toBe(true);
  await page.getByRole('button', { name: '저장된 세션 삭제' }).click();
  await expect(page.getByRole('button', { name: '저장하고 자동 조회' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '연결 키 복사' })).toBeEnabled();
});
