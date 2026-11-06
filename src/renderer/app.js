'use strict';

const i18n = window.R1I18n;
const LANGUAGE_STORAGE_KEY = 'r1-language';

// Pages servies par des données : les clients MSP et VAR partagent le même gabarit.
const CLIENT_PAGES = { msp: 'MSP', var: 'VAR' };

const state = {
  language: i18n.DEFAULT_LANGUAGE,
  page: 'home',
  regions: [],
  accounts: [],
  payload: null,
  demo: false,
  loading: false,
  diagnosticRunning: false,
  savingAccount: false,
  diagnosticPath: null,
  // Les erreurs restent en { key, params } pour suivre un changement de langue.
  loadError: null,
  actionError: null,
  formError: null,
  status: null,
  capacity: null,
  search: '',
  accountId: 'all',
  expanded: new Set(),
  inventoryOpen: new Set(),
  update: null,
  updateStarted: false,
};

// Noms de gamme RUCKUS : identiques dans toutes les langues.
const TIER_NAMES = { pro: 'Professional', essentials: 'Essentials' };

const $ = (id) => document.getElementById(id);
const t = (key, params) => i18n.t(state.language, key, params);
const typeLabel = (type) => i18n.typeLabel(state.language, type);
const formatDate = (ms) => i18n.formatDate(state.language, ms);
const displayName = (customer) => customer.name || t('customer.noName');

function formatDays(days) {
  if (days === 0) return t('days.today');
  if (days === 1) return t('days.tomorrow');
  return t('days.in', { days });
}

// Ajoute à un message la formulation du délai, qui dépend de la langue.
function tm(message) {
  const params = message.params || {};
  return i18n.translate(state.language, params.days === undefined
    ? message
    : { key: message.key, params: { ...params, when: formatDays(params.days) } });
}

// Tout passe par textContent : les noms de clients viennent de l'API et ne sont pas de confiance.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child !== null && child !== undefined) node.append(child);
  }
  return node;
}

function daysSince(ms) {
  return Math.floor((Date.now() - ms) / 86400000);
}

// Appelle le processus principal et ramène les erreurs sous la forme { key, params }.
async function call(promise) {
  let response;
  try {
    response = await promise;
  } catch (error) {
    response = { ok: false, error: { key: 'error.unexpected', params: { message: String(error?.message || error) } } };
  }
  if (!response.ok) {
    const failure = new Error(response.error.key);
    failure.userMessage = response.error;
    throw failure;
  }
  return response.value;
}

function allCustomers() {
  return state.payload ? state.payload.results.flatMap((r) => r.customers) : [];
}

function pageCustomers() {
  const kind = CLIENT_PAGES[state.page];
  return allCustomers().filter((c) => c.kind === kind && (state.accountId === 'all' || c.accountId === state.accountId));
}

function visibleCustomers() {
  const query = state.search.trim().toLocaleLowerCase();
  return pageCustomers().filter((c) =>
    (!state.status || c.status === state.status)
    && (!state.capacity || c.capacity.state === 'short' || c.capacity.state === 'soon')
    && (!query || displayName(c).toLocaleLowerCase().includes(query)));
}

function goTo(page) {
  state.page = page;
  state.status = null;
  state.capacity = null;
  state.search = '';
  state.accountId = 'all';
  $('search').value = '';
  render();
  $('content').scrollTop = 0;
}

// ----- Page « À traiter » -----

function openTask(task) {
  if (task.type === 'stock') {
    goTo('licenses');
    return;
  }
  goTo(task.kind.toLowerCase());
  const key = `${task.accountId}:${task.customerId}`;
  state.expanded.add(key);
  renderRows();
  document.querySelector(`[data-row="${CSS.escape(key)}"]`)?.scrollIntoView({ block: 'center' });
}

