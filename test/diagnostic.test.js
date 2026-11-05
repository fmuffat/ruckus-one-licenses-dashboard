'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { collectAccount } = require('../src/core/r1Client');
const { createDemoFetch, DEMO_ACCOUNT } = require('../src/core/demoServer');
const { createRecorder, buildDiagnostic } = require('../src/core/diagnostic');

const NOW = Date.UTC(2026, 10, 5, 12);

async function diagnosticFor(fetchImpl, account = DEMO_ACCOUNT) {
  const recorder = createRecorder(fetchImpl);
  const result = await collectAccount(account, { fetchImpl: recorder.fetchImpl, now: NOW });
  return buildDiagnostic([{ result, exchanges: recorder.exchanges }], { appVersion: '1.0', now: NOW });
}

test('garde les données utiles et masque les noms de clients de façon stable', async () => {
  const diagnostic = await diagnosticFor(createDemoFetch(NOW));
  const text = JSON.stringify(diagnostic);
  for (const name of ['Hôtel Beauséjour', 'Clinique des Alpes', 'Groupe Hôtelier Azur']) {
    assert.ok(!text.includes(name), name);
  }
  const tenants = diagnostic.accounts[0].exchanges.find((e) => e.path === '/tenants/query');
  const first = tenants.responseBody.data[0];
  assert.match(first.name, /^masque-\d+$/);
  assert.equal(first.entitlements[0].entitlementDeviceType, 'DVCNWTYPE_APSW');
  assert.equal(first.entitlements[0].quantity, '40');
  assert.match(first.entitlements[0].expirationDate, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(first.tenantType, 'MSP_EC');
  const customer = diagnostic.accounts[0].result.customers.find((c) => c.status === 'expired');
  assert.match(customer.name, /^masque-\d+$/);
  assert.equal(customer.recommendations[0].key, 'reco.renewExpired');
  assert.equal(customer.recommendations[0].params.type, 'APSW');
  assert.equal(customer.tier, 'pro');
  assert.equal(customer.tenantStatus, 'Active');
});

test('ne contient ni secret, ni jeton, ni identifiants, ni Tenant ID', async () => {
  const account = { id: 'a', label: 'Mon MSP', region: 'eu', tenantId: 'tenant-1234567', clientId: 'client-abc', clientSecret: 'S3CRET-VALUE' };
  const base = createDemoFetch(NOW);
  const fetchImpl = async (url, init) => {
    if (new URL(url).pathname.startsWith('/oauth2/')) {
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ access_token: 'JWT-VALUE' }), clone() { return this; } };
    }
    return base(url, init);
  };
  const text = JSON.stringify(await diagnosticFor(fetchImpl, account));
  for (const sensitive of ['S3CRET-VALUE', 'JWT-VALUE', 'client-abc', 'tenant-1234567', 'Mon MSP', 'Bearer']) {
    assert.ok(!text.includes(sensitive), sensitive);
  }
});

test('masque aussi e-mails, adresses, codes postaux et champs inconnus', async () => {
  const body = {
    data: [{
      id: 't1', name: 'Vrai Client', tenantType: 'MSP_EC', streetAddress: '1 rue X', postalCode: '74000',
      tenantEmail: 'contact@client.fr', champInconnu: 'valeur sensible', wifiLicenses: 3,
    }],
    totalCount: 1,
  };
  const fetchImpl = async (url) => {
    const { pathname } = new URL(url);
    const payload = pathname.startsWith('/oauth2/') ? { access_token: 'x' } : pathname === '/tenants/query' ? body : {};
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => payload, clone() { return this; } };
  };
  const text = JSON.stringify(await diagnosticFor(fetchImpl));
  for (const sensitive of ['Vrai Client', '1 rue X', '74000', 'contact@client.fr', 'valeur sensible']) {
    assert.ok(!text.includes(sensitive), sensitive);
  }
  assert.ok(text.includes('"wifiLicenses":3'));
});

test('le niveau du client est demandé à l\'API et reste lisible dans le diagnostic', async () => {
  const seen = [];
  const body = { data: [{ id: 't1', name: 'Vrai Client', tenantType: 'MSP_EC', accountTier: 'Essentials', displayTier: 'Essentials' }], totalCount: 1 };
  const fetchImpl = async (url, init) => {
    const { pathname } = new URL(url);
    if (pathname === '/tenants/query') seen.push(JSON.parse(init.body));
    const payload = pathname.startsWith('/oauth2/') ? { access_token: 'x' } : pathname === '/tenants/query' ? body : {};
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => payload, clone() { return this; } };
  };
  const diagnostic = await diagnosticFor(fetchImpl);
  assert.ok(seen[0].fields.includes('accountTier') && seen[0].fields.includes('displayTier'));
  const tenant = diagnostic.accounts[0].exchanges.find((e) => e.path === '/tenants/query').responseBody.data[0];
  assert.deepEqual([tenant.accountTier, tenant.displayTier], ['Essentials', 'Essentials']);
  assert.match(tenant.name, /^masque-\d+$/);
});

test('limite le volume : 25 lignes et 5 échanges par chemin', async () => {
  const rows = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, name: `C${i}`, tenantType: 'MSP_EC' }));
  let calls = 0;
  const fetchImpl = async (url) => {
    const { pathname } = new URL(url);
    if (pathname === '/tenants/query') calls += 1;
    const payload = pathname.startsWith('/oauth2/') ? { access_token: 'x' } : pathname === '/tenants/query' ? { data: rows, totalCount: 40 } : {};
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => payload, clone() { return this; } };
  };
  const diagnostic = await diagnosticFor(fetchImpl);
  const exchange = diagnostic.accounts[0].exchanges.find((e) => e.path === '/tenants/query');
  assert.equal(calls, 1);
  assert.equal(exchange.responseBody.data.length, 25);
  assert.equal(exchange.responseBody.rowsOmitted, 15);
  assert.equal(diagnostic.accounts[0].result.customerCount, 40);
});
