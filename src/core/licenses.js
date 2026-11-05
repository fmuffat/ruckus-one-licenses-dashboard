'use strict';

// Règles de statut des licences. Aucune dépendance à Electron ni au réseau.
// Les textes sont produits sous forme { key, params } : la traduction se fait à l'affichage.

const WARN_MONTHS = 6;
const DAY_MS = 86400000;

function addMonths(ms, months) {
  const d = new Date(ms);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d.getTime();
}

// L'API renvoie selon les champs un ISO 8601, une date seule ou des millisecondes en texte.
function parseDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).trim();
  if (/^\d{10,}$/.test(text)) return Number(text);
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) return null;
  // Une date seule reste valable jusqu'à la fin de cette journée.
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? ms + DAY_MS - 1 : ms;
}

function toInt(value) {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? 0 : n;
}

// RUCKUS ne nomme pas les niveaux : Platinum = Professional, Gold = Essentials.
const TIER_CODES = { platinum: 'pro', gold: 'essentials' };

function normalizeTier(raw) {
  return TIER_CODES[String(raw || '').toLowerCase()] || null;
}

// Le SKU fait foi (CLD-PROF-…, CLR-ESNT-…) ; skuTier sert de repli.
function tierFromLicense({ sku, skuTier }) {
  if (/-PROF-/i.test(sku || '')) return 'pro';
  if (/-ESNT-/i.test(sku || '')) return 'essentials';
  return normalizeTier(skuTier);
}

function normalizeType(raw) {
  if (!raw) return 'UNKNOWN';
  return String(raw).toUpperCase().replace(/^DVCNWTYPE_/, '').replace(/^MSP_/, '').replace(/_TEMP$/, '');
}

const DEVICE_COUNT_FIELDS = ['wifiDeviceCount', 'switchDeviceCount', 'edgeDeviceCount', 'virtualEdgeDeviceCount', 'rwgDeviceCount', 'iotCtrlDeviceCount'];

function normalizeLine(raw) {
  // Sans licence active, consumed peut rester à 0 alors que des équipements en réclament toujours.
  const devices = DEVICE_COUNT_FIELDS.reduce((sum, field) => sum + toInt(raw[field]), 0);
  return {
    type: normalizeType(raw.entitlementDeviceType || raw.deviceType || raw.licenseType),
    quantity: toInt(raw.quantity),
    consumed: Math.max(toInt(raw.consumed), devices),
    expiresAt: parseDate(raw.expirationDate) ?? parseDate(raw.expirationDateTs),
    outOfCompliance: toInt(raw.outOfComplianceDevices),
    futureOutOfCompliance: toInt(raw.futureOutOfComplianceDevices),
    futureOutOfComplianceAt: parseDate(raw.futureOfComplianceDate),
  };
}

function evaluateType(type, lines, usedOverride, now, limit) {
  const active = lines.filter((l) => l.expiresAt === null || l.expiresAt >= now);
  const activeQty = active.reduce((sum, l) => sum + l.quantity, 0);
  const expiredQty = lines.reduce((sum, l) => sum + (active.includes(l) ? 0 : l.quantity), 0);
  const used = usedOverride ?? lines.reduce((sum, l) => sum + l.consumed, 0);
  const reportedShort = lines.reduce((sum, l) => sum + l.outOfCompliance, 0);
  const shortage = Math.max(0, used - activeQty, reportedShort);

  // Déroule les expirations à venir pour trouver quand le stock passera sous l'usage.
  let future = null;
  let remaining = activeQty;
  const upcoming = active
    .filter((l) => l.expiresAt !== null && l.expiresAt <= limit)
    .sort((a, b) => a.expiresAt - b.expiresAt);
  for (const line of upcoming) {
    remaining -= line.quantity;
    // Si tout le stock expire, le statut orange le dit déjà : seul un stock partiel est signalé ici.
    if (used > remaining && remaining > 0) {
      future = { count: used - remaining, at: line.expiresAt };
      break;
    }
  }
  for (const line of lines) {
    const at = line.futureOutOfComplianceAt;
    // RUCKUS renseigne ce champ dès qu'un client a des équipements, à la date de fin de sa licence.
    // Il ne compte donc que dans la fenêtre d'alerte, et si une partie du stock survit à cette date.
    const outOfWindow = at !== null && at > limit;
    const stockSurvives = at === null || active.some((l) => l.expiresAt === null || l.expiresAt > at);
    if (line.futureOutOfCompliance > 0 && !outOfWindow && stockSurvives
      && (!future || line.futureOutOfCompliance > future.count)) {
      future = { count: line.futureOutOfCompliance, at: at ?? future?.at ?? null };
    }
  }

  const expiringQty = upcoming.reduce((sum, l) => sum + l.quantity, 0);
  return {
    type,
    activeQty,
    expiredQty,
    expiringQty,
    used,
    shortage,
    future: shortage > 0 ? null : future,
    nextExpiry: upcoming.length ? upcoming[0].expiresAt : null,
  };
}

function buildRecommendations({ status, serviceExpiry, lastExpiredAt, types }) {
  const recos = [];
  for (const t of types) {
    const allExpired = t.activeQty === 0 && t.expiredQty > 0;
    if (allExpired) {
      recos.push({ key: 'reco.renewExpired', params: { count: Math.max(t.used, t.expiredQty), type: t.type } });
    } else if (t.shortage > 0) {
      recos.push({ key: 'reco.add', params: { count: t.shortage, type: t.type, used: t.used, active: t.activeQty } });
    }
    if (t.future) {
      recos.push(t.future.at
        ? { key: 'reco.planAt', params: { count: t.future.count, type: t.type, date: t.future.at } }
        : { key: 'reco.plan', params: { count: t.future.count, type: t.type } });
    }
    if (t.expiringQty > 0) {
      recos.push({ key: 'reco.renewBefore', params: { count: t.expiringQty, type: t.type, date: t.nextExpiry } });
    }
  }
  if (status === 'expired' && serviceExpiry !== null && serviceExpiry === lastExpiredAt) {
    recos.push({ key: 'reco.serviceEnded', params: { date: serviceExpiry } });
  }
  return recos;
}

