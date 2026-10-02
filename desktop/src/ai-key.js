'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const KEY_BYTES = 32;

/**
 * Keep the database encryption key behind Electron safeStorage (DPAPI on Windows).
 * Returning null lets standalone Node deployments continue using their explicit env key.
 */
function ensureAiSettingsKey({ keyPath, safeStorage, fsModule = fs }) {
  if (!safeStorage?.isEncryptionAvailable?.()) return null;

  if (fsModule.existsSync(keyPath)) {
    const encoded = fsModule.readFileSync(keyPath, 'utf8').trim();
    const key = safeStorage.decryptString(Buffer.from(encoded, 'base64'));
    if (!/^[0-9a-f]{64}$/i.test(key)) throw new Error('AI settings key file is invalid');
    return key;
  }

  const key = crypto.randomBytes(KEY_BYTES).toString('hex');
  const encoded = safeStorage.encryptString(key).toString('base64');
  fsModule.mkdirSync(path.dirname(keyPath), { recursive: true });
  fsModule.writeFileSync(keyPath, `${encoded}\n`, { encoding: 'utf8', mode: 0o600 });
  return key;
}

module.exports = { ensureAiSettingsKey };
