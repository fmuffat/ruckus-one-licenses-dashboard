'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildInventory } = require('../src/core/inventory');

const NOW = Date.UTC(2026, 10, 5, 12);
const DAY = 86400000;
const iso = (days) => new Date(NOW + days * DAY).toISOString();

// Forme et valeurs relevées sur un vrai compte MSP, et non le schéma publié par RUCKUS.
const REAL_MSP_COMPLIANCE = {
  licenseType: 'APSW',
  activeLicenses: {
    paid: { total: 84, courtesyQty: 4, nextExpirationDate: 'Tue Sep 12 23:59:59 GMT 2028', nextExpiringCount: 80 },
    trial: { total: 0, courtesyQty: 0, nextExpiringCount: 0 },
  },
  licensesUsed: { self: { paid: 0, trial: 0, total: 0 }, mspCustomers: { paid: 53, total: 53 } },
  licensesAvailable: { self: { paid: 31, trial: 0, total: 31 }, mspCustomers: { paid: 31, total: 31 } },
  outOfCompliance: { self: { total: 0 }, mspCustomers: { paid: 0, expiredServices: 0, total: 0 }, total: 0 },
  self: { usedSummary: [], totalConfigured: 0, totalLicensesUsed: 0 },
  mspEcSummary: {
    usedSummary: [{ type: 'SWITCH', installedCount: 1, licensesUsed: 1 }, { type: 'WIFI', installedCount: 7, licensesUsed: 7 }],
    totalConfigured: 8,
    totalLicensesUsed: 8,
  },
};

// Quantités et dates réelles : le résultat doit reproduire le graphique de la console RUCKUS One.
const REAL_LINES = Array.from({ length: 4 }, () => ({
  licenseType: 'APSW', quantity: 20, effectiveDate: 'Tue Sep 12 00:00:00 UTC 2023', expirationDate: 'Tue Sep 12 23:59:59 UTC 2028',
}));
const realTenant = (quantity, expirationDate) => ({
  name: 'Client',
  entitlements: [{ entitlementDeviceType: 'DVCNWTYPE_APSW', quantity: String(quantity), expirationDate, accountType: 'PAID' }],
});
const REAL_TENANTS = [
  realTenant(15, '2027-09-17T23:59:59Z'),
  realTenant(15, '2027-09-22T23:59:59Z'),
  realTenant(10, '2027-09-16T23:59:59Z'),
  realTenant(8, '2026-11-29T23:59:59Z'),
  realTenant(5, '2027-10-14T23:59:59Z'),
  realTenant(0, '2026-09-18T08:37:14Z'),
];

test('prévision : reproduit les barres du graphique de la console sur le compte réel', () => {
  const { rows } = buildInventory([REAL_MSP_COMPLIANCE], REAL_LINES, NOW, REAL_TENANTS);
  const { months, gap } = rows[0].forecast;
  const at = (year, month) => months.find((m) => new Date(m.at).getUTCFullYear() === year && new Date(m.at).getUTCMonth() === month - 1);
  assert.deepEqual([at(2026, 11).active, at(2026, 11).assigned], [84, 45]);
  assert.deepEqual([at(2027, 8).active, at(2027, 8).assigned], [84, 45]);
  assert.deepEqual([at(2027, 9).active, at(2027, 9).assigned], [84, 5]);
  assert.deepEqual([at(2027, 10).active, at(2027, 10).assigned], [84, 0]);
  assert.deepEqual([at(2028, 4).active, at(2028, 4).assigned], [84, 0]);
  assert.equal(months.length, 26);
  assert.equal(new Date(months[months.length - 1].at).getUTCFullYear(), 2028);
  assert.equal(gap, null);
});

test('prévision : le cas « 5 licences expirent dans 3 jours » donne la date exacte du manque', () => {
  const lines = [
    { licenseType: 'APSW', quantity: 75, expirationDate: iso(900) },
    { licenseType: 'APSW', quantity: 5, expirationDate: iso(3) },
  ];
  const compliance = { licenseType: 'APSW', activeLicenses: { paid: { total: 80 } }, licensesUsed: { mspCustomers: { total: 80 } } };
  const tenants = [realTenant(80, iso(800))];
  const { gap, events } = buildInventory([compliance], lines, NOW, tenants).rows[0].forecast;
  assert.deepEqual(gap, { at: NOW + 3 * DAY, active: 75, assigned: 80, missing: 5 });
  assert.deepEqual(events[0], { at: NOW + 3 * DAY, kind: 'active', count: 5, name: null });
});