function taskItem(task) {
  const title = task.type === 'stock'
    ? `${t('nav.licenses')} · ${task.accountLabel}`
    : task.name || t('customer.noName');
  const head = el('span', { class: 'task-title' }, title);
  if (task.kind) head.append(el('span', { class: 'tag' }, task.kind));
  if (task.tier) head.append(el('span', { class: `tag tag-${task.tier}` }, TIER_NAMES[task.tier]));
  return el('li', {}, el('button', {
    type: 'button',
    class: `task task-${task.level}`,
    onclick: () => openTask(task),
  },
  head,
  el('span', { class: 'task-reason' }, task.reasons.map(tm).join(' · ')),
  task.actions.length ? el('span', { class: 'task-action' }, task.actions.map(tm).join(' ')) : null));
}

function taskGroup(titleKey, tasks, hintKey = null) {
  if (!tasks.length) return null;
  return el('section', { class: 'task-group' },
    el('h2', {}, `${t(titleKey)} (${tasks.length})`),
    hintKey ? el('p', { class: 'task-group-hint' }, t(hintKey)) : null,
    el('ul', { class: 'tasks' }, ...tasks.map(taskItem)));
}

function renderHome() {
  const { mandatory, urgent, planned, warning, okCount } = state.payload.tasks;
  const stat = (tone, value, key) => el('div', { class: `tile tone-${tone}` },
    el('strong', {}, String(value)), el('span', {}, t(key)));
  $('home-stats').replaceChildren(
    stat('mandatory', mandatory.length, 'home.mandatory'),
    stat('expired', urgent.length, 'home.urgent'),
    stat('expiring', planned.length, 'home.planned'),
    stat('unknown', warning.length, 'home.warning'),
    stat('ok', okCount, 'home.statOk'));
  const groups = [
    taskGroup('home.mandatory', mandatory, 'home.mandatoryHint'),
    taskGroup('home.urgent', urgent),
    taskGroup('home.planned', planned),
    taskGroup('home.warning', warning),
  ].filter(Boolean);
  if (!groups.length) groups.push(el('p', { class: 'all-good' }, t('home.allGood')));
  $('home-tasks').replaceChildren(...groups);
}

// ----- Pages clients -----

function renderTiles() {
  const customers = pageCustomers();
  const tiles = $('tiles');
  tiles.replaceChildren();
  for (const status of ['expired', 'expiring', 'ok', 'unknown', 'disabled']) {
    const value = customers.filter((c) => c.status === status).length;
    if ((status === 'unknown' || status === 'disabled') && value === 0) continue;
    tiles.append(el('button', {
      type: 'button',
      class: `tile tone-${status}`,
      'aria-pressed': String(state.status === status),
      onclick: () => {
        state.status = state.status === status ? null : status;
        render();
      },
    }, el('strong', {}, String(value)), el('span', {}, t(`tile.${status}`))));
  }
  const missing = customers.filter((c) => c.capacity.state === 'short' || c.capacity.state === 'soon').length;
  tiles.append(el('button', {
    type: 'button',
    class: 'tile tone-expired',
    'aria-pressed': String(Boolean(state.capacity)),
    onclick: () => {
      state.capacity = !state.capacity;
      render();
    },
  }, el('strong', {}, String(missing)), el('span', {}, t('tile.capacity'))));
}

function dueCell(c) {
  if (c.lastExpiredAt !== null && (c.status === 'expired' || c.status === 'disabled')) {
    return el('td', { class: 'due' }, formatDate(c.lastExpiredAt),
      el('small', {}, t('days.ago', { days: daysSince(c.lastExpiredAt) })));
  }
  if (c.nextExpiry === null) return el('td', { class: 'due muted' }, '—');
  return el('td', { class: 'due' }, formatDate(c.nextExpiry), el('small', {}, formatDays(c.daysLeft)));
}

function usageCell(c) {
  if (c.types.length === 0) return el('td', { class: 'muted' }, '—');
  const percent = c.totalActive > 0 ? Math.min(100, Math.round((c.totalUsed / c.totalActive) * 100)) : 100;
  const bar = el('i', { class: c.totalUsed > c.totalActive ? 'over' : '' });
  bar.style.width = `${percent}%`;
  return el('td', { class: 'usage' }, `${c.totalUsed} / ${c.totalActive}`, el('div', { class: 'meter' }, bar));
}

