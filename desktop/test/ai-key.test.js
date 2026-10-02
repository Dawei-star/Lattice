'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { ensureAiSettingsKey } = require('../src/ai-key.js');

function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${value}`, 'utf8'),
    decryptString: (value) => value.toString('utf8').replace(/^encrypted:/, ''),
  };
}

test('AI settings key is generated once and restored through safeStorage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-ai-key-'));
  const keyPath = path.join(root, 'ai-settings.key');
  const safeStorage = fakeSafeStorage();
  try {
    const created = ensureAiSettingsKey({ keyPath, safeStorage });
    const loaded = ensureAiSettingsKey({ keyPath, safeStorage });
    assert.match(created, /^[0-9a-f]{64}$/);
    assert.equal(loaded, created);
    assert.notEqual(fs.readFileSync(keyPath, 'utf8').trim(), created);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AI settings key falls back cleanly when safeStorage is unavailable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lattice-ai-key-'));
  try {
    assert.equal(ensureAiSettingsKey({ keyPath: path.join(root, 'ai-settings.key'), safeStorage: null }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
