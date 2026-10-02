'use strict';

const fs = require('node:fs');
const path = require('node:path');

function configPath(userDataDir) {
  return path.join(userDataDir, 'vault.json');
}

function readVaultDir(userDataDir) {
  try {
    const value = JSON.parse(fs.readFileSync(configPath(userDataDir), 'utf8'));
    return typeof value.vaultDir === 'string' && value.vaultDir ? path.resolve(value.vaultDir) : null;
  } catch {
    return null;
  }
}

function writeVaultDir(userDataDir, vaultDir) {
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.writeFileSync(configPath(userDataDir), `${JSON.stringify({ vaultDir }, null, 2)}\n`, 'utf8');
}

module.exports = { readVaultDir, writeVaultDir };
