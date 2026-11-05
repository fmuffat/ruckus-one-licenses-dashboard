'use strict';

// Traduit l'état des licences en liste d'actions pour le back-office.

const { addMonths, WARN_MONTHS } = require('./licenses');

const DAY_MS = 86400000;
const URGENT_DAYS = 60;

const LEVEL_RANK = { warning: 0, planned: 1, urgent: 2, mandatory: 3 };

function customerTask(customer, now) {
  const reasons = [];
  let level = null;
  const raise = (candidate) => {
    if (level === null || LEVEL_RANK[candidate] > LEVEL_RANK[level]) level = candidate;
  };

  if (customer.status === 'disabled') return null;

  if (customer.status === 'expired') {
    reasons.push({ key: 'item.expired', params: { date: customer.lastExpiredAt } });
    // Le vrai risque : des licences restent requises alors qu'aucune n'est plus active.
    if (customer.capacity.state === 'short') {
      reasons.push({ key: 'item.short', params: { count: customer.capacity.count } });
      raise('mandatory');
    } else if (customer.noDevice) {
      reasons.push({ key: 'item.noDevice' });
      raise('warning');
    } else {
      raise('urgent');
    }
  } else if (customer.status === 'expiring') {
    reasons.push({ key: 'item.expiring', params: { date: customer.nextExpiry, days: customer.daysLeft } });
    raise(customer.daysLeft <= URGENT_DAYS ? 'urgent' : 'planned');
  }

  if (customer.status !== 'expired') {
    const { state, count, at } = customer.capacity;
    if (state === 'short') {
      reasons.push({ key: 'item.short', params: { count } });
      raise('mandatory');
    } else if (state === 'soon') {
      reasons.push(at
        ? { key: 'item.soon', params: { count, date: at } }
        : { key: 'item.short', params: { count } });
      raise(at !== null && at - now <= URGENT_DAYS * DAY_MS ? 'urgent' : 'planned');
    }
  }

  if (customer.tierMismatch && customer.status !== 'expired') {
    reasons.push({ key: 'item.tierMismatch' });
    raise('urgent');
  }

  if (!level) return null;
  return {
    type: 'customer',
    level,
    kind: customer.kind,
    tier: customer.tier,
    name: customer.name,
    accountId: customer.accountId,
    customerId: customer.id,
    reasons,
    actions: customer.recommendations,
    sortAt: customer.status === 'expired' ? customer.lastExpiredAt : customer.nextExpiry ?? customer.capacity.at ?? Infinity,
  };
}

function stockTask(result, row, now) {
  const { gap } = row.forecast;
  const immediate = gap.at <= now;
  const params = { count: gap.missing, type: row.type, assigned: gap.assigned, active: gap.active };
  return {
    type: 'stock',
    level: immediate ? 'mandatory' : gap.at <= addMonths(now, WARN_MONTHS) ? 'urgent' : 'planned',
    accountLabel: result.label,
    reasons: [immediate
      ? { key: 'forecast.gapNow', params }
      : { key: 'forecast.gapAt', params: { ...params, date: gap.at, days: Math.ceil((gap.at - now) / DAY_MS) } }],
    actions: [immediate
      ? { key: 'item.orderNow', params: { count: gap.missing } }
      : { key: 'item.orderBefore', params: { count: gap.missing, date: gap.at } }],
    sortAt: gap.at,
  };
}

function buildTasks(results, now = Date.now()) {
  const tasks = [];
  let okCount = 0;
  for (const result of results) {
    for (const row of result.inventory?.rows || []) {
      if (row.forecast?.gap) tasks.push(stockTask(result, row, now));
    }
    for (const customer of result.customers) {
      const task = customerTask(customer, now);
      if (task) tasks.push(task);
      else if (customer.status !== 'disabled') okCount += 1;
    }
  }
  const ofLevel = (level) => tasks
    .filter((task) => task.level === level)
    .sort((a, b) => (a.type === 'stock' ? -1 : 0) - (b.type === 'stock' ? -1 : 0) || a.sortAt - b.sortAt);
  return {
    mandatory: ofLevel('mandatory'),
    urgent: ofLevel('urgent'),
    planned: ofLevel('planned'),
    warning: ofLevel('warning'),
    okCount,
  };
}

module.exports = { buildTasks };
