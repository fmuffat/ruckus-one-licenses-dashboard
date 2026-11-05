'use strict';

// Licences détenues par le compte connecté : stock par type et détail ligne par ligne.

const { WARN_MONTHS, addMonths, parseDate, normalizeType, tierFromLicense } = require('./licenses');

function count(value) {
  const n = Number(value);
  return value === null || value === undefined || Number.isNaN(n) ? null : n;
}

// La réponse réelle de /entitlements/compliances/query diffère du schéma publié par RUCKUS.
// Recoupé sur un vrai compte MSP : licensesUsed.mspCustomers = somme des licences assignées aux clients,
// mspEcSummary.totalLicensesUsed = somme des licences consommées par leurs équipements.
function rowFromCompliance(item) {
  const paid = item.activeLicenses?.paid || {};
  const usedSelf = count(item.self?.totalLicensesUsed);
  const usedCustomers = count(item.mspEcSummary?.totalLicensesUsed);
  const used = usedSelf === null && usedCustomers === null
    ? count(item.licensesUsed?.self?.total)
    : (usedSelf ?? 0) + (usedCustomers ?? 0);
  return {
    type: normalizeType(item.licenseType),
    active: count(paid.total) ?? 0,
    courtesy: count(paid.courtesyQty) ?? 0,
    trial: count(item.activeLicenses?.trial?.total) ?? 0,
    used,
    assigned: count(item.licensesUsed?.mspCustomers?.total),
    available: count(item.licensesAvailable?.mspCustomers?.total ?? item.licensesAvailable?.self?.total),
    shortage: count(item.outOfCompliance?.total) ?? 0,
    nextExpiry: parseDate(paid.nextExpirationDate),
    nextExpiringCount: count(paid.nextExpiringCount) ?? 0,
  };
}

function isEmptyRow(row) {
  return !row.active && !row.trial && !row.used && !row.assigned;
}

function lineStatus(startsAt, expiresAt, now, limit) {
  if (expiresAt !== null && expiresAt < now) return 'expired';
  if (startsAt !== null && startsAt > now) return 'future';
  if (expiresAt !== null && expiresAt <= limit) return 'expiring';
  return 'ok';
}

const LINE_RANK = { expiring: 0, ok: 1, future: 2, expired: 3 };

