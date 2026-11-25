'use strict';

/**
 * CMCPulse server.
 *
 * One Node process serves the static frontend AND proxies CoinMarketCap API
 * calls under /api/*. The CMC API blocks browser requests via CORS (by
 * design, to protect API keys), so the browser talks to this server and this
 * server — holding CMC_API_KEY in its environment only — talks to CMC.
 */

// --- tiny .env loader (no dependency): real env vars always win ----------
const fs = require('node:fs');
const path = require('node:path');
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const express = require('express');
const { cmcGet, CmcError, config } = require('./lib/cmc');

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------ validation */

function parseIds(raw) {
  if (!raw) return null;
  const ids = String(raw).split(',').map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0 || ids.length > 100 || !ids.every((s) => /^\d+$/.test(s))) return null;
  return ids.join(',');
}

function parseSymbols(raw) {
  if (!raw) return null;
  const syms = String(raw).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (syms.length === 0 || syms.length > 100 || !syms.every((s) => /^[A-Z0-9]{1,15}$/.test(s))) return null;
  return syms.join(',');
}

function sendData(res, { data, meta }) {
  res.json({ data, meta });
}

function handleError(res, err) {
  if (err instanceof CmcError) {
    return res.status(err.httpStatus).json({
      error: { code: err.cmcCode, message: err.message },
    });
  }
  console.error(err);
  return res.status(500).json({ error: { code: null, message: 'Internal server error.' } });
}

/* ---------------------------------------------------------------- routes */

// Market header — CMC: GET /v1/global-metrics/quotes/latest
app.get('/api/global-metrics', async (req, res) => {
  try {
    sendData(res, await cmcGet('/v1/global-metrics/quotes/latest', { convert: 'USD' }));
  } catch (err) {
    handleError(res, err);
  }
});

// Screener — CMC: GET /v1/cryptocurrency/listings/latest
app.get('/api/listings', async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 100) || 100));
  try {
    sendData(
      res,
      await cmcGet('/v1/cryptocurrency/listings/latest', { start: 1, limit, convert: 'USD' }),
    );
  } catch (err) {
    handleError(res, err);
  }
});

// Watchlist / portfolio pricing — CMC: GET /v1/cryptocurrency/quotes/latest
app.get('/api/quotes', async (req, res) => {
  const ids = parseIds(req.query.ids);
  const symbols = ids ? null : parseSymbols(req.query.symbols);
  if (!ids && !symbols) {
    return res.status(400).json({
      error: { code: null, message: 'Provide ?ids=1,1027 or ?symbols=BTC,ETH.' },
    });
  }
  const params = { convert: 'USD', ...(ids ? { id: ids } : { symbol: symbols }) };
  try {
    sendData(res, await cmcGet('/v1/cryptocurrency/quotes/latest', params));
  } catch (err) {
    handleError(res, err);
  }
});

// Coin detail metadata — CMC: GET /v1/cryptocurrency/info
app.get('/api/info', async (req, res) => {
  const ids = parseIds(req.query.ids);
  const symbols = ids ? null : parseSymbols(req.query.symbols);
  if (!ids && !symbols) {
    return res.status(400).json({
      error: { code: null, message: 'Provide ?ids=1,1027 or ?symbols=BTC,ETH.' },
    });
  }
  const params = ids ? { id: ids } : { symbol: symbols };
  try {
    sendData(res, await cmcGet('/v1/cryptocurrency/info', params));
  } catch (err) {
    handleError(res, err);
  }
});

// Converter — CMC: GET /v1/tools/price-conversion
app.get('/api/convert', async (req, res) => {
  const amount = Number(req.query.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({
      error: { code: null, message: 'amount must be a positive number.' },
    });
  }
  const ids = parseIds(req.query.id);
  const symbols = ids ? null : parseSymbols(req.query.symbol);
  if (!ids && !symbols) {
    return res.status(400).json({
      error: { code: null, message: 'Provide the coin as ?symbol=BTC or ?id=1.' },
    });
  }
  const convert = String(req.query.convert || 'USD').toUpperCase();
  if (!/^[A-Z]{3,5}$/.test(convert)) {
    return res.status(400).json({ error: { code: null, message: 'convert must be a currency code like USD.' } });
  }
  const params = { amount, convert, ...(ids ? { id: ids } : { symbol: symbols }) };
  try {
    sendData(res, await cmcGet('/v1/tools/price-conversion', params));
  } catch (err) {
    handleError(res, err);
  }
});

// Diagnostics — reports configuration state, never the key itself.
app.get('/api/health', (req, res) => {
  const cfg = config();
  res.json({
    ok: true,
    cmcBaseUrl: cfg.baseUrl,
    apiKeyConfigured: cfg.keyConfigured,
    transport: cfg.fixtures ? 'fixture' : 'live',
    cacheTtlMs: cfg.cacheTtlMs,
  });
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: { code: null, message: `Unknown API route: ${req.method} ${req.originalUrl}` } });
});

app.listen(PORT, () => {
  const cfg = config();
  console.log(`CMCPulse listening on http://localhost:${PORT}`);
  console.log(`CMC base URL: ${cfg.baseUrl} | transport: ${cfg.fixtures ? 'FIXTURE (recorded responses)' : 'live'} | API key configured: ${cfg.keyConfigured}`);
});