test('prévision : un manque le jour même est signalé tout de suite', () => {
  const compliance = { licenseType: 'APSW', activeLicenses: { paid: { total: 10 } }, licensesUsed: { mspCustomers: { total: 12 } } };
  const { gap } = buildInventory([compliance], [{ licenseType: 'APSW', quantity: 10, expirationDate: iso(900) }], NOW, [realTenant(12, iso(500))]).rows[0].forecast;
  assert.deepEqual(gap, { at: NOW, active: 10, assigned: 12, missing: 2 });
});

test('prévision : le tenant qui expire le même jour libère ses licences, pas de faux manque', () => {
  const compliance = { licenseType: 'APSW', activeLicenses: { paid: { total: 15 } }, licensesUsed: { mspCustomers: { total: 15 } } };
  const lines = [
    { licenseType: 'APSW', quantity: 10, expirationDate: iso(900) },
    { licenseType: 'APSW', quantity: 5, expirationDate: iso(30) },
  ];
  const { gap } = buildInventory([compliance], lines, NOW, [realTenant(10, iso(800)), realTenant(5, iso(30))]).rows[0].forecast;
  assert.equal(gap, null);
});

test('prévision : les licences d\'essai ne comptent ni en stock ni en attribution', () => {
  const compliance = { licenseType: 'APSW', activeLicenses: { paid: { total: 10 } }, licensesUsed: { mspCustomers: { total: 5 } } };
  const lines = [
    { licenseType: 'APSW', quantity: 10, expirationDate: iso(900) },
    { licenseType: 'APSW', quantity: 50, expirationDate: iso(900), isTrial: true },
  ];
  const trial = { name: 'Essai', entitlements: [{ entitlementDeviceType: 'DVCNWTYPE_APSW', quantity: '9', expirationDate: iso(800), accountType: 'TRIAL' }] };
  const { months } = buildInventory([compliance], lines, NOW, [realTenant(5, iso(800)), trial]).rows[0].forecast;
  assert.deepEqual([months[0].active, months[0].assigned], [10, 5]);
});

test('prévision : une licence REC du compte n\'alimente pas le stock MSP', () => {
  const compliance = { licenseType: 'APSW', activeLicenses: { paid: { total: 10 } }, licensesUsed: { mspCustomers: { total: 5 } } };
  const lines = [
    { licenseType: 'APSW', sku: 'CLD-PROF-APSW-MSP5-AP', quantity: 10, expirationDate: iso(900) },
    { licenseType: 'APSW', sku: 'CLD-PROF-APSW-REC5', quantity: 50, expirationDate: iso(900) },
  ];
  const { months } = buildInventory([compliance], lines, NOW, [realTenant(5, iso(800))]).rows[0].forecast;
  assert.equal(months[0].active, 10);
});

test('pas de prévision sans liste de clients, ni pour un compte sans clients MSP', () => {
  assert.equal(buildInventory([REAL_MSP_COMPLIANCE], REAL_LINES, NOW, null).rows[0].forecast, null);
  const direct = { licenseType: 'APSW', activeLicenses: { paid: { total: 5 } }, licensesUsed: { self: { total: 2 } } };
  assert.equal(buildInventory([direct], [], NOW, []).rows[0].forecast, null);
});

test('compte MSP réel : actives, courtoisie, assignées, utilisées, disponibles et expiration', () => {
  const { rows } = buildInventory([REAL_MSP_COMPLIANCE], [], NOW);
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.deepEqual(
    [row.type, row.active, row.courtesy, row.assigned, row.used, row.available, row.shortage, row.nextExpiringCount],
    ['APSW', 84, 4, 53, 8, 31, 0, 80],
  );
  assert.equal(row.nextExpiry, Date.UTC(2028, 8, 12, 23, 59, 59));
});

test('la conformité réelle l\'emporte sur le calcul depuis les lignes', () => {
  const { rows } = buildInventory([REAL_MSP_COMPLIANCE], [{ licenseType: 'APSW', quantity: 80, expirationDate: iso(900) }], NOW);
  assert.equal(rows[0].active, 84);
  assert.equal(rows[0].used, 8);
});

test('compte sans clients MSP : pas de colonne assignées, disponibilité du compte', () => {
  const { rows } = buildInventory([{
    licenseType: 'APSW',
    activeLicenses: { paid: { total: 20 } },
    licensesUsed: { self: { total: 12 } },
    licensesAvailable: { self: { total: 8 } },
    outOfCompliance: { total: 0 },
  }], [], NOW);
  assert.deepEqual([rows[0].active, rows[0].used, rows[0].assigned, rows[0].available], [20, 12, null, 8]);
});

