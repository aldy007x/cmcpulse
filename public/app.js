'use strict';

/* CMCPulse frontend.
 * Talks ONLY to this server's /api/* proxy routes — never to CoinMarketCap
 * directly (CMC blocks browser calls via CORS, and the API key stays on the
 * server). Watchlist and portfolio persist in localStorage.
 */

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  listings: [], // last /api/listings payload (array of coins)
  quotesById: new Map(), // id -> quote object (USD) from any endpoint
  coinById: new Map(), // id -> {name, symbol, slug}
  watchlist: loadJSON('cmcpulse.watchlist', []), // [id]
  portfolio: loadJSON('cmcpulse.portfolio', []), // [{id, symbol, amount, avgBuy}]
  sortKey: 'cmc_rank',
  sortDir: 1,
  view: 'screener',
  refreshTimer: null,
  drawerCoinId: null,
  drawerUnitPrice: null,
};

function loadJSON(key, fallback) {
  try {
    const v = JSON.parse(localStorage.getItem(key));
    return v ?? fallback;
  } catch {
    return fallback;
  }
}
function saveJSON(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

/* ------------------------------------------------------------ formatting */

const fmtUSD = (n, digits = 2) =>
  n == null || !Number.isFinite(n)
    ? '—'
    : n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits });

const fmtCompactUSD = (n) =>
  n == null || !Number.isFinite(n)
    ? '—'
    : '$' + Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(n);

const fmtPrice = (n) => {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n >= 1) return fmtUSD(n, 2);
  if (n >= 0.01) return fmtUSD(n, 4);
  return '$' + n.toPrecision(3);
};

const fmtPct = (n) => {
  if (n == null || !Number.isFinite(n)) return '<span class="muted">—</span>';
  const cls = n > 0 ? 'pos' : n < 0 ? 'neg' : '';
  return `<span class="${cls}">${n > 0 ? '▲' : n < 0 ? '▼' : ''} ${Math.abs(n).toFixed(2)}%</span>`;
};

const fmtNum = (n) => (n == null || !Number.isFinite(n) ? '—' : Math.round(n).toLocaleString('en-US'));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const logoUrl = (id) => `https://s2.coinmarketcap.com/static/img/coins/64x64/${id}.png`;

/* ------------------------------------------------------------------ api */

async function api(path) {
  const res = await fetch(path);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* handled below */
  }
  if (!res.ok || !body || body.error) {
    const msg = body && body.error ? body.error.message : `Request failed (HTTP ${res.status})`;
    throw new Error(msg);
  }
  noteMeta(body.meta);
  return body.data;
}

function noteMeta(meta) {
  if (!meta) return;
  $('#fixture-ribbon').classList.toggle('hidden', meta.source !== 'fixture');
  const stale = $('#stale-note');
  if (meta.stale) {
    stale.textContent = '⚠ Live refresh failed — showing the last cached response from the CoinMarketCap API. Figures may be out of date.';
    stale.classList.remove('hidden');
  } else {
    stale.classList.add('hidden');
  }
}

function showError(err) {
  $('#error-text').textContent = `Could not load market data: ${err.message}`;
  $('#error-banner').classList.remove('hidden');
}
function clearError() {
  $('#error-banner').classList.add('hidden');
}

function rememberQuotes(coins) {
  for (const c of coins || []) {
    if (c && c.id && c.quote && c.quote.USD) {
      state.quotesById.set(c.id, c.quote.USD);
      state.coinById.set(c.id, { name: c.name, symbol: c.symbol, slug: c.slug });
    }
  }
}

/* ---------------------------------------------------------- global stats */

async function loadGlobal() {
  $$('#stats .stat').forEach((el) => el.classList.add('loading'));
  try {
    const g = await api('/api/global-metrics');
    const q = g.quote.USD;
    $('[data-stat="mcap"]').textContent = fmtCompactUSD(q.total_market_cap);
    $('[data-stat="vol"]').textContent = fmtCompactUSD(q.total_volume_24h);
    $('[data-stat="btc"]').textContent = g.btc_dominance?.toFixed(2) + '%';
    $('[data-stat="eth"]').textContent = g.eth_dominance?.toFixed(2) + '%';
    $('[data-stat="active"]').textContent = fmtNum(g.active_cryptocurrencies);
  } catch (err) {
    showError(err);
  } finally {
    $$('#stats .stat').forEach((el) => el.classList.remove('loading'));
  }
}

