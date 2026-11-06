'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkForUpdate, compareVersions, findUpdate, parseVersion } = require('../src/core/updates');

const BASE = 'https://github.com/fmuffat/ruckus-one-licenses-dashboard/releases';
const WINDOWS = { platform: 'win32', arch: 'x64', portable: false };

const release = (version, extra = {}) => ({
  tag_name: `v${version}`,
  draft: false,
  prerelease: true,
  html_url: `${BASE}/tag/v${version}`,
  assets: [
    `RUCKUS-One-Licenses-Dashboard-${version}-arm64.dmg`,
    `RUCKUS-One-Licenses-Dashboard-${version}-x64.dmg`,
    `RUCKUS-One-Licenses-Dashboard-${version}-portable.exe`,
    `RUCKUS-One-Licenses-Dashboard-Setup-${version}.exe`,
  ].map((name) => ({ name, browser_download_url: `${BASE}/download/v${version}/${name}` })),
  ...extra,
});

const compare = (a, b) => compareVersions(parseVersion(a), parseVersion(b));

test('les versions se comparent en nombres, et une pré-version précède la version finale', () => {
  assert.ok(compare('0.10.0', '0.9.0') > 0);
  assert.ok(compare('v1.0.0', '1.0.0') === 0);
  assert.ok(compare('1.0.0-beta', '1.0.0') < 0);
  assert.ok(compare('1.0.0-beta.10', '1.0.0-beta.2') > 0);
  assert.equal(parseVersion('pas-une-version'), null);
});

test('propose la version la plus récente, même dans le désordre', () => {
  const update = findUpdate([release('0.1.1'), release('0.2.0'), release('0.1.0')], '0.1.0', WINDOWS);
  assert.equal(update.version, '0.2.0');
});

test('rien à proposer : même version, version plus ancienne, ou aucune version', () => {
  assert.equal(findUpdate([release('0.1.0')], '0.1.0', WINDOWS), null);
  assert.equal(findUpdate([release('0.0.9')], '0.1.0', WINDOWS), null);
  assert.equal(findUpdate([], '0.1.0', WINDOWS), null);
  assert.equal(findUpdate({ message: 'API rate limit exceeded' }, '0.1.0', WINDOWS), null);
});

test('ignore les brouillons et les tags qui ne sont pas des versions', () => {
  const releases = [release('9.0.0', { draft: true }), { ...release('1.0.0'), tag_name: 'nightly' }];
  assert.equal(findUpdate(releases, '0.1.0', WINDOWS), null);
});

test('choisit le fichier qui correspond au poste', () => {
  const file = (target) => findUpdate([release('0.2.0')], '0.1.0', target).url.split('/').pop();
  assert.equal(file(WINDOWS), 'RUCKUS-One-Licenses-Dashboard-Setup-0.2.0.exe');
  assert.equal(file({ platform: 'win32', arch: 'x64', portable: true }), 'RUCKUS-One-Licenses-Dashboard-0.2.0-portable.exe');
  assert.equal(file({ platform: 'darwin', arch: 'arm64' }), 'RUCKUS-One-Licenses-Dashboard-0.2.0-arm64.dmg');
  assert.equal(file({ platform: 'darwin', arch: 'x64' }), 'RUCKUS-One-Licenses-Dashboard-0.2.0-x64.dmg');
});

test('sans fichier adapté : renvoie vers la page de la version', () => {
  const url = (target, extra) => findUpdate([release('0.2.0', extra)], '0.1.0', target).url;
  assert.equal(url({ platform: 'linux', arch: 'x64' }), `${BASE}/tag/v0.2.0`);
  assert.equal(url(WINDOWS, { assets: [] }), `${BASE}/tag/v0.2.0`);
});

test('n\'ouvre jamais une adresse hors des versions de ce dépôt', () => {
  const asset = { name: 'RUCKUS-One-Licenses-Dashboard-Setup-0.2.0.exe', browser_download_url: 'https://example.com/piege.exe' };
  assert.equal(findUpdate([release('0.2.0', { assets: [asset] })], '0.1.0', WINDOWS), null);
  const other = 'https://github.com/quelquun/autre/releases/tag/v0.2.0';
  assert.equal(findUpdate([release('0.2.0', { assets: [], html_url: other })], '0.1.0', WINDOWS), null);
});

test('la vérification interroge GitHub sans rien transmettre du compte', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    return { ok: true, json: async () => [release('0.2.0')] };
  };
  const update = await checkForUpdate({ fetchImpl, currentVersion: '0.1.0', target: WINDOWS });
  assert.equal(update.version, '0.2.0');
  assert.equal(seen.url, 'https://api.github.com/repos/fmuffat/ruckus-one-licenses-dashboard/releases?per_page=20');
  assert.deepEqual(Object.keys(seen.init.headers).sort(), ['Accept', 'User-Agent']);
  assert.equal(seen.init.headers['User-Agent'], 'RUCKUS-One-Licenses-Dashboard/0.1.0');
});

test('une panne de la vérification reste silencieuse', async () => {
  const check = (fetchImpl) => checkForUpdate({ fetchImpl, currentVersion: '0.1.0', target: WINDOWS });
  assert.equal(await check(async () => { throw new Error('hors ligne'); }), null);
  assert.equal(await check(async () => ({ ok: false, status: 403 })), null);
  assert.equal(await check(async () => ({ ok: true, json: async () => { throw new Error('JSON invalide'); } })), null);
});