test('reprend le manque de licences renvoyé par RUCKUS', () => {
  const { rows } = buildInventory([{ ...REAL_MSP_COMPLIANCE, outOfCompliance: { total: 6 } }], [], NOW);
  assert.equal(rows[0].shortage, 6);
});

test('tous les types de licence renvoyés sont gardés', () => {
  const { rows } = buildInventory([
    { licenseType: 'APSW', activeLicenses: { paid: { total: 5 } } },
    { licenseType: 'SLTN_TOKEN', activeLicenses: { paid: { total: 2 } } },
  ], [], NOW);
  assert.deepEqual(rows.map((r) => r.type), ['APSW', 'SLTN_TOKEN']);
});

test('conformité indisponible : le stock vient des lignes, et l\'usage reste inconnu', () => {
  const { rows } = buildInventory([], [
    { licenseType: 'APSW', quantity: 10, expirationDate: iso(100) },
    { licenseType: 'APSW', quantity: 4, expirationDate: iso(100) },
    { licenseType: 'APSW', quantity: 2, expirationDate: iso(400), isTrial: true },
    { licenseType: 'APSW', quantity: 50, expirationDate: iso(-5) },
    { licenseType: 'APSW', quantity: 30, effectiveDate: iso(30), expirationDate: iso(400) },
  ], NOW);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].active, rows[0].trial, rows[0].used, rows[0].nextExpiringCount], [14, 2, null, 14]);
  assert.equal(rows[0].nextExpiry, NOW + 100 * DAY);
});

test('une conformité entièrement vide laisse la place aux lignes', () => {
  const { rows } = buildInventory([{ licenseType: 'APSW' }],
    [{ licenseType: 'APSW', quantity: 8, expirationDate: iso(900) }], NOW);
  assert.equal(rows[0].active, 8);
});

test('lignes : le niveau vient du SKU, avec skuTier en repli', () => {
  const { lines } = buildInventory([], [
    { licenseType: 'APSW', sku: 'CLD-PROF-APSW-MSP5-AP', quantity: 1 },
    { licenseType: 'APSW', sku: 'CLR-ESNT-APSW-REC3', quantity: 1 },
    { licenseType: 'APSW', sku: 'AUTRE', skuTier: 'Gold', quantity: 1 },
    { licenseType: 'APSW', sku: 'CLD-R1-TMP090-MSP', skuTier: null, quantity: 1 },
  ], NOW);
  assert.deepEqual(lines.map((l) => l.tier), ['pro', 'essentials', 'essentials', null]);
});

test('lignes réelles : la date au format RUCKUS est comprise et le SKU sert de nom', () => {
  const { lines } = buildInventory([], [{
    licenseType: 'APSW',
    sku: 'CLD-PROF-APSW-MSP5-AP',
    quantity: 20,
    effectiveDate: 'Tue Sep 12 00:00:00 UTC 2023',
    expirationDate: 'Tue Sep 12 23:59:59 UTC 2028',
    isTrial: false,
  }], NOW);
  assert.equal(lines[0].name, 'CLD-PROF-APSW-MSP5-AP');
  assert.equal(lines[0].startsAt, Date.UTC(2023, 8, 12));
  assert.equal(lines[0].expiresAt, Date.UTC(2028, 8, 12, 23, 59, 59));
  assert.equal(lines[0].status, 'ok');
  assert.equal(lines[0].trial, false);
});

test('lignes : statut de chacune, les plus urgentes d\'abord, les expirées à la fin', () => {
  const { lines } = buildInventory([], [
    { licenseName: 'expirée', deviceType: 'APSW', quantity: 1, expirationDate: iso(-1) },
    { licenseName: 'longue', deviceType: 'APSW', quantity: 1, expirationDate: iso(900) },
    { licenseName: 'à venir', deviceType: 'APSW', quantity: 1, effectiveDate: iso(10), expirationDate: iso(400) },
    { licenseName: 'bientôt', deviceType: 'APSW', quantity: 1, expirationDate: iso(30) },
    { licenseName: 'vide', deviceType: 'APSW', quantity: 0, expirationDate: iso(30) },
  ], NOW);
  assert.deepEqual(lines.map((l) => [l.name, l.status]), [
    ['bientôt', 'expiring'], ['longue', 'ok'], ['à venir', 'future'], ['expirée', 'expired'],
  ]);
});
