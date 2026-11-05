'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, dialog, ipcMain, net, safeStorage, BrowserWindow } = require('electron');
const { AccountStore } = require('./accountStore');
const { REGIONS, R1Client, collectAccount } = require('../core/r1Client');
const { UserError } = require('../core/errors');
const { createDemoFetch, DEMO_ACCOUNT } = require('../core/demoServer');
const { customersToCsv } = require('../core/csv');
const { createRecorder, buildDiagnostic } = require('../core/diagnostic');
const { buildTasks } = require('../core/tasks');
const { normalizeLanguage } = require('../shared/i18n');

const TENANT_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

function validateAccount(input) {
  const account = {
    label: String(input?.label || '').trim(),
    region: String(input?.region || ''),
    tenantId: String(input?.tenantId || '').trim(),
    clientId: String(input?.clientId || '').trim(),
    clientSecret: String(input?.clientSecret || '').trim(),
  };
  if (!account.label) throw new UserError('error.noLabel');
  if (!REGIONS[account.region]) throw new UserError('error.noRegion');
  if (!TENANT_ID_PATTERN.test(account.tenantId)) throw new UserError('error.tenantFormat');
  if (!account.clientId || !account.clientSecret) throw new UserError('error.credentialsRequired');
  return account;
}

// Une erreur Electron IPC perd ses propriétés : on renvoie les erreurs prévues comme des valeurs.
function handle(channel, handler) {
  ipcMain.handle(channel, async (...args) => {
    try {
      return { ok: true, value: await handler(...args) };
    } catch (error) {
      if (error instanceof UserError) return { ok: false, error: error.toMessage() };
      return { ok: false, error: { key: 'error.unexpected', params: { message: error.message } } };
    }
  });
}

function register() {
  const store = new AccountStore(app.getPath('userData'), safeStorage);
  // net.fetch passe par le proxy configuré sur le poste, contrairement au fetch de Node.
  const fetchImpl = (url, init) => net.fetch(url, init);
  let lastCustomers = [];

  const toPayload = (results, demo) => {
    lastCustomers = results.flatMap((result) => result.customers);
    return { demo, fetchedAt: Date.now(), results, tasks: buildTasks(results) };
  };

  const saveFile = async (event, defaultPath, extension, content) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const { canceled, filePath } = await dialog.showSaveDialog(window, {
      defaultPath,
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  };
  const dated = (prefix, extension) =>
    path.join(app.getPath('documents'), `${prefix}-${new Date().toISOString().slice(0, 10)}.${extension}`);

  handle('accounts:list', () => store.listPublic());
  handle('accounts:regions', () => Object.keys(REGIONS));

  handle('accounts:add', async (_event, input) => {
    const account = validateAccount(input);
    // On teste l'accès avant d'enregistrer, pour ne pas garder un compte inutilisable.
    await new R1Client(account, { fetchImpl }).authenticate();
    await store.add(account);
    return store.listPublic();
  });

  handle('accounts:remove', (_event, id) => {
    store.remove(String(id));
    return store.listPublic();
  });

  handle('data:refresh', async () => {
    const accounts = await store.listWithSecrets();
    const results = await Promise.all(accounts.map((account) => collectAccount(account, { fetchImpl })));
    return toPayload(results, false);
  });

  handle('data:demo', async () => {
    const result = await collectAccount(DEMO_ACCOUNT, { fetchImpl: createDemoFetch() });
    return toPayload([result], true);
  });

  handle('diagnostic:export', async (event, { demo }) => {
    const accounts = demo ? [DEMO_ACCOUNT] : await store.listWithSecrets();
    const baseFetch = demo ? createDemoFetch() : fetchImpl;
    const runs = await Promise.all(accounts.map(async (account) => {
      const recorder = createRecorder(baseFetch);
      const result = await collectAccount(account, { fetchImpl: recorder.fetchImpl });
      return { result, exchanges: recorder.exchanges };
    }));
    const diagnostic = buildDiagnostic(runs, { appVersion: app.getVersion() });
    return saveFile(event, dated('diagnostic-licenses', 'json'), 'json', JSON.stringify(diagnostic, null, 2));
  });

  handle('export:csv', (event, { language }) =>
    saveFile(event, dated('ruckus-licenses', 'csv'), 'csv', customersToCsv(lastCustomers, normalizeLanguage(language))));
}

module.exports = { register };
