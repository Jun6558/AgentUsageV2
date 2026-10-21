import { app, BrowserWindow, Tray, Menu, screen, ipcMain, shell, clipboard, nativeImage, safeStorage } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { initialUsage } from './model.js';
import { startBridge } from './bridge.js';
import { createClaudeSessionClient } from './claude-session.js';
import { createSessionStore } from './session-store.js';
import { createSessionController } from './session-controller.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const urls = { chatgpt: 'https://chatgpt.com/', gemini: 'https://gemini.google.com/', claude: 'https://claude.ai/settings/usage' };
let win, tray, server, token, statePath, sessionController;
let quitting = false;
let expanded = false;
let state = { usage: initialUsage(), bridge: 'starting', expanded: false, autostart: false, canAutostart: process.platform === 'win32' && app.isPackaged, platform: process.platform };

function publish() {
  win?.webContents.send('state', state);
  const claude = state.usage.claude;
  const current = claude.windows.find(w => w.id === 'session');
  tray?.setToolTip(`AgentUsageV2${current ? ` · Claude ${100 - current.usedPercent}% 남음` : ' · 구독 사용량'}`);
}
function saveUsage() {
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state.usage), { mode: 0o600 });
  fs.renameSync(tmp, statePath);
}
function updateClaudeUsage(snapshot) {
  const previous = state.usage.claude;
  if (snapshot) {
    const { provider, ...usage } = snapshot;
    state.usage.claude = usage;
  } else state.usage.claude = initialUsage().claude;
  try { saveUsage(); } catch (error) { state.usage.claude = previous; throw error; }
  publish();
}
function sizeWindow(value) {
  expanded = value;
  state.expanded = value;
  const old = win.getBounds();
  const area = screen.getDisplayMatching(old).workArea;
  const width = Math.min(value ? 420 : 308, area.width);
  const height = Math.min(value ? 680 : 166, area.height);
  win.setBounds({
    x: Math.max(area.x, Math.min(old.x + old.width - width, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(old.y + old.height - height, area.y + area.height - height)),
    width, height,
  });
  publish();
}
function show() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', show);
  app.whenReady().then(async () => {
    app.setAppUserModelId('com.jun6558.agentusagev2');
    const dataDir = app.getPath('userData');
    fs.mkdirSync(dataDir, { recursive: true });
    statePath = path.join(dataDir, 'usage.json');
    try {
      const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      // Revalidate saved metrics without refreshing their collection timestamp.
      const { validateSnapshot } = await import('./model.js');
      if (saved.claude?.status === 'connected' && Number.isFinite(Date.parse(saved.claude.updatedAt))) {
        state.usage.claude = { ...validateSnapshot({ provider: 'claude', windows: saved.claude.windows }), updatedAt: saved.claude.updatedAt };
      }
    } catch { /* No valid saved data yet. */ }
    const keyPath = path.join(dataDir, 'pairing-key');
    try { token = fs.readFileSync(keyPath, 'utf8').trim(); } catch { /* Create below. */ }
    if (!/^[a-f0-9]{64}$/.test(token || '')) { token = randomBytes(32).toString('hex'); fs.writeFileSync(keyPath, token, { mode: 0o600 }); }
    sessionController = createSessionController({
      store: createSessionStore({ filePath: path.join(dataDir, 'claude-session.enc'), encryption: safeStorage, supported: process.platform === 'win32' }),
      client: createClaudeSessionClient(),
      onState: session => { state.session = session; publish(); },
      onUsage: updateClaudeUsage,
    });
    state.session = sessionController.getState();
    if (state.canAutostart) state.autostart = app.getLoginItemSettings().openAtLogin;
    const area = screen.getPrimaryDisplay().workArea;
    win = new BrowserWindow({
      width: 308, height: 166, x: area.x + area.width - 320, y: area.y + area.height - 178,
      frame: false, resizable: false, maximizable: false, fullscreenable: false,
      alwaysOnTop: true, skipTaskbar: false, show: false, backgroundColor: '#111318',
      title: 'AgentUsageV2',
      icon: path.join(root, process.platform === 'win32' ? 'assets/icon.ico' : 'assets/icon.png'),
      webPreferences: { preload: path.join(root, 'electron/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    if (process.platform === 'win32' && app.isPackaged) {
      // A pinned shortcut must reopen the installed app, including after its
      // window is hidden to the tray. Keep its identity aligned with NSIS.
      win.setAppDetails({
        appId: 'com.jun6558.agentusagev2',
        relaunchCommand: `"${process.execPath}"`,
        relaunchDisplayName: 'AgentUsageV2',
        appIconPath: process.execPath,
      });
    }
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.on('close', event => { if (!quitting) { event.preventDefault(); win.hide(); } });
    win.once('ready-to-show', show);
    tray = new Tray(nativeImage.createFromPath(path.join(root, 'assets/tray.png')));
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '위젯 표시', click: show },
      { label: '주간 사용량', click: () => { sizeWindow(true); show(); } },
      { label: '연결 키 복사', click: () => clipboard.writeText(token) },
      { type: 'separator' },
      { label: '종료', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', () => win.isVisible() ? win.hide() : show());
    ipcMain.handle('get-state', () => state);
    ipcMain.handle('expand', (_, value) => sizeWindow(value === true));
    ipcMain.handle('hide', () => win.hide());
    ipcMain.handle('open-provider', (_, id) => { if (Object.hasOwn(urls, id)) return shell.openExternal(urls[id]); });
    ipcMain.handle('copy-pairing-key', () => clipboard.writeText(token));
    ipcMain.handle('connect-claude-session', (_, value) => sessionController.connect(value));
    ipcMain.handle('refresh-claude-session', () => sessionController.refresh());
    ipcMain.handle('select-claude-organization', (_, id) => sessionController.selectOrganization(id));
    ipcMain.handle('forget-claude-session', () => sessionController.forget());
    ipcMain.handle('set-autostart', (_, value) => {
      if (state.canAutostart) {
        app.setLoginItemSettings({ openAtLogin: value === true });
        state.autostart = app.getLoginItemSettings().openAtLogin;
        publish();
      }
      return state.autostart;
    });
    try {
      server = await startBridge({ token, onSnapshot: snapshot => {
        if (state.session.configured) throw new Error('Direct session mode is active');
        updateClaudeUsage(snapshot);
      } });
      state.bridge = 'ready';
    } catch { state.bridge = 'error'; }
    publish();
    const devUrl = process.env.AGENTUSAGE_DEV_URL;
    if (devUrl === 'http://127.0.0.1:5173') await win.loadURL(devUrl);
    else await win.loadFile(path.join(root, 'dist/index.html'));
    void sessionController.restore();
    screen.on('display-metrics-changed', () => sizeWindow(expanded));
    screen.on('display-removed', () => sizeWindow(expanded));
  });
  app.on('before-quit', () => { quitting = true; sessionController?.dispose(); server?.close(); });
  app.on('window-all-closed', () => { /* Tray keeps the app alive. */ });
}
