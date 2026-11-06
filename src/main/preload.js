'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('r1', {
  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  listRegions: () => ipcRenderer.invoke('accounts:regions'),
  addAccount: (account) => ipcRenderer.invoke('accounts:add', account),
  removeAccount: (id) => ipcRenderer.invoke('accounts:remove', id),
  refresh: () => ipcRenderer.invoke('data:refresh'),
  demo: () => ipcRenderer.invoke('data:demo'),
  exportCsv: (language) => ipcRenderer.invoke('export:csv', { language }),
  exportDiagnostic: (demo) => ipcRenderer.invoke('diagnostic:export', { demo }),
  checkForUpdate: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
});
