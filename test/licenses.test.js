'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { addMonths, parseDate, normalizeType, evaluateCustomer, compareCustomers } = require('../src/core/licenses');

const NOW = Date.UTC(2026, 10, 5, 12);
const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const line = (quantity, consumed, days, type = 'DVCNWTYPE_APSW') => ({
  entitlementDeviceType: type,
  quantity: String(quantity),
  consumed: String(consumed),
  expirationDate: iso(NOW + days * DAY),
});
const evaluate = (customer) => evaluateCustomer({ id: 'x', name: 'Client', kind: 'MSP', ...customer }, NOW);

test('addMonths reste sur le dernier jour du mois quand le jour n\'existe pas', () => {
  assert.equal(new Date(addMonths(Date.UTC(2026, 7, 31), 6)).toISOString().slice(0, 10), '2027-02-28');
});

test('parseDate accepte ISO, millisecondes en texte, et garde une date seule jusqu\'au soir', () => {
  assert.equal(parseDate('2026-01-02T00:00:00Z'), Date.UTC(2026, 0, 2));
  assert.equal(parseDate('1790000000000'), 1790000000000);
  assert.equal(parseDate('2026-01-02'), Date.UTC(2026, 0, 2, 23, 59, 59, 999));
  assert.equal(parseDate('n/a'), null);
  assert.equal(parseDate(null), null);
});

test('normalizeType retire les préfixes de l\'API', () => {
  assert.equal(normalizeType('DVCNWTYPE_APSW'), 'APSW');
  assert.equal(normalizeType('MSP_APSW_TEMP'), 'APSW');
});

test('statut rouge si toutes les licences sont expirées', () => {
  const c = evaluate({ rawLines: [line(10, 8, -1)] });
  assert.equal(c.status, 'expired');
  assert.equal(c.lastExpiredAt, NOW - DAY);
});

test('statut rouge si le service client est terminé, même avec des licences valides', () => {
  const c = evaluate({ rawLines: [line(10, 8, 400)], serviceExpiry: iso(NOW - DAY) });
  assert.equal(c.status, 'expired');
});

test('statut orange à 6 mois pile, vert le lendemain', () => {
  const limit = addMonths(NOW, 6);
  const at = (ms) => evaluate({ rawLines: [{ quantity: 1, consumed: 0, entitlementDeviceType: 'APSW', expirationDate: iso(ms) }] });
  assert.equal(at(limit).status, 'expiring');
  assert.equal(at(limit + DAY).status, 'ok');
});

test('une ancienne ligne expirée ne rend pas rouge un client couvert', () => {
  const c = evaluate({ rawLines: [line(10, 0, -300), line(20, 15, 500)] });
  assert.equal(c.status, 'ok');
  assert.equal(c.totalActive, 20);
  assert.equal(c.capacity.state, 'ok');
});

test('statut gris sans aucune information, et les lignes à zéro sont ignorées', () => {
  const c = evaluate({ rawLines: [line(0, 0, 100)] });
  assert.equal(c.status, 'unknown');
  assert.equal(c.capacity.state, 'unknown');
});

test('détecte un manque de licences actuel et le chiffre', () => {
  const c = evaluate({ rawLines: [line(60, 72, 300)] });
  assert.deepEqual(c.capacity, { state: 'short', count: 12, at: null });
  assert.deepEqual(c.recommendations[0], { key: 'reco.add', params: { count: 12, type: 'APSW', used: 72, active: 60 } });
});

test('détecte un manque futur à la date où le stock passe sous l\'usage', () => {
  const c = evaluate({ rawLines: [line(50, 40, 120), line(30, 0, 700)] });
  assert.equal(c.capacity.state, 'soon');
  assert.equal(c.capacity.count, 10);
  assert.equal(c.capacity.at, NOW + 120 * DAY);
});

test('licences toutes expirées : recommande de renouveler, pas d\'ajouter', () => {
  const c = evaluate({ rawLines: [line(40, 38, -21)] });
  assert.deepEqual(c.recommendations, [{ key: 'reco.renewExpired', params: { count: 40, type: 'APSW' } }]);
});

