'use strict';

/**
 * CoinMarketCap API client (server-side only).
 *
 * Why a server-side client at all? The CMC API blocks browser calls via CORS
 * by design, so an API key is never exposed to end users. Every CMC request
 * for CMCPulse goes through this module; the key is read from the CMC_API_KEY
 * environment variable and is never logged, returned, or sent to the browser.
 *
 * Endpoints used by CMCPulse (paths relative to CMC_BASE_URL):
 *   GET /v1/cryptocurrency/listings/latest   — screener (top coins by market cap)
 *   GET /v1/cryptocurrency/quotes/latest     — watchlist & portfolio pricing
 *   GET /v1/cryptocurrency/info              — coin metadata (description, logo, links)
 *   GET /v1/global-metrics/quotes/latest     — market header (total mcap, BTC dominance)
 *   GET /v1/tools/price-conversion           — coin <-> fiat converter
 *
 * Responses are cached in memory for CMC_CACHE_TTL_MS (default 60s) because
 * CMC plans meter *call credits* per request; a dashboard with many users
 * should not burn one credit per page view for data that changes slowly.
 *
 * Development transport: with CMC_FIXTURES=1 the client answers from recorded
 * fixture files (fixtures/*.json) that follow the documented CMC response
 * shapes. Fixture responses are flagged via meta.source === 'fixture' so the
 * UI can label them honestly. Production runs never enable this.
 */

const fs = require('node:fs');
const path = require('node:path');

const BASE_URL = (process.env.CMC_BASE_URL || 'https://pro-api.coinmarketcap.com').replace(/\/+$/, '');
const API_KEY = process.env.CMC_API_KEY || '';
const FIXTURES_ON = process.env.CMC_FIXTURES === '1';
const FIXTURE_DIR = process.env.CMC_FIXTURE_DIR || path.join(__dirname, '..', 'fixtures');
const CACHE_TTL_MS = Number(process.env.CMC_CACHE_TTL_MS || 60_000);
const FETCH_TIMEOUT_MS = 15_000;

class CmcError extends Error {
  constructor(message, { httpStatus = 502, cmcCode = null } = {}) {
    super(message);
    this.name = 'CmcError';
    this.httpStatus = httpStatus;
    this.cmcCode = cmcCode;
  }
}

/* ------------------------------------------------------------------ cache */

const cache = new Map(); // key -> { at: number, body: object }

function cacheKey(pathname, params) {
  const qs = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return `${pathname}?${qs}`;
}

/* --------------------------------------------------------------- fixtures */

const fixtureMemo = new Map();

function loadFixture(name) {
  if (!fixtureMemo.has(name)) {
    const raw = fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
    fixtureMemo.set(name, JSON.parse(raw));
  }
  return fixtureMemo.get(name);
}

function fixtureSymbolIndex() {
  // symbol -> id, built from the quotes fixture
  const quotes = loadFixture('quotes-latest.json').data;
  const idx = {};
  for (const [id, coin] of Object.entries(quotes)) idx[coin.symbol.toUpperCase()] = id;
  return idx;
}

function pickByIdOrSymbol(mapData, params) {
  let wanted = null;
  if (params.id) wanted = String(params.id).split(',').map((s) => s.trim());
  else if (params.symbol) {
    const idx = fixtureSymbolIndex();
    wanted = String(params.symbol)
      .split(',')
      .map((s) => idx[s.trim().toUpperCase()])
      .filter(Boolean);
  }
  if (!wanted) return mapData;
  const out = {};
  for (const id of wanted) if (mapData[id]) out[id] = mapData[id];
  return out;
}