function buildLines(rawEntitlements, now) {
  const limit = addMonths(now, WARN_MONTHS);
  return rawEntitlements
    .map((raw) => {
      const startsAt = parseDate(raw.effectiveDate);
      const expiresAt = parseDate(raw.expirationDate);
      return {
        name: raw.licenseName || raw.sku || null,
        sku: raw.sku || null,
        tier: tierFromLicense(raw),
        type: normalizeType(raw.deviceType || raw.entitlementDeviceType || raw.licenseType),
        quantity: count(raw.quantity) ?? 0,
        startsAt,
        expiresAt,
        trial: Boolean(raw.trialSku || raw.tempLicense || raw.isTrial),
        status: lineStatus(startsAt, expiresAt, now, limit),
      };
    })
    .filter((line) => line.quantity > 0)
    .sort((a, b) => LINE_RANK[a.status] - LINE_RANK[b.status]
      || (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
}

// Sans réponse de conformité, les lignes donnent quand même le stock, mais pas l'utilisation.
function rowsFromLines(lines) {
  const byType = new Map();
  for (const line of lines) {
    if (line.status === 'expired' || line.status === 'future') continue;
    const row = byType.get(line.type) || {
      type: line.type,
      active: 0,
      courtesy: 0,
      trial: 0,
      used: null,
      assigned: null,
      available: null,
      shortage: 0,
      nextExpiry: null,
      nextExpiringCount: 0,
    };
    if (line.trial) row.trial += line.quantity;
    else row.active += line.quantity;
    if (line.expiresAt !== null && (row.nextExpiry === null || line.expiresAt < row.nextExpiry)) {
      row.nextExpiry = line.expiresAt;
      row.nextExpiringCount = line.quantity;
    } else if (line.expiresAt !== null && line.expiresAt === row.nextExpiry) {
      row.nextExpiringCount += line.quantity;
    }
    byType.set(line.type, row);
  }
  return [...byType.values()];
}

// Licences attribuées aux clients MSP : payantes seulement, comme le graphique de RUCKUS One.
function assignmentsFromTenants(tenants) {
  const assignments = [];
  for (const tenant of tenants) {
    for (const raw of tenant.entitlements || []) {
      const quantity = count(raw.quantity) ?? 0;
      if (quantity > 0 && !/TRIAL/i.test(raw.accountType || '')) {
        assignments.push({
          type: normalizeType(raw.entitlementDeviceType),
          quantity,
          expiresAt: parseDate(raw.expirationDate) ?? parseDate(raw.expirationDateTs),
          name: tenant.name || tenant.mspecName || null,
        });
      }
    }
  }
  return assignments;
}

const MAX_EVENTS = 8;

// Évolution du stock face aux licences attribuées. Les mois suivent le modèle de RUCKUS One
// (valeur au dernier jour du mois, jusqu'à fin d'année + 2) ; le manque est cherché à la date exacte.
function buildForecast(row, lines, assignments, now) {
  // Une licence REC appartient à un client final : elle n'alimente jamais le stock MSP.
  const paid = lines.filter((l) => l.type === row.type && !l.trial && !/-REC/i.test(l.sku || ''));
  const assigned = assignments.filter((a) => a.type === row.type);

  const activeAt = (t) => {
    const base = paid
      .filter((l) => (l.startsAt === null || l.startsAt <= t) && (l.expiresAt === null || l.expiresAt >= t))
      .reduce((sum, l) => sum + l.quantity, 0);
    // L'API ne donne pas de date pour la courtoisie : on la suppose liée aux licences actives.
    return base > 0 ? base + row.courtesy : 0;
  };
  const assignedAt = (t) => assigned
    .filter((a) => a.expiresAt === null || a.expiresAt >= t)
    .reduce((sum, a) => sum + a.quantity, 0);

  const start = new Date(now);
  const months = [];
  const monthCount = 12 - start.getUTCMonth() + 24;
  for (let i = 0; i < monthCount; i += 1) {
    const at = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i + 1, 0, 23, 59, 59, 999);
    months.push({ at, active: activeAt(at), assigned: assignedAt(at) });
  }
  const horizon = months[months.length - 1].at;

  const paidEnds = [...new Set(paid.map((l) => l.expiresAt))]
    .filter((d) => d !== null && d > now && d <= horizon)
    .sort((a, b) => a - b);
  let gap = null;
  for (const at of [now, ...paidEnds]) {
    const checked = at === now ? now : at + 1;
    const active = activeAt(checked);
    const demand = assignedAt(checked);
    if (demand > active) {
      gap = { at, active, assigned: demand, missing: demand - active };
      break;
    }
  }

  const events = [
    ...paidEnds.map((at) => ({
      at,
      kind: 'active',
      count: paid.filter((l) => l.expiresAt === at).reduce((sum, l) => sum + l.quantity, 0),
      name: null,
    })),
    ...assigned
      .filter((a) => a.expiresAt !== null && a.expiresAt > now && a.expiresAt <= horizon)
      .map((a) => ({ at: a.expiresAt, kind: 'assigned', count: a.quantity, name: a.name })),
  ].sort((a, b) => a.at - b.at).slice(0, MAX_EVENTS);

  return { months, gap, events };
}

function buildInventory(compliances, rawEntitlements, now, tenants = null) {
  const lines = buildLines(rawEntitlements, now);
  const found = compliances.map(rowFromCompliance).filter((row) => !isEmptyRow(row));
  const rows = found.length ? found : rowsFromLines(lines);
  const assignments = tenants ? assignmentsFromTenants(tenants) : null;
  return {
    // Sans liste de clients, ou hors compte MSP, on ne peut pas prévoir les licences attribuées.
    rows: rows.map((row) => ({
      ...row,
      forecast: assignments && row.assigned !== null ? buildForecast(row, lines, assignments, now) : null,
    })),
    lines,
  };
}

module.exports = { buildInventory };
