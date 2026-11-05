'use strict';

// Client lecture seule de l'API RUCKUS One. Références : https://docs.ruckus.cloud/api
// Le secret ne sort jamais vers d'autres hôtes que ceux de cette table.

const {
  evaluateCustomer, compareCustomers, normalizeType, normalizeTier, tierFromLicense, parseDate,
} = require('./licenses');
const { buildInventory } = require('./inventory');
const { UserError } = require('./errors');

const REGIONS = {
  na: { auth: 'https://ruckus.cloud', api: 'https://api.ruckus.cloud' },
  eu: { auth: 'https://eu.ruckus.cloud', api: 'https://api.eu.ruckus.cloud' },
  asia: { auth: 'https://asia.ruckus.cloud', api: 'https://api.asia.ruckus.cloud' },
};

const PAGE_SIZE = 100;
const MAX_PAGES = 200;
const ENRICH_CONCURRENCY = 5;
const MAX_RETRIES = 3;

const TENANT_FIELDS = [
  'id', 'name', 'tenantType', 'status', 'statusReason', 'accountType', 'serviceMode',
  'expirationDate', 'entitlements', 'mspName', 'city', 'country', 'accountTier', 'displayTier',
];

const V2_JSON = 'application/vnd.ruckus.v2+json';
const KNOWN_API_ERRORS = new Set([400, 401, 403, 404, 429]);

function apiError(status, whatKey) {
  const key = KNOWN_API_ERRORS.has(status) ? `error.api.${status}` : 'error.api.other';
  return new UserError(key, { whatKey, status }, status);
}

class R1Client {
  constructor(account, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const region = REGIONS[account.region];
    if (!region) throw new UserError('error.noRegion');
    this.account = account;
    this.region = region;
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.token = null;
  }

  async authenticate() {
    const url = `${this.region.auth}/oauth2/token/${encodeURIComponent(this.account.tenantId)}`;
    let response;
    try {
      response = await this.fetch(url, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.account.clientId,
          client_secret: this.account.clientSecret,
        }).toString(),
      });
    } catch {
      throw new UserError('error.connection', { whatKey: 'source.auth' }, 0);
    }
    if (!response.ok) throw apiError(response.status, 'source.auth');
    const body = await response.json();
    if (!body.access_token) throw new UserError('error.noToken', { whatKey: 'source.auth' }, response.status);
    this.token = body.access_token;
  }

  post(path, body, options) {
    return this.send('POST', path, body, options);
  }

  async send(method, path, body, { whatKey, delegatedTenantId, mediaType = 'application/json' }) {
    if (!this.token) await this.authenticate();
    let refreshed = false;
    for (let attempt = 0; ; attempt += 1) {
      const headers = {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': mediaType,
        Accept: mediaType,
      };
      if (delegatedTenantId) headers['x-rks-tenantid'] = delegatedTenantId;
      let response;
      try {
        response = await this.fetch(`${this.region.api}${path}`, {
          method,
          redirect: 'error',
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch {
        throw new UserError('error.connection', { whatKey }, 0);
      }
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        await this.authenticate();
        continue;
      }
      if (response.status === 429 && attempt < MAX_RETRIES) {
        const wait = Number(response.headers?.get?.('retry-after'));
        await this.sleep((Number.isFinite(wait) && wait > 0 ? wait : 2 ** attempt) * 1000);
        continue;
      }
      if (!response.ok) throw apiError(response.status, whatKey);
      return response.json();
    }
  }

  async postPaged(path, baseBody, options) {
    const all = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const result = await this.post(path, { ...baseBody, page, pageSize: PAGE_SIZE }, options);
      // /delegations/query est documenté avec un objet unique : on accepte aussi un tableau nu.
      const rows = Array.isArray(result) ? result : result.data || [];
      all.push(...rows);
      const total = Array.isArray(result) ? rows.length : result.totalCount;
      if (rows.length === 0 || rows.length < PAGE_SIZE || (total !== undefined && all.length >= total)) break;
    }
    return all;
  }

  listTenants() {
    return this.postPaged('/tenants/query', {
      fields: TENANT_FIELDS,
      sortField: 'name',
      sortOrder: 'ASC',
    }, { whatKey: 'source.msp', mediaType: V2_JSON });
  }

  listDelegations() {
    return this.postPaged('/delegations/query?inclEntitlements=true', {}, { whatKey: 'source.var' });
  }

  async complianceSummary(delegatedTenantId) {
    const result = await this.post('/entitlements/compliances/query', { filters: {} }, {
      whatKey: 'source.stock',
      delegatedTenantId,
    });
    return result.data || [];
  }

  tenantSelf(delegatedTenantId) {
    return this.send('GET', '/tenants/self', undefined, { whatKey: 'source.var', delegatedTenantId });
  }

  listEntitlements(delegatedTenantId) {
    return this.postPaged('/entitlements/query', {}, { whatKey: 'source.lines', delegatedTenantId });
  }
}

function isManagedCustomerTenant(raw) {
  return !/INTEGRATOR|INSTALLER/i.test(raw.tenantType || '');
}

function isManagedDelegation(raw, selfTenantId) {
  if (raw.tenantId === selfTenantId) return false;
  if (/SUPPORT|INTEGRATOR|INSTALLER/i.test(`${raw.delegationType || ''} ${raw.type || ''}`)) return false;
  return !/REJECT|REVOK|CANCEL|INVITED|PENDING/i.test(raw.status || '');
}