// customer : { id, name, kind, accountType, tenantStatus, serviceExpiry, rawLines, usedByType, note }
function evaluateCustomer(customer, now = Date.now()) {
  const limit = addMonths(now, WARN_MONTHS);
  // Le tenant liste parfois chaque type d'équipement avec une quantité nulle.
  const lines = (customer.rawLines || [])
    .map(normalizeLine)
    .filter((l) => l.quantity > 0 || l.consumed > 0);
  const serviceExpiry = parseDate(customer.serviceExpiry);
  const usedByType = customer.usedByType || {};

  const typeNames = new Set([...lines.map((l) => l.type), ...Object.keys(usedByType)]);
  const types = [...typeNames].sort().map((type) =>
    evaluateType(type, lines.filter((l) => l.type === type), usedByType[type], now, limit));

  const activeLines = lines.filter((l) => l.expiresAt === null || l.expiresAt >= now);
  const expiredDates = lines.filter((l) => !activeLines.includes(l)).map((l) => l.expiresAt);
  const serviceExpired = serviceExpiry !== null && serviceExpiry < now;
  if (serviceExpired) expiredDates.push(serviceExpiry);
  const lastExpiredAt = expiredDates.length ? Math.max(...expiredDates) : null;

  const futureDates = activeLines.map((l) => l.expiresAt).filter((d) => d !== null);
  if (serviceExpiry !== null && !serviceExpired) futureDates.push(serviceExpiry);
  const nextExpiry = futureDates.length ? Math.min(...futureDates) : null;

  // Un tenant désactivé ne pose plus de problème de conformité, quelles que soient ses dates.
  const disabled = /not active|inactive/i.test(customer.tenantStatus || '');
  let status;
  if (disabled) status = 'disabled';
  else if (lines.length === 0 && serviceExpiry === null) status = 'unknown';
  else if (serviceExpired || (lines.length > 0 && activeLines.length === 0)) status = 'expired';
  else if (nextExpiry !== null && nextExpiry <= limit) status = 'expiring';
  else status = 'ok';

  const hasUsage = types.length > 0;
  const shortage = types.reduce((sum, t) => sum + t.shortage, 0);
  const futures = types.filter((t) => t.future);
  const futureCount = futures.reduce((sum, t) => sum + t.future.count, 0);
  const futureDatesKnown = futures.map((t) => t.future.at).filter((d) => d !== null);
  const capacity = !hasUsage || disabled
    ? { state: 'unknown', count: 0, at: null }
    : shortage > 0
      ? { state: 'short', count: shortage, at: null }
      : futureCount > 0
        ? { state: 'soon', count: futureCount, at: futureDatesKnown.length ? Math.min(...futureDatesKnown) : null }
        : { state: 'ok', count: 0, at: null };

  const totalUsed = types.reduce((sum, t) => sum + t.used, 0);
  // Sans lecture possible des licences (note d'erreur), on ne peut rien conclure sur les équipements.
  const noDevice = status === 'expired' && totalUsed === 0 && !customer.note;
  let recommendations = [];
  if (noDevice) recommendations = [{ key: 'reco.emptyTenant' }];
  else if (!disabled) recommendations = buildRecommendations({ status, serviceExpiry, lastExpiredAt, types });
  // Une licence Pro peut couvrir un client Essentials, mais pas l'inverse.
  const licenseTiers = customer.licenseTiers || [];
  const tierMismatch = !disabled && customer.tier === 'pro' && licenseTiers.length > 0 && licenseTiers.every((tier) => tier === 'essentials');
  if (tierMismatch && status !== 'expired') recommendations.push({ key: 'reco.tierMismatch' });
  if (status === 'expiring' && serviceExpiry !== null && serviceExpiry === nextExpiry) {
    // Les licences d'un client finissent avec son tenant : c'est lui qu'il faut prolonger.
    recommendations = recommendations.filter((r) => !(r.key === 'reco.renewBefore' && r.params.date === serviceExpiry));
    recommendations.push({ key: 'reco.serviceBefore', params: { date: serviceExpiry } });
  }

  return {
    id: customer.id,
    name: customer.name || '',
    kind: customer.kind,
    tier: customer.tier || null,
    tierMismatch,
    accountType: customer.accountType || null,
    tenantStatus: customer.tenantStatus || null,
    status,
    nextExpiry,
    lastExpiredAt,
    daysLeft: nextExpiry === null ? null : Math.ceil((nextExpiry - now) / DAY_MS),
    totalActive: types.reduce((sum, t) => sum + t.activeQty, 0),
    totalUsed,
    noDevice,
    capacity,
    types,
    recommendations,
    note: customer.note || null,
  };
}

const STATUS_RANK = { expired: 0, expiring: 1, unknown: 2, ok: 3, disabled: 4 };

function compareCustomers(a, b) {
  return STATUS_RANK[a.status] - STATUS_RANK[b.status]
    || (a.nextExpiry ?? Infinity) - (b.nextExpiry ?? Infinity)
    || a.name.localeCompare(b.name);
}

module.exports = {
  WARN_MONTHS,
  addMonths,
  parseDate,
  normalizeType,
  normalizeTier,
  tierFromLicense,
  evaluateCustomer,
  compareCustomers,
};
