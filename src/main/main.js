'use strict';

const { app, BrowserWindow } = require('electron');
const { register } = require('./ipc');
const { createWindow } = require('./window');
const { migrateUserData } = require('./migrateUserData');

migrateUserData(app.getPath('appData'), app.getName());

app.whenReady().then(() => {
  register();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
