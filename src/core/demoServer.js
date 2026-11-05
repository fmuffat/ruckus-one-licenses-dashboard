'use strict';

// Faux serveur RUCKUS One pour le mode démo. Il imite le fetch et le format des réponses :
// la démo passe ainsi par le même code que le mode réel. Tous les noms sont fictifs.

const DAY = 86400000;

function json(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    clone() {
      return this;
    },
  };
}

function line(type, quantity, consumed, days, now, extra = {}) {
  return {
    entitlementDeviceType: type,
    quantity: String(quantity),
    consumed: String(consumed),
    expirationDate: new Date(now + days * DAY).toISOString(),
    ...extra,
  };
}

function tenant(id, name, entitlements, extra = {}) {
  const accountType = extra.accountType || 'PAID';
  return {
    id,
    name,
    tenantType: 'MSP_EC',
    status: 'Active',
    accountType,
    accountTier: 'Platinum',
    entitlements: entitlements.map((entitlement) => ({ ...entitlement, accountType })),
    ...extra,
  };
}

function buildData(now) {
  const tenants = [
    tenant('t01', 'Hôtel Beauséjour', [line('DVCNWTYPE_APSW', 40, 38, -21, now)]),
    tenant('t02', 'Clinique des Alpes', [line('DVCNWTYPE_APSW', 120, 96, 45, now)]),
    tenant('t03', 'Lycée Jean Moulin', [line('DVCNWTYPE_APSW', 60, 72, 300, now)]),
    tenant('t04', 'Résidence Les Tilleuls', [
      line('DVCNWTYPE_APSW', 50, 70, 120, now),
      line('DVCNWTYPE_APSW', 30, 0, 700, now),
    ]),
    tenant('t05', 'Mairie de Valmont', [line('DVCNWTYPE_APSW', 25, 18, 540, now)], { accountTier: 'Gold' }),
    tenant('t06', 'Campus Horizon', [
      line('DVCNWTYPE_APSW', 200, 164, 410, now),
      line('DVCNWTYPE_APSW', 30, 22, 170, now),
    ]),
    tenant('t07', 'Boulangeries Martin', [line('DVCNWTYPE_APSW', 8, 4, 30, now)], { accountType: 'TRIAL' }),
    tenant('t08', 'Golf du Lac', [line('DVCNWTYPE_APSW', 15, 15, 900, now)], { accountTier: 'Gold' }),
    tenant('t09', 'Musée de la Mer', [], { expirationDate: new Date(now - 90 * DAY).toISOString() }),
    tenant('t11', 'Ancien Hôtel Bellevue', [line('DVCNWTYPE_APSW', 0, 0, -400, now)], { status: 'Not Active', expirationDate: new Date(now - 400 * DAY).toISOString() }),
    { id: 't10', name: 'Partenaire Intégration', tenantType: 'MSP_INTEGRATOR', status: 'Active', entitlements: [] },
  ];
  const delegations = [
    { id: 'd01', tenantId: 'v01', tenantName: 'Groupe Hôtelier Azur', delegationType: 'DELEGATION_TYPE_VAR', status: 'DELEGATION_STATUS_ACCEPTED' },
    { id: 'd02', tenantId: 'v02', tenantName: 'Université du Rhône', delegationType: 'DELEGATION_TYPE_VAR', status: 'DELEGATION_STATUS_ACCEPTED' },
    { id: 'd03', tenantId: 'v03', tenantName: 'Transports Régionaux', delegationType: 'DELEGATION_TYPE_VAR', status: 'DELEGATION_STATUS_ACCEPTED' },
    { id: 'd04', tenantId: 'v04', tenantName: 'Invitation en attente', delegationType: 'DELEGATION_TYPE_VAR', status: 'DELEGATION_STATUS_INVITED' },
    { id: 'd05', tenantId: 't02', tenantName: 'Clinique des Alpes', delegationType: 'DELEGATION_TYPE_MSP', status: 'DELEGATION_STATUS_ACCEPTED' },
  ];
  const delegatedEntitlements = {
    v01: { tier: 'Platinum', lines: [{ deviceType: 'APSW', sku: 'CLD-ESNT-APSW-REC5', quantity: 300, expirationDate: new Date(now + 620 * DAY).toISOString() }], used: 240 },
    v02: { tier: 'Platinum', lines: [{ deviceType: 'APSW', sku: 'CLD-PROF-APSW-REC1', quantity: 500, expirationDate: new Date(now + 80 * DAY).toISOString() }], used: 510 },
    v03: { tier: 'Gold', lines: [{ deviceType: 'APSW', sku: 'CLD-ESNT-APSW-REC1', quantity: 90, expirationDate: new Date(now - 10 * DAY).toISOString() }], used: 88 },
  };
  const ownLine = (licenseName, sku, deviceType, quantity, startDays, endDays, extra = {}) => ({
    licenseName,
    sku,
    deviceType,
    quantity,
    effectiveDate: new Date(now + startDays * DAY).toISOString(),
    expirationDate: new Date(now + endDays * DAY).toISOString(),
    ...extra,
  });
  const ownEntitlements = [
    ownLine('RUCKUS One MSP AP & switch 1Y', 'DEMO-MSP-APSW-1Y', 'MSP_APSW', 120, -320, 20),
    ownLine('RUCKUS One MSP AP & switch 3Y', 'DEMO-MSP-APSW-3Y', 'MSP_APSW', 400, -200, 895),
    ownLine('RUCKUS One MSP AP & switch 1Y', 'DEMO-MSP-APSW-1Y', 'MSP_APSW', 80, -400, -35),
    ownLine('RUCKUS One AP & switch 5Y', 'DEMO-APSW-5Y', 'APSW', 10, -100, 1725),
    ownLine('RUCKUS One AP & switch 1Y', 'DEMO-APSW-1Y', 'APSW', 5, 20, 385),
  ];
  return { tenants, delegations, delegatedEntitlements, ownEntitlements };
}

