const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('agentUsage', {
  getState: () => ipcRenderer.invoke('get-state'),
  expand: value => ipcRenderer.invoke('expand', Boolean(value)),
  hide: () => ipcRenderer.invoke('hide'),
  openProvider: id => ipcRenderer.invoke('open-provider', id),
  copyPairingKey: () => ipcRenderer.invoke('copy-pairing-key'),
  connectClaudeSession: value => ipcRenderer.invoke('connect-claude-session', value),
  refreshClaudeSession: () => ipcRenderer.invoke('refresh-claude-session'),
  selectClaudeOrganization: id => ipcRenderer.invoke('select-claude-organization', id),
  forgetClaudeSession: () => ipcRenderer.invoke('forget-claude-session'),
  setAutostart: value => ipcRenderer.invoke('set-autostart', Boolean(value)),
  onState: callback => {
    const listener = (_, state) => callback(state);
    ipcRenderer.on('state', listener);
    return () => ipcRenderer.removeListener('state', listener);
  },
});
