'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('latticeDesktop', {
  selectVault: () => ipcRenderer.invoke('vault:select'),
  getVaultInfo: () => ipcRenderer.invoke('vault:info'),
  revealVault: () => ipcRenderer.invoke('vault:reveal'),
  revealVaultPath: (relativePath) => ipcRenderer.invoke('vault:reveal-path', relativePath),
});