function capacityCell({ capacity }) {
  const cell = el('td', { class: `capacity capacity-${capacity.state}` });
  if (capacity.state === 'short') cell.append(t('capacity.short', { count: capacity.count }));
  else if (capacity.state === 'soon') {
    cell.append(t('capacity.soon', { count: capacity.count }));
    if (capacity.at) cell.append(el('small', {}, t('capacity.at', { date: formatDate(capacity.at) })));
  } else if (capacity.state === 'ok') cell.append(t('capacity.ok'));
  else cell.append('—');
  return cell;
}

function headerRow(keys) {
  return el('thead', {}, el('tr', {}, ...keys.map((key) => el('th', {}, t(key)))));
}

function detailRow(c) {
  const left = el('div', {}, el('h4', {}, t('detail.byType')));
  if (c.types.length) {
    const rows = c.types.map((type) => el('tr', {},
      el('td', {}, typeLabel(type.type)),
      el('td', {}, String(type.used)),
      el('td', {}, String(type.activeQty)),
      el('td', {}, String(type.expiredQty)),
      el('td', {}, type.nextExpiry ? formatDate(type.nextExpiry) : '—')));
    left.append(el('table', { class: 'mini' },
      headerRow(['detail.type', 'detail.used', 'detail.active', 'detail.expired', 'detail.expires']),
      el('tbody', {}, ...rows)));
  } else {
    left.append(el('p', { class: 'muted' }, t('detail.none')));
  }
  if (c.accountLabel && state.payload.results.length > 1) {
    left.append(el('p', { class: 'muted small' }, t('detail.account', { label: c.accountLabel })));
  }
  if (c.note) left.append(el('p', { class: 'muted small' }, tm(c.note)));

  const right = el('div', {}, el('h4', {}, t('detail.recommendations')));
  right.append(c.recommendations.length
    ? el('ul', {}, ...c.recommendations.map((r) => el('li', {}, tm(r))))
    : el('p', { class: 'muted' }, t('detail.noAction')));

  return el('tr', { class: 'detail' }, el('td', { colspan: '5' }, el('div', { class: 'detail-grid' }, left, right)));
}

function renderRows() {
  const customers = visibleCustomers();
  const body = $('rows');
  body.replaceChildren();
  for (const c of customers) {
    const key = `${c.accountId}:${c.id}`;
    const open = state.expanded.has(key);
    const toggle = () => {
      if (state.expanded.has(key)) state.expanded.delete(key);
      else state.expanded.add(key);
      renderRows();
    };
    const button = el('button', {
      type: 'button',
      class: 'expand',
      'aria-expanded': String(open),
      onclick: (event) => {
        event.stopPropagation();
        toggle();
      },
    }, el('span', { class: 'chevron', 'aria-hidden': 'true' }, '▶'), displayName(c));
    const nameCell = el('td', {}, button);
    if (c.tier) nameCell.append(el('span', { class: `tag tag-${c.tier}` }, TIER_NAMES[c.tier]));
    if (c.accountType && /TRIAL/i.test(c.accountType)) nameCell.append(el('span', { class: 'tag' }, t('tag.trial')));
    body.append(el('tr', { class: 'row', 'data-row': key, onclick: toggle },
      nameCell,
      el('td', {}, el('span', { class: `badge badge-${c.status}` }, t(`status.${c.status}`))),
      dueCell(c),
      usageCell(c),
      capacityCell(c)));
    if (open) body.append(detailRow(c));
  }
  $('empty').hidden = customers.length > 0;
  $('count').textContent = t('filter.count', { shown: customers.length, total: pageCustomers().length });
  $('btn-clear').hidden = !(state.status || state.capacity || state.search || state.accountId !== 'all');
}

function renderAccountFilter() {
  const select = $('account-filter');
  const results = state.payload?.results || [];
  select.hidden = results.length < 2;
  select.replaceChildren(
    el('option', { value: 'all' }, t('filter.allAccounts')),
    ...results.map((r) => el('option', { value: r.accountId }, r.label)));
  select.value = state.accountId;
}

function renderClients() {
  $('clients-hint').textContent = t(`customers.${state.page}Hint`);
  renderAccountFilter();
  renderTiles();
  renderRows();
}

// ----- Page « Stock de licences » -----

