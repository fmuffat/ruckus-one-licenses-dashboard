'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { collectAccount } = require('../src/core/r1Client');
const { createDemoFetch, DEMO_ACCOUNT } = require('../src/core/demoServer');
const { customersToCsv } = require('../src/core/csv');

const NOW = Date.UTC(2026, 10, 5, 12);
const account = { id: 'a', label: 'Compte', region: 'eu', tenantId: 'self-tenant', clientId: 'id', clientSecret: 's3cret' };

const response = (body, status = 200, headers = {}) => ({
  ok: status < 400,
  status,
  headers: { get: (name) => headers[name] ?? null },
  json: async () => body,
});

function recorder(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { pathname, host } = new URL(url);
    calls.push({ url, host, pathname, init });
    const route = routes[pathname];
    if (!route) return response({}, 404);
    return typeof route === 'function' ? route(url, init, calls) : route;
  };
  return { calls, fetchImpl };
}

const token = response({ access_token: 'jwt' });
const auth = { '/oauth2/token/self-tenant': token };

test('authentification : hôte régional, formulaire OAuth2, puis Bearer sur le domaine api', async () => {
  const { calls, fetchImpl } = recorder({ ...auth, '/tenants/query': response({ data: [], totalCount: 0 }) });
  await collectAccount(account, { fetchImpl, now: NOW });
  const authCall = calls[0];
  assert.equal(authCall.host, 'eu.ruckus.cloud');
  assert.equal(authCall.init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(authCall.init.body);
  assert.equal(form.get('grant_type'), 'client_credentials');
  assert.equal(form.get('client_secret'), 's3cret');
  const tenantCall = calls.find((c) => c.pathname === '/tenants/query');
  assert.equal(tenantCall.host, 'api.eu.ruckus.cloud');
  assert.equal(tenantCall.init.headers.Authorization, 'Bearer jwt');
  assert.equal(tenantCall.init.headers['Content-Type'], 'application/vnd.ruckus.v2+json');
});

test('le secret n\'est envoyé qu\'à l\'authentification', async () => {
  const { calls, fetchImpl } = recorder({ ...auth, '/tenants/query': response({ data: [] }) });
  await collectAccount(account, { fetchImpl, now: NOW });
  const leaks = calls.slice(1).filter((c) => JSON.stringify(c.init).includes('s3cret'));
  assert.equal(leaks.length, 0);
});

test('identifiants refusés : message clair, aucune autre requête', async () => {
  const { calls, fetchImpl } = recorder({ '/oauth2/token/self-tenant': response({}, 401) });
  const result = await collectAccount(account, { fetchImpl, now: NOW });
  assert.deepEqual(result.fatal, { key: 'error.api.401', params: { whatKey: 'source.auth', status: 401 } });
  assert.equal(calls.length, 1);
});

test('pagination : parcourt toutes les pages', async () => {
  const pageOf = (start, n) => Array.from({ length: n }, (_, i) => ({ id: `t${start + i}`, name: `C${start + i}`, tenantType: 'MSP_EC' }));
  const { fetchImpl, calls } = recorder({
    ...auth,
    '/tenants/query': (_url, init) => {
      const { page } = JSON.parse(init.body);
      return response({ totalCount: 150, data: page === 1 ? pageOf(0, 100) : pageOf(100, 50) });
    },
  });
  const result = await collectAccount(account, { fetchImpl, now: NOW });
  assert.equal(result.customers.length, 150);
  assert.equal(calls.filter((c) => c.pathname === '/tenants/query').length, 2);
});

test('429 : attend puis réessaie ; 401 en cours de route : renouvelle le jeton une fois', async () => {
  let tenantCalls = 0;
  const waits = [];
  const { calls, fetchImpl } = recorder({
    ...auth,
    '/tenants/query': () => {
      tenantCalls += 1;
      if (tenantCalls === 1) return response({}, 429, { 'retry-after': '2' });
      if (tenantCalls === 2) return response({}, 401);
      return response({ data: [{ id: 't1', name: 'C1', tenantType: 'MSP_EC' }], totalCount: 1 });
    },
  });
  const result = await collectAccount(account, { fetchImpl, now: NOW, sleep: async (ms) => waits.push(ms) });
  assert.equal(result.customers.length, 1);
  assert.deepEqual(waits, [2000]);
  assert.equal(calls.filter((c) => c.pathname.startsWith('/oauth2')).length, 2);
});

test('une source en échec n\'empêche pas d\'afficher les autres', async () => {
  const { fetchImpl } = recorder({
    ...auth,
    '/tenants/query': response({}, 403),
    '/delegations/query': response({ data: [{ tenantId: 'v1', tenantName: 'Client VAR', delegationType: 'VAR', entitlements: [
      { entitlementDeviceType: 'APSW', quantity: '5', consumed: '2', expirationDate: '2030-01-01' },
    ] }] }),
  });
  const result = await collectAccount(account, { fetchImpl, now: NOW });
  assert.equal(result.customers.length, 1);
  assert.equal(result.customers[0].kind, 'VAR');
  assert.equal(result.customers[0].status, 'ok');
  assert.equal(result.sources.find((s) => s.source === 'msp').error.key, 'error.api.403');
});

test('client VAR sans licences dans la délégation : interroge le tenant en mode délégué', async () => {
  const { calls, fetchImpl } = recorder({
    ...auth,
    '/delegations/query': response({ data: [{ tenantId: 'v1', tenantName: 'Client VAR', delegationType: 'VAR' }] }),
    '/entitlements/query': response({ data: [{ deviceType: 'APSW', quantity: 10, expirationDate: '2030-01-01' }], totalCount: 1 }),
    '/entitlements/compliances/query': (_url, init) => (init.headers['x-rks-tenantid']
      ? response({ data: [{ licenseType: 'APSW', self: { totalLicensesUsed: 12 } }] })
      : response({ data: [] })),
  });
  const result = await collectAccount(account, { fetchImpl, now: NOW });
  const [customer] = result.customers;
  assert.equal(customer.capacity.count, 2);
  const entitlementCalls = calls.filter((c) => c.pathname === '/entitlements/query');
  assert.deepEqual(entitlementCalls.map((c) => c.init.headers['x-rks-tenantid']), [undefined, 'v1']);
});

test('client VAR injoignable : reste listé avec une note, et le problème est signalé', async () => {
  const { fetchImpl } = recorder({
    ...auth,
    '/delegations/query': response({ data: [{ tenantId: 'v1', tenantName: 'Client VAR', delegationType: 'VAR' }] }),
    '/entitlements/query': response({}, 403),
  });
  const result = await collectAccount(account, { fetchImpl, now: NOW });
  assert.equal(result.customers[0].status, 'unknown');
  assert.equal(result.customers[0].note.key, 'error.api.403');
  const details = result.sources.find((s) => s.source === 'varDetails');
  assert.deepEqual(details.error, { key: 'error.varDetails', params: { count: 1, total: 1 } });
});

test('démo : MSP et VAR dédoublonnés, intégrateurs et invitations exclus, tous les statuts présents', async () => {
  const result = await collectAccount(DEMO_ACCOUNT, { fetchImpl: createDemoFetch(NOW), now: NOW });
  const names = result.customers.map((c) => c.name);
  assert.equal(names.filter((n) => n === 'Clinique des Alpes').length, 1);
  assert.ok(!names.includes('Partenaire Intégration'));
  assert.ok(!names.includes('Invitation en attente'));
  assert.equal(result.customers.filter((c) => c.kind === 'VAR').length, 3);
  const statuses = new Set(result.customers.map((c) => c.status));
  for (const s of ['expired', 'expiring', 'ok']) assert.ok(statuses.has(s), s);
  assert.equal(result.customers[0].status, 'expired');
  assert.equal(result.inventory.rows.length, 1);
  const [row] = result.inventory.rows;
  assert.deepEqual([row.active, row.used, row.assigned, row.available, row.shortage], [530, 499, 530, 0, 0]);
  assert.equal(result.inventory.lines.length, 5);
  assert.equal(row.forecast.months[0].active, 415);
  assert.deepEqual(row.forecast.gap, { at: NOW + 20 * 86400000, active: 415, assigned: 530, missing: 115 });
});

test('stock : tous les types sont demandés, sans en-tête délégué', async () => {
  const { calls, fetchImpl } = recorder({ ...auth, '/entitlements/compliances/query': response({ data: [] }) });
  await collectAccount(account, { fetchImpl, now: NOW });
  const call = calls.find((c) => c.pathname === '/entitlements/compliances/query');
  assert.deepEqual(JSON.parse(call.init.body), { filters: {} });
  assert.equal(call.init.headers['x-rks-tenantid'], undefined);
});

test('les licences d\'un client VAR restent à lui : elles ne comptent pas dans les assignations MSP', async () => {
  const line = (quantity, consumed) => ({
    entitlementDeviceType: 'DVCNWTYPE_APSW', quantity: String(quantity), consumed: String(consumed), expirationDate: '2030-01-01', accountType: 'PAID',
  });
  const { fetchImpl } = recorder({
    ...auth,
    '/entitlements/compliances/query': response({ data: [{ licenseType: 'APSW', activeLicenses: { paid: { total: 20 } }, licensesUsed: { mspCustomers: { total: 10 } } }] }),
    '/entitlements/query': response({ data: [{ licenseType: 'APSW', sku: 'CLD-PROF-APSW-MSP5', quantity: 20, expirationDate: '2030-06-01' }], totalCount: 1 }),
    '/tenants/query': response({ data: [{ id: 't1', name: 'MSP', tenantType: 'MSP_EC', entitlements: [line(10, 2)] }], totalCount: 1 }),
    '/delegations/query': response({ data: [{ tenantId: 'v1', tenantName: 'VAR', delegationType: 'DELEGATION_TYPE_VAR', entitlements: [line(500, 400)] }], totalCount: 1 }),
  });
  const result = await collectAccount(account, { fetchImpl, now: NOW });
  const [{ forecast }] = result.inventory.rows;
  assert.equal(forecast.months[0].assigned, 10);
  assert.equal(forecast.gap, null);
  const customer = result.customers.find((c) => c.kind === 'VAR');
  assert.deepEqual([customer.totalActive, customer.totalUsed], [500, 400]);
});

test('niveau : lu sur les clients MSP (Platinum = Pro, Gold = Essentials)', async () => {
  const { fetchImpl } = recorder({
    ...auth,
    '/tenants/query': response({ data: [
      { id: 't1', name: 'Pro', tenantType: 'MSP_EC', accountTier: 'Platinum' },
      { id: 't2', name: 'Ess', tenantType: 'MSP_EC', accountTier: 'Gold' },
      { id: 't3', name: 'Autre', tenantType: 'MSP_EC', accountTier: 'Silver' },
    ], totalCount: 3 }),
  });
  const { customers } = await collectAccount(account, { fetchImpl, now: NOW });
  assert.deepEqual(['Pro', 'Ess', 'Autre'].map((name) => customers.find((c) => c.name === name).tier), ['pro', 'essentials', null]);
});

const varRoutes = (tierBody, lines) => ({
  ...auth,
  '/delegations/query': response({ data: [{ tenantId: 'v1', tenantName: 'VAR', delegationType: 'VAR', entitlements: [
    { entitlementDeviceType: 'DVCNWTYPE_APSW', quantity: '5', consumed: '1', expirationDate: '2030-01-01' },
  ] }], totalCount: 1 }),
  '/tenants/self': tierBody,
  '/entitlements/query': (_url, init) => (init.headers['x-rks-tenantid']
    ? response({ data: lines, totalCount: lines.length })
    : response({ data: [], totalCount: 0 })),
});

test('VAR : client Professional couvert seulement par des licences Essentials : signalé', async () => {
  const { fetchImpl } = recorder(varRoutes(response({ accountTier: 'Platinum' }), [
    { licenseType: 'APSW', sku: 'CLD-ESNT-APSW-REC5', quantity: 5, expirationDate: '2030-01-01' },
  ]));
  const [customer] = (await collectAccount(account, { fetchImpl, now: NOW })).customers;
  assert.equal(customer.tier, 'pro');
  assert.equal(customer.tierMismatch, true);
  assert.ok(customer.recommendations.some((r) => r.key === 'reco.tierMismatch'));
});

test('VAR : une licence Pro peut couvrir un client Essentials, et une licence expirée ne compte pas', async () => {
  const proForEssentials = recorder(varRoutes(response({ accountTier: 'Gold' }), [
    { licenseType: 'APSW', sku: 'CLD-PROF-APSW-REC5', quantity: 5, expirationDate: '2030-01-01' },
  ]));
  const [a] = (await collectAccount(account, { fetchImpl: proForEssentials.fetchImpl, now: NOW })).customers;
  assert.equal(a.tierMismatch, false);
  const expiredEssentials = recorder(varRoutes(response({ accountTier: 'Platinum' }), [
    { licenseType: 'APSW', sku: 'CLD-PROF-APSW-REC5', quantity: 5, expirationDate: '2030-01-01' },
    { licenseType: 'APSW', sku: 'CLD-ESNT-APSW-REC1', quantity: 5, expirationDate: '2020-01-01' },
  ]));
  const [b] = (await collectAccount(account, { fetchImpl: expiredEssentials.fetchImpl, now: NOW })).customers;
  assert.equal(b.tierMismatch, false);
});

test('VAR : niveau et SKU illisibles : le client reste affiché, sans alerte ni erreur', async () => {
  const { fetchImpl } = recorder(varRoutes(response({}, 403), []));
  const result = await collectAccount(account, { fetchImpl, now: NOW });
  const [customer] = result.customers;
  assert.deepEqual([customer.tier, customer.tierMismatch, customer.totalActive, customer.note], [null, false, 5, null]);
  assert.equal(result.sources.find((s) => s.source === 'varDetails'), undefined);
});

test('CSV : BOM, point-virgule, guillemets et formules neutralisées', () => {
  const csv = customersToCsv([{
    name: '=HYPERLINK("x");1', kind: 'MSP', accountLabel: 'A', status: 'ok', nextExpiry: Date.UTC(2027, 0, 2),
    lastExpiredAt: null, daysLeft: 10, totalUsed: 1, totalActive: 2, capacity: { state: 'ok', count: 0 }, recommendations: [],
  }], 'fr');
  assert.ok(csv.startsWith('﻿Client;Type'));
  assert.ok(csv.includes(`"'=HYPERLINK(""x"");1";MSP;A;OK;2027-01-02`));
});
