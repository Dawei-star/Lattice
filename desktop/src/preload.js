'use strict';

const { contextBridge, ipcRenderer } = require('electron');

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
});
