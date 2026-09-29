'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const externalFileListeners = new Set();
const queuedExternalFiles = [];

ipcRenderer.on('lattice:open-external-file', (_event, token) => {
  if (externalFileListeners.size === 0) {
    queuedExternalFiles.push(token);
    return;
  }
  for (const listener of externalFileListeners) listener(token);
});

contextBridge.exposeInMainWorld('latticeDesktop', {
  selectVault: () => ipcRenderer.invoke('vault:select'),
  getVaultInfo: () => ipcRenderer.invoke('vault:info'),
  revealVault: () => ipcRenderer.invoke('vault:reveal'),
  revealVaultPath: (relativePath) => ipcRenderer.invoke('vault:reveal-path', relativePath),
  openVaultFile: (relativePath) => ipcRenderer.invoke('vault:open-file', relativePath),
  readVaultFile: (relativePath) => ipcRenderer.invoke('vault:read-file', relativePath),
  writeVaultFile: (relativePath, content) => ipcRenderer.invoke('vault:write-file', relativePath, content),
  readMarkdownFile: (relativePath) => ipcRenderer.invoke('vault:read-markdown', relativePath),
  writeMarkdownFile: (relativePath, content) => ipcRenderer.invoke('vault:write-markdown', relativePath, content),
  moveMarkdownFile: (fromPath, toPath, content) => ipcRenderer.invoke('vault:move-markdown', fromPath, toPath, content),
  removeMarkdownFile: (relativePath) => ipcRenderer.invoke('vault:remove-markdown', relativePath),
  readExternalMarkdownFile: (token) => ipcRenderer.invoke('external:read', token),
  requestExternalWrite: (token) => ipcRenderer.invoke('external:grant-write', token),
  writeExternalMarkdownFile: (token, content) => ipcRenderer.invoke('external:write', token, content),
  onOpenExternalFile: (callback) => {
    if (typeof callback !== 'function') return () => {};
    externalFileListeners.add(callback);
    while (queuedExternalFiles.length > 0) callback(queuedExternalFiles.shift());
    return () => externalFileListeners.delete(callback);
  },
});
