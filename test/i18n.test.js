'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const i18n = require('../src/shared/i18n');
const { customersToCsv } = require('../src/core/csv');

const placeholders = (message) => {
  const text = typeof message === 'object' ? Object.values(message).join(' ') : message;
  return [...new Set(text.match(/\{\w+\}/g) || [])].sort();
};

test('les 10 langues sont présentes, l\'anglais en premier et par défaut', () => {
  assert.deepEqual(i18n.LANGUAGES.map((l) => l.id), ['en', 'de', 'es', 'fr', 'it', 'nl', 'pl', 'pt', 'ja', 'zh']);
  assert.equal(i18n.DEFAULT_LANGUAGE, 'en');
  const app = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');
  assert.ok(app.includes('setLanguage(storedLanguage() || i18n.DEFAULT_LANGUAGE)'));
  assert.ok(!app.includes('navigator.language'));
});

test('pluriel polonais : 1, 2 à 4, puis 5 et plus', () => {
  assert.equal(i18n.t('pl', 'inventory.licenseCount', { count: 1 }), '1 licencja');
  assert.equal(i18n.t('pl', 'inventory.licenseCount', { count: 3 }), '3 licencje');
  assert.equal(i18n.t('pl', 'inventory.licenseCount', { count: 5 }), '5 licencji');
  assert.equal(i18n.t('pl', 'inventory.licenseCount', { count: 22 }), '22 licencje');
});

test('japonais et chinois : une seule forme, sans pluriel', () => {
  assert.equal(i18n.t('ja', 'inventory.licenseCount', { count: 1 }), '1 ライセンス');
  assert.equal(i18n.t('zh', 'inventory.licenseCount', { count: 5 }), '5 个许可证');
});

test('français : zéro reste au singulier', () => {
  assert.equal(i18n.t('fr', 'inventory.licenseCount', { count: 0 }), '0 licence');
});

for (const { id } of i18n.LANGUAGES) {
  test(`${id} : mêmes clés et mêmes paramètres que le français`, () => {
    const reference = i18n.MESSAGES.fr;
    const messages = i18n.MESSAGES[id];
    assert.deepEqual(Object.keys(messages).sort(), Object.keys(reference).sort());
    for (const key of Object.keys(reference)) {
      assert.deepEqual(placeholders(messages[key]), placeholders(reference[key]), key);
    }
  });
}

test('toutes les clés utilisées par l\'interface et le cœur existent', () => {
  const root = path.join(__dirname, '..', 'src');
  const files = ['renderer/index.html', 'renderer/app.js', 'core/licenses.js', 'core/r1Client.js', 'core/csv.js',
    'core/tasks.js', 'main/ipc.js', 'main/accountStore.js'];
  const pattern = /['"`=]((?:about|nav|home|item|settings|forecast|action|demo|welcome|filter|customers|table|status|tile|days|capacity|tag|inventory|line|detail|customer|reco|accounts|region|diagnostic|source|error|csv)\.[A-Za-z0-9.]+)['"`]/g;
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const [, key] of text.matchAll(pattern)) {
      if (key.endsWith('.json')) continue; // Nom de fichier, pas une clé de traduction.
      assert.ok(key in i18n.MESSAGES.fr, `${file} : ${key}`);
    }
  }
});

test('mention non officielle : présente dans chaque langue, dans l\'interface et les documents', () => {
  for (const { id } of i18n.LANGUAGES) {
    for (const key of ['about.short', 'about.full']) {
      assert.match(i18n.MESSAGES[id][key], /RUCKUS Networks/, `${id} ${key}`);
    }
  }
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'src', 'renderer', 'index.html'), 'utf8');
  assert.equal(html.match(/data-i18n="about\.full"/g).length, 2);
  assert.ok(html.includes('data-i18n="about.short"'));
  for (const file of ['README.md', 'TESTING.md']) {
    assert.match(fs.readFileSync(path.join(root, file), 'utf8'), /not an official RUCKUS application/);
  }
  assert.match(fs.readFileSync(path.join(root, 'TESTING.md'), 'utf8'), /pas une application officielle RUCKUS/);
});

test('normalizeLanguage : reconnaît une langue gérée, sinon l\'anglais', () => {
  assert.equal(i18n.normalizeLanguage('de-CH'), 'de');
  assert.equal(i18n.normalizeLanguage('FR'), 'fr');
  assert.equal(i18n.normalizeLanguage('ko-KR'), 'en');
  assert.equal(i18n.normalizeLanguage(null), 'en');
});

test('pluriel, type de licence et date suivent la langue', () => {
  const at = Date.UTC(2027, 0, 31);
  const message = (count) => ({ key: 'reco.renewBefore', params: { count, type: 'APSW', date: at } });
  assert.equal(i18n.translate('fr', message(1)), 'Renouveler 1 licence RUCKUS One avant le 31/01/2027.');
  assert.equal(i18n.translate('fr', message(3)), 'Renouveler 3 licences RUCKUS One avant le 31/01/2027.');
  assert.equal(i18n.translate('en', message(3)), 'Renew 3 RUCKUS One licenses before 31/01/2027.');
  assert.equal(i18n.translate('es', message(3)), 'Renovar 3 licencias RUCKUS One antes del 31/1/2027.');
  assert.equal(i18n.translate('it', message(3)), 'Rinnovare 3 licenze RUCKUS One entro il 31/01/2027.');
  assert.equal(i18n.translate('de', message(3)), '3 RUCKUS One-Lizenzen vor dem 31.1.2027 verlängern.');
});

test('une erreur API compose la source et le code, dans chaque langue', () => {
  const error = { key: 'error.api.403', params: { whatKey: 'source.msp', status: 403 } };
  assert.ok(i18n.translate('fr', error).startsWith('Liste des clients MSP :'));
  assert.ok(i18n.translate('de', error).startsWith('MSP-Kundenliste:'));
  for (const { id } of i18n.LANGUAGES) assert.ok(!i18n.translate(id, error).includes('{'), id);
});

test('un type de licence inconnu reste affiché tel quel', () => {
  assert.equal(i18n.typeLabel('fr', 'NOKIA_OLTS'), 'NOKIA_OLTS');
});

test('le CSV est traduit dans la langue demandée', () => {
  const customer = {
    name: '', kind: 'MSP', accountLabel: 'A', status: 'expiring', nextExpiry: null, lastExpiredAt: null,
    daysLeft: null, totalUsed: 1, totalActive: 2, capacity: { state: 'short', count: 2 },
    recommendations: [{ key: 'reco.serviceBefore', params: { date: Date.UTC(2027, 0, 2) } }],
  };
  const german = customersToCsv([customer], 'de');
  assert.ok(german.startsWith('﻿Kunde;Typ;Konto;Status'));
  assert.ok(german.includes('(ohne Namen);MSP;A;Läuft ab ≤ 6 Monate'));
  assert.ok(german.includes('Fehlen;2;Tenant vor dem 2.1.2027 verlängern.'));
  assert.ok(customersToCsv([customer], 'en').startsWith('﻿Customer;Type;Account;Status'));
});