const number = (value) => (value === null || value === undefined ? '—' : String(value));

function inventoryRow(row) {
  const expiry = row.nextExpiry === null
    ? el('td', { class: 'muted' }, '—')
    : el('td', {}, formatDate(row.nextExpiry), el('small', {}, t('inventory.licenseCount', { count: row.nextExpiringCount })));
  const active = el('td', {}, el('span', { class: 'big' }, number(row.active)));
  if (row.courtesy > 0) active.append(el('small', {}, t('inventory.courtesy', { count: row.courtesy })));
  if (row.trial > 0) active.append(el('small', {}, t('inventory.trial', { count: row.trial })));
  return el('tr', {},
    el('td', {}, typeLabel(row.type)),
    active,
    el('td', {}, el('span', { class: 'big' }, number(row.used))),
    el('td', {}, number(row.assigned)),
    el('td', {}, number(row.available)),
    expiry);
}

const LINE_BADGES = { expired: 'expired', expiring: 'expiring', ok: 'ok', future: 'future' };

function linesDetails(result) {
  const { lines } = result.inventory;
  const rows = lines.map((line) => {
    const name = el('td', {}, line.name || typeLabel(line.type));
    if (line.tier) name.append(el('span', { class: `tag tag-${line.tier}` }, TIER_NAMES[line.tier]));
    if (line.trial) name.append(el('span', { class: 'tag' }, t('tag.trial')));
    if (line.sku && line.sku !== line.name) name.append(el('small', {}, line.sku));
    return el('tr', {},
      name,
      el('td', {}, typeLabel(line.type)),
      el('td', {}, String(line.quantity)),
      el('td', {}, line.startsAt === null ? '—' : formatDate(line.startsAt)),
      el('td', {}, line.expiresAt === null ? '—' : formatDate(line.expiresAt)),
      el('td', {}, el('span', { class: `badge badge-${LINE_BADGES[line.status]}` }, t(`line.status.${line.status}`))));
  });
  const details = el('details', {},
    el('summary', {}, t('inventory.details', { count: lines.length })),
    el('table', {},
      headerRow(['line.name', 'line.type', 'line.quantity', 'line.start', 'line.end', 'line.state']),
      el('tbody', {}, ...rows)));
  details.open = state.inventoryOpen.has(result.accountId);
  details.addEventListener('toggle', () => {
    if (details.open) state.inventoryOpen.add(result.accountId);
    else state.inventoryOpen.delete(result.accountId);
  });
  return details;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, attributes = {}, text = null) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== null) node.textContent = text;
  return node;
}

function monthLabel(ms, options) {
  return new Date(ms).toLocaleDateString(i18n.localeOf(state.language), { timeZone: 'UTC', ...options });
}

function niceMax(value) {
  if (value <= 0) return 10;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * magnitude * 4 >= value);
  return step * magnitude * 4;
}