function fixtureGet(pathname, params) {
  switch (pathname) {
    case '/v1/cryptocurrency/listings/latest': {
      const body = loadFixture('listings-latest.json');
      const start = Math.max(1, Number(params.start || 1));
      const limit = Math.max(1, Number(params.limit || 100));
      return { ...body, data: body.data.slice(start - 1, start - 1 + limit) };
    }
    case '/v1/cryptocurrency/quotes/latest': {
      const body = loadFixture('quotes-latest.json');
      return { ...body, data: pickByIdOrSymbol(body.data, params) };
    }
    case '/v1/cryptocurrency/info': {
      const body = loadFixture('info.json');
      return { ...body, data: pickByIdOrSymbol(body.data, params) };
    }
    case '/v1/global-metrics/quotes/latest':
      return loadFixture('global-metrics.json');
    case '/v1/tools/price-conversion': {
      const units = loadFixture('price-conversion-units.json');
      const convert = String(params.convert || 'USD').toUpperCase();
      if (convert !== 'USD') {
        throw new CmcError(`Fixture transport only supports convert=USD (got ${convert}).`, { httpStatus: 400 });
      }
      let unit = null;
      if (params.symbol) unit = units[String(params.symbol).toUpperCase()];
      if (!unit && params.id) unit = Object.values(units).find((u) => u.id === Number(params.id));
      if (!unit) throw new CmcError('Fixture transport: unknown coin for price-conversion.', { httpStatus: 400 });
      const amount = Number(params.amount);
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new CmcError('amount must be a positive number.', { httpStatus: 400 });
      }
      const ts = new Date().toISOString();
      return {
        status: { timestamp: ts, error_code: 0, error_message: null, elapsed: 1, credit_count: 1, notice: null },
        data: {
          id: unit.id, symbol: unit.symbol, name: unit.name, amount,
          last_updated: ts,
          quote: { USD: { price: amount * unit.unit_price_usd, last_updated: ts } },
        },
      };
    }
    default:
      throw new CmcError(`No fixture recorded for ${pathname}.`, { httpStatus: 404 });
  }
}

/* ------------------------------------------------------------ live calls */

async function liveGet(pathname, params) {
  if (!API_KEY) {
    throw new CmcError(
      'CMC_API_KEY is not configured on the server. Copy .env.example to .env and add your CoinMarketCap API key.',
      { httpStatus: 500 },
    );
  }
  const url = new URL(BASE_URL + pathname);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  let res;
  try {
    res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'X-CMC_PRO_API_KEY': API_KEY, // header auth; the key never leaves the server
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new CmcError(`Could not reach the CoinMarketCap API (${BASE_URL}): ${err.message}`, { httpStatus: 502 });
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    throw new CmcError(`CoinMarketCap API returned a non-JSON response (HTTP ${res.status}).`, { httpStatus: 502 });
  }

  const status = body && body.status ? body.status : {};
  if (!res.ok || (status.error_code && status.error_code !== 0)) {
    throw new CmcError(
      `CoinMarketCap API error ${status.error_code ?? res.status}: ${status.error_message || res.statusText}`,
      { httpStatus: res.status >= 400 && res.status < 600 ? res.status : 502, cmcCode: status.error_code ?? null },
    );
  }
  return body;
}

/* -------------------------------------------------------------- public API */

/**
 * GET a CMC endpoint with caching. Resolves to { data, meta } where meta
 * describes provenance: { source: 'coinmarketcap' | 'fixture', cached, stale,
 * creditCount, timestamp }. On upstream failure, an expired cache entry is
 * served with meta.stale = true rather than failing the request outright.
 */
async function cmcGet(pathname, params = {}) {
  const key = cacheKey(pathname, params);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { data: hit.body.data, meta: { ...hit.meta, cached: true, stale: false } };
  }

  try {
    const body = FIXTURES_ON ? fixtureGet(pathname, params) : await liveGet(pathname, params);
    const meta = {
      source: FIXTURES_ON ? 'fixture' : 'coinmarketcap',
      cached: false,
      stale: false,
      creditCount: body.status ? body.status.credit_count ?? null : null,
      timestamp: body.status ? body.status.timestamp ?? null : null,
    };
    cache.set(key, { at: Date.now(), body, meta });
    return { data: body.data, meta };
  } catch (err) {
    if (hit) {
      // Graceful degradation: serve the last good response, clearly flagged.
      return { data: hit.body.data, meta: { ...hit.meta, cached: true, stale: true } };
    }
    throw err;
  }
}

function config() {
  return {
    baseUrl: BASE_URL,
    keyConfigured: Boolean(API_KEY),
    fixtures: FIXTURES_ON,
    cacheTtlMs: CACHE_TTL_MS,
  };
}

module.exports = { cmcGet, CmcError, config };
