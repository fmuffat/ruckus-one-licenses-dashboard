'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { evaluateCustomer } = require('../src/core/licenses');
const { buildTasks } = require('../src/core/tasks');

const NOW = Date.UTC(2026, 10, 5, 12);
const DAY = 86400000;
const iso = (days) => new Date(NOW + days * DAY).toISOString();
const line = (quantity, consumed, days) => ({
  entitlementDeviceType: 'DVCNWTYPE_APSW', quantity: String(quantity), consumed: String(consumed), expirationDate: iso(days),
});
const customer = (name, fields) => ({
  ...evaluateCustomer({ id: name, name, kind: 'MSP', ...fields }, NOW),
  accountId: 'a',
  accountLabel: 'Compte',
});
const tasksOf = (customers, rows = []) => buildTasks([{ label: 'Compte', customers, inventory: { rows } }], NOW);
const names = (list) => list.map((task) => task.name);

test('tenant qui expire dans 60 jours ou moins : urgent ; plus tard mais sous 6 mois : à prévoir', () => {
  const { urgent, planned } = tasksOf([
    customer('A60', { rawLines: [line(5, 1, 60)] }),
    customer('A61', { rawLines: [line(5, 1, 61)] }),
  ]);
  assert.deepEqual(names(urgent), ['A60']);
  assert.deepEqual(names(planned), ['A61']);
});

test('tenant expiré, actif, sans équipement : à vérifier, avec demande au technicien', () => {
  const zeroLine = (days) => ({ entitlementDeviceType: 'DVCNWTYPE_APSW', quantity: '0', consumed: '0', wifiDeviceCount: '0', switchDeviceCount: '0', expirationDate: iso(days) });
  const { mandatory, urgent, warning } = tasksOf([
    customer('Recent', { serviceExpiry: iso(-48), tenantStatus: 'Active', rawLines: [zeroLine(-48)] }),
    customer('Ancien', { serviceExpiry: iso(-620), tenantStatus: 'Active', rawLines: [zeroLine(-620)] }),
  ]);
  assert.deepEqual(names(warning), ['Ancien', 'Recent']);
  assert.equal(mandatory.length + urgent.length, 0);
  assert.deepEqual(warning[0].reasons.map((r) => r.key), ['item.expired', 'item.noDevice']);
  assert.deepEqual(warning[0].actions, [{ key: 'reco.emptyTenant' }]);
});

test('licences expirées sans équipement : pas de renouvellement proposé, juste la vérification', () => {
  const { warning } = tasksOf([customer('Vide', { rawLines: [line(40, 0, -21)], tenantStatus: 'Active' })]);
  assert.deepEqual(warning[0].actions, [{ key: 'reco.emptyTenant' }]);
});

test('licences illisibles : on ne suggère pas de supprimer le tenant, il reste urgent', () => {
  const note = { key: 'error.api.403', params: { whatKey: 'source.lines', status: 403 } };
  const { urgent, warning } = tasksOf([customer('Inconnu', { serviceExpiry: iso(-10), tenantStatus: 'Active', note })]);
  assert.deepEqual(names(urgent), ['Inconnu']);
  assert.equal(warning.length, 0);
  assert.ok(!urgent[0].actions.some((a) => a.key === 'reco.emptyTenant'));
});

test('tenant expiré avec licences encore utilisées : action obligatoire', () => {
  const { mandatory } = tasksOf([customer('Requis', { rawLines: [line(40, 38, -21)], tenantStatus: 'Active' })]);
  assert.deepEqual(names(mandatory), ['Requis']);
  assert.deepEqual(mandatory[0].reasons.map((r) => r.key), ['item.expired', 'item.short']);
  assert.equal(mandatory[0].reasons[1].params.count, 38);
});

test('cas clé : des équipements, 0 licence assignée et 0 consommée : action obligatoire', () => {
  const raw = { entitlementDeviceType: 'DVCNWTYPE_APSW', quantity: '0', consumed: '0', wifiDeviceCount: '4', switchDeviceCount: '1', expirationDate: iso(-30) };
  const { mandatory } = tasksOf([customer('Sans licence', { rawLines: [raw], serviceExpiry: iso(-30), tenantStatus: 'Active' })]);
  assert.deepEqual(names(mandatory), ['Sans licence']);
  assert.equal(mandatory[0].reasons[1].params.count, 5);
  assert.deepEqual(mandatory[0].actions.map((a) => a.key)[0], 'reco.add');
});

test('cas réel : consumed et équipements concordent, sans double comptage', () => {
  const raw = { entitlementDeviceType: 'DVCNWTYPE_APSW', quantity: '10', consumed: '2', wifiDeviceCount: '1', switchDeviceCount: '1', expirationDate: iso(680) };
  assert.equal(customer('Reel', { rawLines: [raw] }).totalUsed, 2);
});

