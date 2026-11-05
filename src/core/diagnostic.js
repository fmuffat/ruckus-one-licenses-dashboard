'use strict';

// Fichier de diagnostic à partager pour analyser un vrai compte.
// Liste blanche : une chaîne n'est conservée que si sa clé est connue pour ne pas identifier
// un client. Tout le reste devient un pseudonyme stable. Les jetons et secrets ne sont jamais lus.

const MAX_ROWS = 25;
const MAX_EXCHANGES_PER_PATH = 5;

const KEPT_KEYS = new Set([
  'status', 'statusReason', 'accountType', 'serviceMode', 'tenantType', 'delegationType', 'type',
  'entitlementDeviceType', 'entitlementDeviceSubType', 'deviceType', 'deviceSubType', 'licenseType',
  'complianceType', 'usageType', 'sku', 'skuTier', 'licenseName', 'displayTier', 'accountTier',
  'fields', 'sortField', 'sortOrder', 'path', 'method', 'kind', 'state', 'scope', 'source',
  'key', 'whatKey', 'code', 'errorCode', 'generatedAt', 'appVersion', 'tier', 'tenantStatus',
]);
const DATE_KEY = /(date|time|ts)$|expir|effective/i;
const PERSONAL_NUMBER_KEY = /postal|zip|phone|mobile/i;

function createMasker() {
  const pseudonyms = new Map();
  const pseudonym = (value) => {
    if (!pseudonyms.has(value)) pseudonyms.set(value, `masque-${pseudonyms.size + 1}`);
    return pseudonyms.get(value);
  };
  const mask = (value, key = '') => {
    if (Array.isArray(value)) return value.map((item) => mask(item, key));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mask(v, k)]));
    }
    if (typeof value !== 'string') return value;
    if (KEPT_KEYS.has(key) || DATE_KEY.test(key)) return value;
    if (/^-?\d+(\.\d+)?$/.test(value) && !PERSONAL_NUMBER_KEY.test(key)) return value;
    return pseudonym(value);
  };
  return mask;
}

function truncateRows(body) {
  if (Array.isArray(body) && body.length > MAX_ROWS) return body.slice(0, MAX_ROWS);
  if (body && Array.isArray(body.data) && body.data.length > MAX_ROWS) {
    return { ...body, data: body.data.slice(0, MAX_ROWS), rowsOmitted: body.data.length - MAX_ROWS };
  }
  return body;
}

async function readBody(response) {
  try {
    return await response.clone().json();
  } catch {
    return { nonJsonResponse: true };
  }
}

// Enveloppe le fetch et garde chaque échange, sauf le contenu de l'authentification.
function createRecorder(fetchImpl) {
  const exchanges = [];
  const perPath = new Map();
  const recordingFetch = async (url, init = {}) => {
    const { pathname, search } = new URL(url);
    const response = await fetchImpl(url, init);
    if (pathname.startsWith('/oauth2/')) {
      exchanges.push({ path: '/oauth2/token/{tenantId}', method: init.method, responseStatus: response.status });
      return response;
    }
    const seen = perPath.get(pathname) || 0;
    perPath.set(pathname, seen + 1);
    if (seen < MAX_EXCHANGES_PER_PATH) {
      exchanges.push({
        path: `${pathname}${search}`,
        method: init.method,
        delegated: Boolean(init.headers?.['x-rks-tenantid']),
        requestBody: init.body ? JSON.parse(init.body) : null,
        responseStatus: response.status,
        responseBody: truncateRows(await readBody(response)),
      });
    }
    return response;
  };
  return { fetchImpl: recordingFetch, exchanges };
}

function summarizeResult(result) {
  return {
    fatal: result.fatal,
    sources: result.sources,
    customerCount: result.customers.length,
    inventory: result.inventory,
    customers: result.customers.slice(0, MAX_ROWS).map(({ accountId, accountLabel, ...customer }) => customer),
  };
}

function buildDiagnostic(runs, { appVersion, now = Date.now() }) {
  const mask = createMasker();
  return mask({
    generatedAt: new Date(now).toISOString(),
    appVersion,
    accounts: runs.map(({ result, exchanges }) => ({
      result: summarizeResult(result),
      exchanges,
    })),
  });
}

module.exports = { createRecorder, buildDiagnostic };