function createDemoFetch(now = Date.now()) {
  const data = buildData(now);
  return async (url, init) => {
    const { pathname } = new URL(url);
    const delegated = init.headers?.['x-rks-tenantid'];
    if (pathname.startsWith('/oauth2/token/')) return json({ access_token: 'demo', token_type: 'Bearer', expires_in: 3600 });
    if (pathname === '/tenants/self') return json({ id: delegated, accountTier: data.delegatedEntitlements[delegated]?.tier });
    if (pathname === '/tenants/query') return json({ totalCount: data.tenants.length, page: 1, data: data.tenants });
    if (pathname === '/delegations/query') return json({ totalCount: data.delegations.length, page: 1, data: data.delegations });
    if (pathname === '/entitlements/query') {
      const lines = delegated ? data.delegatedEntitlements[delegated]?.lines || [] : data.ownEntitlements;
      return json({ totalCount: lines.length, page: 1, data: lines });
    }
    if (pathname === '/entitlements/compliances/query') {
      if (delegated) {
        const used = data.delegatedEntitlements[delegated]?.used ?? 0;
        return json({ data: [{ licenseType: 'APSW', licensesUsed: { self: { total: used } }, self: { totalLicensesUsed: used } }] });
      }
      return json({
        data: [{
          licenseType: 'APSW',
          activeLicenses: {
            paid: { total: 530, courtesyQty: 0, nextExpirationDate: new Date(now + 20 * DAY).toUTCString(), nextExpiringCount: 120 },
            trial: { total: 0, courtesyQty: 0, nextExpiringCount: 0 },
          },
          licensesUsed: { self: { paid: 6, trial: 0, total: 6 }, mspCustomers: { paid: 530, total: 530 } },
          licensesAvailable: { self: { paid: 0, trial: 0, total: 0 }, mspCustomers: { paid: 0, total: 0 } },
          outOfCompliance: { self: { total: 0 }, mspCustomers: { paid: 0, expiredServices: 0, total: 0 }, total: 0 },
          self: { usedSummary: [], totalConfigured: 6, totalLicensesUsed: 6 },
          mspEcSummary: { usedSummary: [], totalConfigured: 493, totalLicensesUsed: 493 },
        }],
      });
    }
    return json({}, 404);
  };
}

const DEMO_ACCOUNT = {
  id: 'demo',
  label: 'Demo',
  region: 'eu',
  tenantId: 'demo-tenant',
  clientId: 'demo',
  clientSecret: 'demo',
};

module.exports = { createDemoFetch, DEMO_ACCOUNT };
