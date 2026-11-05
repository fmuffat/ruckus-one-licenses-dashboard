'use strict';

const { t, translate } = require('../shared/i18n');

// Noms de gamme RUCKUS : identiques dans toutes les langues.
const TIER_NAMES = { pro: 'Professional', essentials: 'Essentials' };

function cell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  // Empêche Excel d'interpréter un nom de client comme une formule.
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[";\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function isoDate(ms) {
  return ms === null || ms === undefined ? '' : new Date(ms).toISOString().slice(0, 10);
}

function capacityText(language, state) {
  if (state === 'short' || state === 'soon') return t(language, `csv.capacity.${state}`);
  return t(language, `capacity.${state}`);
}

// Point-virgule et BOM : Excel ouvre ainsi le fichier directement sur un poste européen.
function customersToCsv(customers, language) {
  const header = ['client', 'type', 'account', 'status', 'nextExpiry', 'lastExpiry', 'daysLeft', 'used', 'active',
    'capacity', 'missing', 'recommendations', 'tier'].map((name) => t(language, `csv.${name}`));
  const rows = customers.map((c) => [
    c.name || t(language, 'customer.noName'), c.kind, c.accountLabel, t(language, `status.${c.status}`),
    isoDate(c.nextExpiry), isoDate(c.lastExpiredAt), c.daysLeft, c.totalUsed, c.totalActive,
    capacityText(language, c.capacity.state), c.capacity.count || '',
    c.recommendations.map((r) => translate(language, r)).join(' '),
    TIER_NAMES[c.tier] || '',
  ]);
  return `﻿${[header, ...rows].map((row) => row.map(cell).join(';')).join('\r\n')}\r\n`;
}

module.exports = { customersToCsv };