/* -------------------------------------------------------------- screener */

function skeletonRows(n = 10) {
  return Array.from({ length: n }, () => `<tr class="skeleton-row">${'<td><span class="skel"></span></td>'.repeat(9)}</tr>`).join('');
}

async function loadListings() {
  const body = $('#screener-body');
  if (!state.listings.length) body.innerHTML = skeletonRows();
  try {
    const data = await api('/api/listings?limit=100');
    state.listings = data;
    rememberQuotes(data);
    clearError();
    renderScreener();
    renderSymbolList();
    $('#last-updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  } catch (err) {
    if (!state.listings.length) body.innerHTML = '';
    showError(err);
  }
}

function getQuote(coin) {
  return coin.quote ? coin.quote.USD : {};
}

function filteredListings() {
  const term = $('#search').value.trim().toLowerCase();
  const dir = $('#direction-filter').value;
  const minVol = Number($('#min-volume').value || 0);
  let rows = state.listings.filter((c) => {
    const q = getQuote(c);
    if (term && !(c.name.toLowerCase().includes(term) || c.symbol.toLowerCase().includes(term))) return false;
    if (dir === 'gainers' && !(q.percent_change_24h > 0)) return false;
    if (dir === 'losers' && !(q.percent_change_24h < 0)) return false;
    if (minVol > 0 && !(q.volume_24h >= minVol)) return false;
    return true;
  });
  const key = state.sortKey;
  rows.sort((a, b) => {
    const va = key === 'name' ? a.name : key === 'cmc_rank' ? a.cmc_rank : getQuote(a)[key];
    const vb = key === 'name' ? b.name : key === 'cmc_rank' ? b.cmc_rank : getQuote(b)[key];
    if (va == null) return 1;
    if (vb == null) return -1;
    return (va < vb ? -1 : va > vb ? 1 : 0) * state.sortDir;
  });
  return rows;
}

function starCell(id) {
  const starred = state.watchlist.includes(id);
  return `<button class="star-btn ${starred ? 'starred' : ''}" data-star="${id}" title="Toggle watchlist">${starred ? '★' : '☆'}</button>`;
}

function coinCell(c) {
  return `<div class="coin-cell"><img src="${logoUrl(c.id)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
    <span class="coin-name">${esc(c.name)}</span> <span class="coin-sym">${esc(c.symbol)}</span></div>`;
}

function renderScreener() {
  const rows = filteredListings();
  $('#row-count').textContent = `${rows.length} of ${state.listings.length} coins`;
  $('#screener-body').innerHTML = rows
    .map((c) => {
      const q = getQuote(c);
      return `<tr data-coin="${c.id}">
        <td>${starCell(c.id)}</td>
        <td>${c.cmc_rank ?? '—'}</td>
        <td>${coinCell(c)}</td>
        <td class="num">${fmtPrice(q.price)}</td>
        <td class="num">${fmtPct(q.percent_change_1h)}</td>
        <td class="num">${fmtPct(q.percent_change_24h)}</td>
        <td class="num">${fmtPct(q.percent_change_7d)}</td>
        <td class="num">${fmtCompactUSD(q.market_cap)}</td>
        <td class="num">${fmtCompactUSD(q.volume_24h)}</td>
      </tr>`;
    })
    .join('');
  $$('#screener-table thead th').forEach((th) => {
    th.classList.toggle('sorted', th.dataset.sort === state.sortKey);
    th.classList.toggle('asc', th.dataset.sort === state.sortKey && state.sortDir === 1);
  });
}

/* ------------------------------------------------------------- watchlist */

async function renderWatchlist() {
  const empty = $('#watchlist-empty');
  const table = $('#watchlist-table');
  $('#watch-count').textContent = state.watchlist.length || '';
  if (!state.watchlist.length) {
    empty.classList.remove('hidden');
    table.classList.add('hidden');
    $('#watchlist-body').innerHTML = '';
    return;
  }
  empty.classList.add('hidden');
  table.classList.remove('hidden');
  try {
    const data = await api(`/api/quotes?ids=${state.watchlist.join(',')}`);
    const coins = Object.values(data);
    rememberQuotes(coins);
    $('#watchlist-body').innerHTML = coins
      .map((c) => {
        const q = c.quote.USD;
        return `<tr data-coin="${c.id}">
          <td>${starCell(c.id)}</td>
          <td>${coinCell(c)}</td>
          <td class="num">${fmtPrice(q.price)}</td>
          <td class="num">${fmtPct(q.percent_change_24h)}</td>
          <td class="num">${fmtPct(q.percent_change_7d)}</td>
          <td class="num">${fmtCompactUSD(q.market_cap)}</td>
        </tr>`;
      })
      .join('');
  } catch (err) {
    showError(err);
  }
}

function toggleStar(id) {
  const i = state.watchlist.indexOf(id);
  if (i >= 0) state.watchlist.splice(i, 1);
  else state.watchlist.push(id);
  saveJSON('cmcpulse.watchlist', state.watchlist);
  renderScreener();
  renderWatchlist();
}

/* ------------------------------------------------------------- portfolio */

function renderSymbolList() {
  $('#symbol-list').innerHTML = state.listings.map((c) => `<option value="${esc(c.symbol)}">`).join('');
}

async function refreshPortfolioPrices() {
  const ids = [...new Set(state.portfolio.map((h) => h.id))];
  if (!ids.length) return;
  try {
    const data = await api(`/api/quotes?ids=${ids.join(',')}`);
    rememberQuotes(Object.values(data));
  } catch (err) {
    showError(err);
  }
}

function renderPortfolio() {
  const empty = $('#portfolio-empty');
  const table = $('#portfolio-table');
  if (!state.portfolio.length) {
    empty.classList.remove('hidden');
    table.classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  table.classList.remove('hidden');

  let totalValue = 0;
  let totalCost = 0;
  $('#portfolio-body').innerHTML = state.portfolio
    .map((h, idx) => {
      const q = state.quotesById.get(h.id);
      const price = q ? q.price : null;
      const value = price == null ? null : price * h.amount;
      const cost = h.avgBuy * h.amount;
      const pnl = value == null ? null : value - cost;
      const pnlPct = pnl == null || cost === 0 ? null : (pnl / cost) * 100;
      if (value != null) {
        totalValue += value;
        totalCost += cost;
      }
      return `<tr>
        <td>${coinCell({ id: h.id, name: (state.coinById.get(h.id) || {}).name || h.symbol, symbol: h.symbol })}</td>
        <td class="num">${h.amount}</td>
        <td class="num">${fmtPrice(h.avgBuy)}</td>
        <td class="num">${fmtPrice(price)}</td>
        <td class="num">${value == null ? '—' : fmtUSD(value)}</td>
        <td class="num">${pnl == null ? '—' : `<span class="${pnl >= 0 ? 'pos' : 'neg'}">${fmtUSD(pnl)}</span>`}</td>
        <td class="num">${pnlPct == null ? '—' : `<span class="${pnlPct >= 0 ? 'pos' : 'neg'}">${pnlPct.toFixed(2)}%</span>`}</td>
        <td><button class="remove-btn" data-remove="${idx}">Remove</button></td>
      </tr>`;
    })
    .join('');

  const totalPnl = totalValue - totalCost;
  const totalPct = totalCost ? (totalPnl / totalCost) * 100 : 0;
  $('#portfolio-foot').innerHTML = `<tr>
    <td colspan="4">Total</td>
    <td class="num">${fmtUSD(totalValue)}</td>
    <td class="num"><span class="${totalPnl >= 0 ? 'pos' : 'neg'}">${fmtUSD(totalPnl)}</span></td>
    <td class="num"><span class="${totalPct >= 0 ? 'pos' : 'neg'}">${totalPct.toFixed(2)}%</span></td>
    <td></td></tr>`;
}

async function addHolding(evt) {
  evt.preventDefault();
  const symbol = $('#holding-symbol').value.trim().toUpperCase();
  const amount = Number($('#holding-amount').value);
  const avgBuy = Number($('#holding-avgbuy').value);
  const errEl = $('#holding-error');
  errEl.textContent = '';
  if (!symbol || !(amount > 0) || !(avgBuy >= 0)) {
    errEl.textContent = 'Enter a symbol, an amount > 0 and an average buy price.';
    return;
  }
  // Resolve symbol -> CMC id (from listings if loaded, else via quotes endpoint)
  let coin = state.listings.find((c) => c.symbol === symbol);
  if (!coin) {
    try {
      const data = await api(`/api/quotes?symbols=${encodeURIComponent(symbol)}`);
      const first = Object.values(data)[0];
      coin = Array.isArray(first) ? first[0] : first;
      if (coin) rememberQuotes([coin]);
    } catch (err) {
      errEl.textContent = err.message;
      return;
    }
  }
  if (!coin) {
    errEl.textContent = `Unknown symbol: ${symbol}`;
    return;
  }
  state.portfolio.push({ id: coin.id, symbol: coin.symbol, amount, avgBuy });
  saveJSON('cmcpulse.portfolio', state.portfolio);
  evt.target.reset();
  renderPortfolio();
}

/* ---------------------------------------------------------------- drawer */

function openDrawer(id) {
  state.drawerCoinId = id;
  state.drawerUnitPrice = null;
  $('#drawer').classList.remove('hidden');
  $('#drawer-overlay').classList.remove('hidden');
  $('#drawer-content').innerHTML = '<p class="muted">Loading coin details…</p>';
  loadDrawer(id);
}

function closeDrawer() {
  $('#drawer').classList.add('hidden');
  $('#drawer-overlay').classList.add('hidden');
  state.drawerCoinId = null;
}

async function loadDrawer(id) {
  try {
    const [infoData, quoteData] = await Promise.all([api(`/api/info?ids=${id}`), api(`/api/quotes?ids=${id}`)]);
    const info = infoData[String(id)] || Object.values(infoData)[0] || {};
    const coin = quoteData[String(id)] || Object.values(quoteData)[0] || {};
    if (coin.quote) rememberQuotes([coin]);
    const q = coin.quote ? coin.quote.USD : {};
    const websites = (info.urls && info.urls.website) || [];
    const tags = info.tags || coin.tags || [];
    $('#drawer-content').innerHTML = `
      <div class="drawer-head">
        <img src="${esc(info.logo || logoUrl(id))}" alt="" onerror="this.style.visibility='hidden'">
        <div><h2>${esc(info.name || coin.name || '')}</h2><span class="muted">${esc(info.symbol || coin.symbol || '')} · Rank #${coin.cmc_rank ?? '—'}</span></div>
      </div>
      <div class="drawer-price">${fmtPrice(q.price)} ${fmtPct(q.percent_change_24h)}</div>
      <p class="drawer-desc">${esc(info.description || 'No description available from the CoinMarketCap info endpoint.')}</p>
      ${websites.length ? `<p>🌐 <a href="${esc(websites[0])}" target="_blank" rel="noopener">${esc(websites[0])}</a></p>` : ''}
      <div>${tags.map((t) => `<span class="tag-chip">${esc(typeof t === 'string' ? t : t.name || '')}</span>`).join('')}</div>
      <div class="kv-grid">
        <div><div class="k">Market Cap</div><div class="v">${fmtCompactUSD(q.market_cap)}</div></div>
        <div><div class="k">Volume 24h</div><div class="v">${fmtCompactUSD(q.volume_24h)}</div></div>
        <div><div class="k">Circulating Supply</div><div class="v">${fmtNum(coin.circulating_supply)} ${esc(coin.symbol || '')}</div></div>
        <div><div class="k">Max Supply</div><div class="v">${coin.max_supply ? fmtNum(coin.max_supply) : '∞'}</div></div>
        <div><div class="k">Change 1h</div><div class="v">${fmtPct(q.percent_change_1h)}</div></div>
        <div><div class="k">Change 7d</div><div class="v">${fmtPct(q.percent_change_7d)}</div></div>
      </div>
      <h3>Price converter</h3>
      <div class="converter">
        <div class="converter-row"><input id="conv-coin" type="number" step="any" min="0" value="1"><span class="unit">${esc(coin.symbol || '')}</span></div>
        <div class="converter-row"><input id="conv-usd" type="number" step="any" min="0"><span class="unit">USD</span></div>
        <p class="converter-note" id="conv-note">Powered by <code>/v1/tools/price-conversion</code>.</p>
      </div>`;
    wireConverter(coin.symbol);
    convertFromCoin(); // initial conversion for amount = 1
  } catch (err) {
    $('#drawer-content').innerHTML = `<p class="neg">Could not load details: ${esc(err.message)}</p>`;
  }
}

function wireConverter(symbol) {
  $('#conv-coin').addEventListener('input', debounce(convertFromCoin, 450));
  $('#conv-usd').addEventListener('input', debounce(convertFromUsd, 450));
  state.drawerSymbol = symbol;
}

async function convertFromCoin() {
  const amount = Number($('#conv-coin').value);
  if (!(amount > 0) || !state.drawerSymbol) return;
  try {
    const data = await api(`/api/convert?amount=${amount}&symbol=${encodeURIComponent(state.drawerSymbol)}&convert=USD`);
    const price = data.quote.USD.price;
    $('#conv-usd').value = Number(price.toFixed(2));
    state.drawerUnitPrice = price / amount;
    $('#conv-note').textContent = `1 ${state.drawerSymbol} = ${fmtPrice(state.drawerUnitPrice)} · via /v1/tools/price-conversion`;
  } catch (err) {
    $('#conv-note').textContent = `Conversion failed: ${err.message}`;
  }
}

async function convertFromUsd() {
  const usd = Number($('#conv-usd').value);
  if (!(usd > 0) || !state.drawerSymbol) return;
  try {
    if (state.drawerUnitPrice == null) {
      const unit = await api(`/api/convert?amount=1&symbol=${encodeURIComponent(state.drawerSymbol)}&convert=USD`);
      state.drawerUnitPrice = unit.quote.USD.price;
    }
    $('#conv-coin').value = Number((usd / state.drawerUnitPrice).toFixed(8));
    $('#conv-note').textContent = `1 ${state.drawerSymbol} = ${fmtPrice(state.drawerUnitPrice)} · via /v1/tools/price-conversion`;
  } catch (err) {
    $('#conv-note').textContent = `Conversion failed: ${err.message}`;
  }
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ---------------------------------------------------------------- events */

$$('.tab').forEach((tab) =>
  tab.addEventListener('click', async () => {
    $$('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    state.view = tab.dataset.view;
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${state.view}`));
    if (state.view === 'watchlist') renderWatchlist();
    if (state.view === 'portfolio') {
      await refreshPortfolioPrices();
      renderPortfolio();
    }
  }),
);

document.addEventListener('click', (e) => {
  const star = e.target.closest('[data-star]');
  if (star) {
    e.stopPropagation();
    toggleStar(Number(star.dataset.star));
    return;
  }
  const remove = e.target.closest('[data-remove]');
  if (remove) {
    state.portfolio.splice(Number(remove.dataset.remove), 1);
    saveJSON('cmcpulse.portfolio', state.portfolio);
    renderPortfolio();
    return;
  }
  const row = e.target.closest('tr[data-coin]');
  if (row) openDrawer(Number(row.dataset.coin));
});

$$('#screener-table thead th.sortable').forEach((th) =>
  th.addEventListener('click', () => {
    const key = th.dataset.sort;
    if (state.sortKey === key) state.sortDir *= -1;
    else {
      state.sortKey = key;
      state.sortDir = key === 'name' || key === 'cmc_rank' ? 1 : -1;
    }
    renderScreener();
  }),
);

['search', 'direction-filter', 'min-volume'].forEach((id) =>
  $('#' + id).addEventListener('input', renderScreener),
);

$('#holding-form').addEventListener('submit', addHolding);
$('#drawer-close').addEventListener('click', closeDrawer);
$('#drawer-overlay').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeDrawer();
});

async function refreshAll() {
  await Promise.allSettled([loadGlobal(), loadListings()]);
  if (state.view === 'watchlist') renderWatchlist();
  if (state.view === 'portfolio') {
    await refreshPortfolioPrices();
    renderPortfolio();
  }
  if (state.drawerCoinId) loadDrawer(state.drawerCoinId);
}

$('#refresh-btn').addEventListener('click', refreshAll);
$('#error-retry').addEventListener('click', refreshAll);
$('#autorefresh').addEventListener('change', (e) => {
  clearInterval(state.refreshTimer);
  state.refreshTimer = null;
  if (e.target.checked) state.refreshTimer = setInterval(refreshAll, 60_000);
});

/* ------------------------------------------------------------------ init */

refreshAll();