function customerFromTenant(raw) {
  return {
    id: raw.id,
    name: raw.name || raw.mspecName,
    kind: 'MSP',
    tier: normalizeTier(raw.accountTier),
    accountType: raw.accountType || raw.serviceMode,
    tenantStatus: raw.status,
    serviceExpiry: raw.expirationDate,
    rawLines: raw.entitlements,
  };
}

function customerFromDelegation(raw) {
  return {
    id: raw.tenantId,
    name: raw.tenantName,
    kind: 'VAR',
    tenantStatus: raw.status,
    rawLines: raw.entitlements,
    serviceExpiry: raw.entitlements?.length ? null : raw.earlyExpirationDate,
  };
}

function usedFromCompliances(compliances) {
  const used = {};
  for (const item of compliances) {
    const count = Number(item.self?.totalLicensesUsed ?? item.licensesUsed?.self?.total);
    // Zéro n'apporte rien et créerait une ligne vide pour un type que le client n'a pas.
    if (count > 0) used[normalizeType(item.licenseType)] = count;
  }
  return used;
}

async function mapLimited(items, limit, task) {
  let index = 0;
  const worker = async () => {
    while (index < items.length) {
      const i = index;
      index += 1;
      await task(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Une source en échec ne bloque pas les autres : un compte peut être MSP sans être VAR.
async function runSource(sources, source, task) {
  try {
    const value = await task();
    sources.push({ source, ok: true, count: Array.isArray(value) ? value.length : null });
    return value;
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    sources.push({ source, ok: false, status: error.status, error: error.toMessage() });
    return null;
  }
}

// Niveaux des licences encore valables : c'est ce qui couvre le client aujourd'hui.
function activeLicenseTiers(lines, now) {
  const active = lines.filter((line) => {
    const end = parseDate(line.expirationDate);
    return end === null || end >= now;
  });
  return [...new Set(active.map(tierFromLicense).filter(Boolean))];
}

// Détail d'un client VAR, lu chez lui. La délégation donne les quantités, mais ni SKU ni niveau.
async function enrichDelegated(client, customer, now) {
  const hasInlineLines = Boolean(customer.rawLines?.length);
  try {
    const self = await client.tenantSelf(customer.id);
    customer.tier = normalizeTier(self?.accountTier);
  } catch (error) {
    // Le niveau est un complément : son absence ne doit pas masquer les licences.
    if (!(error instanceof UserError)) throw error;
  }
  try {
    const lines = await client.listEntitlements(customer.id);
    customer.licenseTiers = activeLicenseTiers(lines, now);
    if (hasInlineLines) return true;
    customer.rawLines = lines;
    if (lines.length) customer.serviceExpiry = null;
    customer.usedByType = usedFromCompliances(await client.complianceSummary(customer.id));
    return true;
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    if (hasInlineLines) return true;
    customer.note = error.toMessage();
    return false;
  }
}

async function collectAccount(account, options = {}) {
  const now = options.now ?? Date.now();
  const client = new R1Client(account, options);
  const sources = [];

  // Sans authentification, aucune source ne peut répondre : on remonte l'erreur une seule fois.
  try {
    await client.authenticate();
  } catch (error) {
    if (!(error instanceof UserError)) throw error;
    return { accountId: account.id, label: account.label, customers: [], inventory: null, sources, fatal: error.toMessage() };
  }

  const compliances = await runSource(sources, 'stock', () => client.complianceSummary());
  const ownEntitlements = await runSource(sources, 'lines', () => client.listEntitlements());
  const tenants = await runSource(sources, 'msp', () => client.listTenants());
  const delegations = await runSource(sources, 'var', () => client.listDelegations());

  const customers = new Map();
  for (const raw of tenants || []) {
    if (raw.id && raw.id !== account.tenantId && isManagedCustomerTenant(raw)) {
      customers.set(raw.id, customerFromTenant(raw));
    }
  }

  const delegated = [];
  for (const raw of delegations || []) {
    // Un client MSP existe aussi sous forme de délégation : le tenant fait foi.
    if (raw.tenantId && !customers.has(raw.tenantId) && isManagedDelegation(raw, account.tenantId)) {
      const customer = customerFromDelegation(raw);
      customers.set(raw.tenantId, customer);
      delegated.push(customer);
    }
  }

  let failedEnrichments = 0;
  await mapLimited(delegated, ENRICH_CONCURRENCY, async (c) => {
    if (!(await enrichDelegated(client, c, now))) failedEnrichments += 1;
  });
  if (failedEnrichments > 0) {
    sources.push({
      source: 'varDetails',
      ok: false,
      error: { key: 'error.varDetails', params: { count: failedEnrichments, total: delegated.length } },
    });
  }

  const evaluated = [...customers.values()].map((c) => ({
    ...evaluateCustomer(c, now),
    accountId: account.id,
    accountLabel: account.label,
  }));
  evaluated.sort(compareCustomers);

  return {
    accountId: account.id,
    label: account.label,
    customers: evaluated,
    inventory: buildInventory(compliances || [], ownEntitlements || [], now, tenants && tenants.filter(isManagedCustomerTenant)),
    sources,
    fatal: null,
  };
}

module.exports = { REGIONS, R1Client, collectAccount };
