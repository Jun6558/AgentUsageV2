import fs from 'node:fs';
import { normalizeSessionKey, ClaudeSessionError } from './claude-session.js';

// Encryption is supplied by Electron safeStorage (Windows DPAPI). No plaintext
// fallback, renderer storage, or credentials in the public app state.
export function createSessionStore({ filePath, encryption, supported }) {
  const available = () => Boolean(supported && encryption.isEncryptionAvailable());
  return {
    available,
    load() {
      if (!fs.existsSync(filePath)) return null;
      if (!available()) throw new ClaudeSessionError('storage');
      try {
        const saved = JSON.parse(encryption.decryptString(fs.readFileSync(filePath)));
        return { key: normalizeSessionKey(saved.key), organizationId: typeof saved.organizationId === 'string' ? saved.organizationId : null };
      } catch { throw new ClaudeSessionError('storage'); }
    },
    save(key, organizationId = null) {
      if (!available()) throw new ClaudeSessionError('storage');
      try {
        const encrypted = encryption.encryptString(JSON.stringify({ key: normalizeSessionKey(key), organizationId }));
        fs.writeFileSync(`${filePath}.tmp`, encrypted, { mode: 0o600 });
        fs.renameSync(`${filePath}.tmp`, filePath);
      } catch { throw new ClaudeSessionError('storage'); }
    },
    clear() {
      try { fs.rmSync(filePath, { force: true }); fs.rmSync(`${filePath}.tmp`, { force: true }); }
      catch { throw new ClaudeSessionError('storage'); }
    },
  };
}