// Barre arrondie en haut seulement, posée sur la ligne de base.
function barPath(x, y, width, height) {
  const r = Math.min(3, width / 2, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

function forecastChart(months) {
  const width = 1000;
  const height = 230;
  const margin = { top: 10, right: 8, bottom: 42, left: 38 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const maximum = niceMax(Math.max(...months.flatMap((m) => [m.active, m.assigned])));
  const yOf = (value) => margin.top + plotHeight * (1 - value / maximum);
  const band = plotWidth / months.length;
  const barWidth = Math.min(16, band * 0.34);
  const baseline = margin.top + plotHeight;

  const chart = svg('svg', { viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': t('forecast.title') });
  for (let i = 0; i <= 4; i += 1) {
    const value = (maximum / 4) * i;
    const y = yOf(value);
    chart.append(
      svg('line', { x1: margin.left, x2: width - margin.right, y1: y, y2: y, class: i === 0 ? 'axis' : 'grid' }),
      svg('text', { x: margin.left - 8, y: y + 4, 'text-anchor': 'end', class: 'tick' }, String(value)),
    );
  }

  const wrap = el('div', { class: 'chart' });
  const tooltip = el('div', { class: 'chart-tooltip', role: 'status', hidden: 'hidden' });

  months.forEach((month, index) => {
    const center = margin.left + band * index + band / 2;
    const date = new Date(month.at);
    if (month.active > 0) {
      const y = yOf(month.active);
      chart.append(svg('path', { d: barPath(center - barWidth - 1, y, barWidth, baseline - y), class: 'bar-active' }));
    }
    if (month.assigned > 0) {
      const y = yOf(month.assigned);
      const over = month.assigned > month.active;
      chart.append(svg('path', { d: barPath(center + 1, y, barWidth, baseline - y), class: over ? 'bar-over' : 'bar-assigned' }));
    }
    chart.append(svg('text', { x: center, y: baseline + 16, 'text-anchor': 'middle', class: 'tick' }, monthLabel(month.at, { month: 'short' })));
    if (index === 0 || date.getUTCMonth() === 0) {
      chart.append(svg('text', { x: center, y: baseline + 33, 'text-anchor': 'middle', class: 'tick year' }, String(date.getUTCFullYear())));
    }

    // Zone de survol sur toute la hauteur du mois, plus large que les barres.
    const target = svg('rect', { x: center - band / 2, y: margin.top, width: band, height: plotHeight, class: 'hit' });
    target.addEventListener('mouseenter', () => {
      const missing = month.assigned - month.active;
      const lines = [
        el('strong', {}, monthLabel(month.at, { month: 'long', year: 'numeric' })),
        el('span', {}, `${t('forecast.active')} : ${month.active}`),
        el('span', {}, `${t('forecast.assigned')} : ${month.assigned}`),
      ];
      if (missing > 0) lines.push(el('span', { class: 'alert' }, `${t('forecast.missing')} : ${missing}`));
      tooltip.replaceChildren(...lines);
      tooltip.hidden = false;
      const share = (center / width) * 100;
      tooltip.style.left = `${share}%`;
      tooltip.classList.toggle('flip', share > 75);
      target.classList.add('hover');
    });
    target.addEventListener('mouseleave', () => {
      tooltip.hidden = true;
      target.classList.remove('hover');
    });
    chart.append(target);
  });

  wrap.append(chart, tooltip);
  return wrap;
}

function forecastMessage(row) {
  const { gap } = row.forecast;
  if (!gap) return null;
  const params = { count: gap.missing, type: row.type, assigned: gap.assigned, active: gap.active };
  if (gap.at <= Date.now()) return tm({ key: 'forecast.gapNow', params });
  const days = Math.ceil((gap.at - Date.now()) / 86400000);
  return tm({ key: 'forecast.gapAt', params: { ...params, date: gap.at, days } });
}

function forecastSection(row, showType) {
  const { months, gap, events } = row.forecast;
  const title = showType ? `${t('forecast.title')} · ${typeLabel(row.type)}` : t('forecast.title');
  const section = el('div', { class: 'forecast' }, el('h3', {}, title));
  const lastMonth = monthLabel(months[months.length - 1].at, { month: 'long', year: 'numeric' });
  section.append(gap
    ? el('p', { class: 'alert' }, forecastMessage(row))
    : el('p', { class: 'forecast-ok' }, t('forecast.ok', { month: lastMonth })));
  section.append(forecastChart(months));

  const legend = el('div', { class: 'legend' },
    el('span', {}, el('i', { class: 'swatch swatch-active' }), t('forecast.active')),
    el('span', {}, el('i', { class: 'swatch swatch-assigned' }), t('forecast.assigned')));
  if (months.some((m) => m.assigned > m.active)) {
    legend.append(el('span', {}, el('i', { class: 'swatch swatch-over' }), t('forecast.over')));
  }
  section.append(legend);

  if (events.length) {
    section.append(el('h4', {}, t('forecast.events')), el('ul', { class: 'events' }, ...events.map((event) => {
      const text = t(`forecast.event.${event.kind}`, { count: event.count, name: event.name || t('customer.noName') });
      return el('li', {}, el('span', { class: 'event-date' }, formatDate(event.at)), text);
    })));
  }

  const key = `forecast:${row.type}`;
  const table = el('details', {},
    el('summary', {}, t('forecast.table')),
    el('table', {},
      headerRow(['forecast.month', 'forecast.active', 'forecast.assigned', 'forecast.missing']),
      el('tbody', {}, ...months.map((m) => el('tr', {},
        el('td', {}, monthLabel(m.at, { month: 'long', year: 'numeric' })),
        el('td', {}, String(m.active)),
        el('td', {}, String(m.assigned)),
        el('td', {}, m.assigned > m.active ? String(m.assigned - m.active) : '—'))))));
  table.open = state.inventoryOpen.has(key);
  table.addEventListener('toggle', () => {
    if (table.open) state.inventoryOpen.add(key);
    else state.inventoryOpen.delete(key);
  });
  section.append(table);
  return section;
}

function renderInventory() {
  const section = $('inventory');
  section.replaceChildren();
  const results = state.payload.results.filter((r) => !r.fatal);
  for (const result of results) {
    const { rows, lines } = result.inventory;
    const card = el('div', { class: 'inventory-card' });
    if (results.length > 1) card.append(el('h2', {}, result.label));
    if (rows.length) {
      card.append(el('table', {},
        headerRow(['inventory.licenses', 'inventory.active', 'inventory.usedNow', 'inventory.assigned', 'inventory.available', 'inventory.nextExpiry']),
        el('tbody', {}, ...rows.map(inventoryRow))));
      for (const row of rows.filter((r) => r.shortage > 0)) {
        card.append(el('p', { class: 'alert' }, tm({
          key: 'inventory.shortage',
          params: { count: row.shortage, type: row.type },
        })));
      }
    } else {
      card.append(el('p', { class: 'muted message' }, t('inventory.none')));
      // On explique ici ce que le bandeau d'alertes masque volontairement (les 404).
      for (const source of result.sources) {
        if (!source.ok && (source.source === 'stock' || source.source === 'lines')) {
          card.append(el('p', { class: 'muted small' }, tm(source.error)));
        }
      }
    }
    const forecasts = rows.filter((row) => row.forecast);
    for (const row of forecasts) card.append(forecastSection(row, forecasts.length > 1));
    if (lines.length) card.append(linesDetails(result));
    section.append(card);
  }
}

// ----- Page « Paramètres » -----

function renderSettings() {
  const button = $('btn-save-account');
  button.disabled = state.savingAccount;
  button.textContent = t(state.savingAccount ? 'accounts.testing' : 'accounts.save');
  $('form-error').hidden = !state.formError;
  if (state.formError) $('form-error').textContent = tm(state.formError);

  const list = $('account-list');
  list.replaceChildren(...state.accounts.map((account) => el('li', {},
    el('span', {}, el('strong', {}, account.label), el('br'),
      el('span', { class: 'muted small' }, `${t(`region.${account.region}`)} · ${account.tenantId}`)),
    el('button', {
      type: 'button',
      onclick: () => removeAccount(account),
    }, t('action.remove')))));
  if (state.accounts.length === 0) list.append(el('li', { class: 'muted' }, t('accounts.none')));

  const canQuery = state.demo || state.accounts.length > 0;
  $('btn-diagnostic').disabled = !canQuery || state.diagnosticRunning;
  $('btn-diagnostic').textContent = t(state.diagnosticRunning ? 'action.diagnosticRunning' : 'action.diagnostic');
  const result = $('diagnostic-result');
  result.hidden = !state.diagnosticPath;
  if (state.diagnosticPath) result.textContent = t('diagnostic.saved', { path: state.diagnosticPath });
}

// ----- Structure commune -----

function renderNav() {
  const hasData = Boolean(state.payload);
  const tasks = state.payload?.tasks;
  const items = [
    ['home', t('nav.home'), tasks ? tasks.mandatory.length + tasks.urgent.length : 0],
    ['msp', t('customers.msp'), null],
    ['var', t('customers.var'), null],
    ['licenses', t('nav.licenses'), null],
  ];
  const nav = $('nav');
  nav.replaceChildren(
    ...(hasData ? items : []).map(([page, label, badge]) => el('button', {
      type: 'button',
      class: 'nav-item',
      'aria-current': state.page === page ? 'page' : null,
      onclick: () => goTo(page),
    }, el('span', {}, label), badge ? el('span', { class: 'nav-badge' }, String(badge)) : null)),
    el('button', {
      type: 'button',
      class: 'nav-item nav-settings',
      'aria-current': state.page === 'settings' ? 'page' : null,
      onclick: () => goTo('settings'),
    }, el('span', {}, t('nav.settings'))),
  );
}

function renderAlerts() {
  const alerts = $('alerts');
  alerts.replaceChildren();
  const banner = (text) => alerts.append(el('div', { class: 'banner error', role: 'alert' }, text));
  if (state.loadError) banner(tm(state.loadError));
  if (state.actionError) banner(tm(state.actionError));
  for (const result of state.payload?.results || []) {
    if (result.fatal) banner(`${result.label} · ${tm(result.fatal)}`);
    // Un 404 sur une source veut dire que ce type de compte n'est pas concerné : ce n'est pas une panne.
    for (const source of result.sources) {
      if (!source.ok && source.status !== 404) banner(`${result.label} · ${tm(source.error)}`);
    }
  }
}

function renderUpdateBanner() {
  $('update-banner').hidden = !state.update;
  if (!state.update) return;
  $('update-text').textContent = state.updateStarted
    ? t('update.started')
    : t('update.available', { version: state.update.version });
  $('btn-update-download').hidden = state.updateStarted;
  $('btn-update-later').hidden = state.updateStarted;
}

async function checkForUpdate() {
  try {
    state.update = await call(window.r1.checkForUpdate());
    render();
  } catch {
    // Une vérification qui échoue ne doit pas gêner le travail : pas de bandeau, c'est tout.
  }
}

async function downloadUpdate() {
  state.actionError = null;
  try {
    await call(window.r1.downloadUpdate());
    state.updateStarted = true;
  } catch (error) {
    state.actionError = error.userMessage;
  }
  render();
}

function applyStaticTexts() {
  document.documentElement.lang = state.language;
  for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll('[data-i18n-placeholder]')) node.placeholder = t(node.dataset.i18nPlaceholder);
  for (const node of document.querySelectorAll('[data-i18n-aria]')) node.setAttribute('aria-label', t(node.dataset.i18nAria));
  const region = document.querySelector('#account-form select[name="region"]');
  const selected = region.value || 'eu';
  region.replaceChildren(...state.regions.map((id) => el('option', { value: id }, t(`region.${id}`))));
  region.value = selected;
}

const PAGE_TITLES = { home: 'nav.home', msp: 'customers.msp', var: 'customers.var', licenses: 'nav.licenses', settings: 'nav.settings' };

function render() {
  const hasData = Boolean(state.payload);
  const isSettings = state.page === 'settings';
  const showWelcome = !isSettings && !hasData && state.accounts.length === 0 && !state.loading;
  const isClients = Boolean(CLIENT_PAGES[state.page]);

  $('page-welcome').hidden = !showWelcome;
  $('page-home').hidden = !(hasData && state.page === 'home');
  $('page-clients').hidden = !(hasData && isClients);
  $('page-licenses').hidden = !(hasData && state.page === 'licenses');
  $('page-settings').hidden = !isSettings;
  $('demo-banner').hidden = !state.demo;
  renderUpdateBanner();
  $('page-title').textContent = showWelcome ? 'RUCKUS One Licenses Dashboard' : t(PAGE_TITLES[state.page]);

  const canQuery = state.demo || state.accounts.length > 0;
  $('refresh-area').hidden = !canQuery;
  $('btn-refresh').disabled = state.loading;
  $('btn-refresh').textContent = t(state.loading ? 'action.refreshing' : 'action.refresh');
  $('btn-export').disabled = pageCustomers().length === 0;
  let freshness = '';
  if (state.loading) freshness = t('loading');
  else if (hasData) {
    const time = new Date(state.payload.fetchedAt).toLocaleTimeString(i18n.localeOf(state.language), { hour: '2-digit', minute: '2-digit' });
    freshness = t('updated', { time });
  }
  $('freshness').textContent = freshness;

  renderNav();
  renderAlerts();
  renderSettings();
  if (!hasData) return;
  if (state.page === 'home') renderHome();
  else if (isClients) renderClients();
  else if (state.page === 'licenses') renderInventory();
}

async function load(task, demo) {
  state.loading = true;
  state.loadError = null;
  render();
  try {
    state.payload = await call(task());
    state.demo = demo;
  } catch (error) {
    state.payload = null;
    state.loadError = error.userMessage;
  }
  state.loading = false;
  render();
}

function refresh() {
  if (state.demo) return load(() => window.r1.demo(), true);
  if (state.accounts.length === 0) {
    state.payload = null;
    render();
    return undefined;
  }
  return load(() => window.r1.refresh(), false);
}

async function removeAccount(account) {
  if (!window.confirm(t('accounts.confirmRemove', { label: account.label }))) return;
  try {
    state.accounts = await call(window.r1.removeAccount(account.id));
    state.accountId = 'all';
    state.demo = false;
    refresh();
  } catch (error) {
    state.formError = error.userMessage;
    render();
  }
}

async function saveAccount(event) {
  event.preventDefault();
  const form = event.target;
  state.savingAccount = true;
  state.formError = null;
  render();
  try {
    state.accounts = await call(window.r1.addAccount(Object.fromEntries(new FormData(form))));
    form.reset();
    applyStaticTexts();
    state.demo = false;
    state.savingAccount = false;
    state.page = 'home';
    refresh();
  } catch (error) {
    state.formError = error.userMessage;
    state.savingAccount = false;
    render();
  }
}

async function exportCsv() {
  state.actionError = null;
  try {
    await call(window.r1.exportCsv(state.language));
  } catch (error) {
    state.actionError = error.userMessage;
  }
  render();
}

async function exportDiagnostic() {
  state.diagnosticRunning = true;
  state.diagnosticPath = null;
  state.actionError = null;
  render();
  try {
    state.diagnosticPath = await call(window.r1.exportDiagnostic(state.demo));
  } catch (error) {
    state.actionError = error.userMessage;
  }
  state.diagnosticRunning = false;
  render();
}

function storedLanguage() {
  try {
    return localStorage.getItem(LANGUAGE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function setLanguage(language) {
  state.language = i18n.normalizeLanguage(language);
  $('language').value = state.language;
  try {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, state.language);
  } catch {
    // Le choix ne sera simplement pas mémorisé.
  }
  applyStaticTexts();
  render();
}

async function init() {
  $('language').replaceChildren(...i18n.LANGUAGES.map((l) => el('option', { value: l.id }, l.name)));
  $('language').addEventListener('change', (event) => setLanguage(event.target.value));
  $('btn-refresh').addEventListener('click', refresh);
  $('btn-welcome-add').addEventListener('click', () => goTo('settings'));
  $('account-form').addEventListener('submit', saveAccount);
  $('btn-welcome-demo').addEventListener('click', () => {
    state.page = 'home';
    load(() => window.r1.demo(), true);
  });
  $('btn-leave-demo').addEventListener('click', () => {
    state.demo = false;
    goTo('home');
    refresh();
  });
  $('btn-update-download').addEventListener('click', downloadUpdate);
  $('btn-update-later').addEventListener('click', () => {
    state.update = null;
    render();
  });
  $('btn-export').addEventListener('click', exportCsv);
  $('btn-diagnostic').addEventListener('click', exportDiagnostic);
  $('search').addEventListener('input', (event) => {
    state.search = event.target.value;
    renderRows();
  });
  $('account-filter').addEventListener('change', (event) => {
    state.accountId = event.target.value;
    render();
  });
  $('btn-clear').addEventListener('click', () => {
    Object.assign(state, { status: null, capacity: null, search: '', accountId: 'all' });
    $('search').value = '';
    render();
  });

  state.regions = await call(window.r1.listRegions());
  state.accounts = await call(window.r1.listAccounts());
  // Anglais par défaut, tant que l'utilisateur n'a pas choisi une autre langue.
  setLanguage(storedLanguage() || i18n.DEFAULT_LANGUAGE);
  checkForUpdate();
  if (state.accounts.length > 0) refresh();
}

init();