test('stock unique qui expire : orange, sans doublon « va manquer »', () => {
  const c = evaluate({ rawLines: [line(120, 96, 45)] });
  assert.equal(c.status, 'expiring');
  assert.equal(c.capacity.state, 'ok');
  assert.deepEqual(c.recommendations[0], { key: 'reco.renewBefore', params: { count: 120, type: 'APSW', date: NOW + 45 * DAY } });
});

test('pas de manque futur si le stock restant couvre l\'usage', () => {
  const c = evaluate({ rawLines: [line(50, 10, 120), line(30, 0, 700)] });
  assert.equal(c.status, 'expiring');
  assert.equal(c.capacity.state, 'ok');
});

test('reprend les chiffres de non-conformité renvoyés par l\'API', () => {
  const c = evaluate({ rawLines: [{ ...line(10, 5, 400), outOfComplianceDevices: '3' }] });
  assert.deepEqual(c.capacity, { state: 'short', count: 3, at: null });
});

test('cas réel : la date de fin lointaine renvoyée par RUCKUS ne déclenche pas d\'alerte', () => {
  const c = evaluate({ rawLines: [{ ...line(10, 2, 680), futureOutOfComplianceDevices: '2', futureOfComplianceDate: String(NOW + 680 * DAY) }] });
  assert.equal(c.status, 'ok');
  assert.equal(c.capacity.state, 'ok');
  assert.deepEqual(c.recommendations, []);
});

test('cas réel : tout le stock expire bientôt, orange sans doublon « va manquer »', () => {
  const c = evaluate({ rawLines: [{ ...line(8, 6, 24), futureOutOfComplianceDevices: '6', futureOfComplianceDate: String(NOW + 24 * DAY) }] });
  assert.equal(c.status, 'expiring');
  assert.equal(c.capacity.state, 'ok');
});

test('cas réel : licences et tenant finissent le même jour, une seule recommandation sur le tenant', () => {
  const end = iso(NOW + 24 * DAY);
  const c = evaluate({ rawLines: [line(8, 6, 24)], serviceExpiry: end });
  assert.equal(c.status, 'expiring');
  assert.deepEqual(c.recommendations, [{ key: 'reco.serviceBefore', params: { date: NOW + 24 * DAY } }]);
});

test('licences qui finissent avant le tenant : la recommandation porte sur les licences', () => {
  const c = evaluate({ rawLines: [line(8, 6, 24)], serviceExpiry: iso(NOW + 100 * DAY) });
  assert.deepEqual(c.recommendations.map((r) => r.key), ['reco.renewBefore']);
});

test('un manque annoncé par RUCKUS reste signalé si une partie du stock survit', () => {
  const c = evaluate({ rawLines: [
    { ...line(10, 8, 60), futureOutOfComplianceDevices: '3', futureOfComplianceDate: String(NOW + 60 * DAY) },
    line(5, 0, 700),
  ] });
  assert.equal(c.capacity.state, 'soon');
  assert.equal(c.capacity.at, NOW + 60 * DAY);
});

test('l\'usage de la conformité remplace la somme des lignes', () => {
  const c = evaluate({ rawLines: [{ deviceType: 'APSW', quantity: 10, expirationDate: iso(NOW + 900 * DAY) }], usedByType: { APSW: 14 } });
  assert.equal(c.totalUsed, 14);
  assert.equal(c.capacity.count, 4);
});

test('tri : expirés, puis échéances les plus proches, puis OK, et désactivés à la fin', () => {
  const sorted = [
    evaluate({ name: 'desactive', serviceExpiry: iso(NOW - DAY), tenantStatus: 'Not Active' }),
    evaluate({ name: 'ok', rawLines: [line(1, 0, 900)] }),
    evaluate({ name: 'loin', rawLines: [line(1, 0, 150)] }),
    evaluate({ name: 'proche', rawLines: [line(1, 0, 10)] }),
    evaluate({ name: 'expire', rawLines: [line(1, 0, -5)] }),
  ].sort(compareCustomers).map((c) => c.name);
  assert.deepEqual(sorted, ['expire', 'proche', 'loin', 'ok', 'desactive']);
});