test('tenant désactivé : statut dédié, aucune action, et pas compté dans les clients OK', () => {
  for (const tenantStatus of ['Not Active', 'Inactive']) {
    const inactive = customer('Inactif', { serviceExpiry: iso(-10), tenantStatus, rawLines: [line(10, 8, -10)] });
    assert.equal(inactive.status, 'disabled');
    assert.equal(inactive.capacity.state, 'unknown');
    assert.deepEqual(inactive.recommendations, []);
    assert.equal(inactive.lastExpiredAt, NOW - 10 * DAY);
    const result = tasksOf([inactive, customer('OK', { rawLines: [line(10, 2, 680)] })]);
    assert.deepEqual([result.mandatory.length, result.urgent.length, result.planned.length, result.warning.length, result.okCount], [0, 0, 0, 0, 1]);
  }
});

test('tenant désactivé avec licences encore valables : désactivé aussi, et jamais en alerte', () => {
  const inactive = customer('Inactif', { rawLines: [line(10, 12, 30)], tenantStatus: 'Not Active', tier: 'pro', licenseTiers: ['essentials'] });
  assert.equal(inactive.status, 'disabled');
  assert.equal(inactive.tierMismatch, false);
  assert.equal(tasksOf([inactive]).urgent.length, 0);
});

test('« Active » n\'est pas confondu avec un tenant inactif', () => {
  const { warning } = tasksOf([customer('Actif', { serviceExpiry: iso(-10), tenantStatus: 'Active' })]);
  assert.deepEqual(names(warning), ['Actif']);
});

test('client sans problème : aucune action, mais compté comme OK', () => {
  const result = tasksOf([customer('OK', { rawLines: [line(10, 2, 680)] })]);
  assert.deepEqual([result.mandatory.length, result.urgent.length, result.planned.length, result.okCount], [0, 0, 0, 1]);
});

test('un seul élément par client, avec toutes ses raisons et ses actions', () => {
  const { mandatory, urgent } = tasksOf([customer('Double', { rawLines: [line(5, 8, 30)] })]);
  assert.equal(mandatory.length, 1);
  assert.equal(urgent.length, 0);
  assert.deepEqual(mandatory[0].reasons.map((r) => r.key), ['item.expiring', 'item.short']);
  assert.deepEqual(mandatory[0].actions.map((a) => a.key), ['reco.add', 'reco.renewBefore']);
});

test('licences manquantes aujourd\'hui : action obligatoire', () => {
  const { mandatory } = tasksOf([customer('Manque', { rawLines: [line(60, 72, 300)] })]);
  assert.deepEqual(mandatory[0].reasons[0], { key: 'item.short', params: { count: 12 } });
});

test('stock : passe en tête des urgences si le manque arrive sous 6 mois', () => {
  const gap = { at: NOW + 20 * DAY, active: 75, assigned: 80, missing: 5 };
  const rows = [{ type: 'APSW', forecast: { gap } }];
  const { urgent } = tasksOf([customer('Client', { rawLines: [line(5, 1, 5)] })], rows);
  assert.equal(urgent[0].type, 'stock');
  assert.deepEqual(urgent[0].actions[0], { key: 'item.orderBefore', params: { count: 5, date: gap.at } });
  assert.equal(urgent[0].reasons[0].params.days, 20);
});

test('stock : manque lointain à prévoir, et manque immédiat obligatoire et formulé au présent', () => {
  const far = { at: NOW + 400 * DAY, active: 75, assigned: 80, missing: 5 };
  assert.equal(tasksOf([], [{ type: 'APSW', forecast: { gap: far } }]).planned[0].type, 'stock');
  const today = { at: NOW, active: 75, assigned: 80, missing: 5 };
  const [task] = tasksOf([], [{ type: 'APSW', forecast: { gap: today } }]).mandatory;
  assert.equal(task.reasons[0].key, 'forecast.gapNow');
  assert.equal(task.actions[0].key, 'item.orderNow');
});

test('client Professional sur licences Essentials : urgent, avec raison et action dédiées', () => {
  const { urgent } = tasksOf([customer('Mix', { rawLines: [line(10, 2, 680)], tier: 'pro', licenseTiers: ['essentials'] })]);
  assert.deepEqual(names(urgent), ['Mix']);
  assert.equal(urgent[0].tier, 'pro');
  assert.deepEqual(urgent[0].reasons.map((r) => r.key), ['item.tierMismatch']);
  assert.deepEqual(urgent[0].actions.map((a) => a.key), ['reco.tierMismatch']);
});

test('client Essentials sur licences Pro : aucune alerte', () => {
  const result = tasksOf([customer('OK', { rawLines: [line(10, 2, 680)], tier: 'essentials', licenseTiers: ['pro'] })]);
  assert.deepEqual([result.urgent.length, result.okCount], [0, 1]);
});

test('un compte en erreur, sans stock ni client, ne casse pas la liste', () => {
  const result = buildTasks([{ label: 'Compte', customers: [], inventory: null }], NOW);
  assert.deepEqual([result.mandatory.length, result.urgent.length, result.okCount], [0, 0, 0]);
});
