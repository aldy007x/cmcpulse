# API Evidence — CoinMarketCap endpoints used by CMCPulse

CMCPulse never calls CoinMarketCap from the browser (CMC blocks browser calls
via CORS to protect API keys). The browser calls CMCPulse's own proxy routes;
the server calls CMC with the key in the `X-CMC_PRO_API_KEY` header.

| # | CMC endpoint | CMCPulse proxy route | Used for | Code |
|---|--------------|----------------------|----------|------|
| 1 | `GET /v1/cryptocurrency/listings/latest` | `GET /api/listings?limit=100` | Screener: top 100 coins by market cap | `server.js` (`/api/listings`), `lib/cmc.js` |
| 2 | `GET /v1/cryptocurrency/quotes/latest` | `GET /api/quotes?ids=…` or `?symbols=…` | Watchlist pricing, portfolio valuation, drawer quote | `server.js` (`/api/quotes`) |
| 3 | `GET /v1/cryptocurrency/info` | `GET /api/info?ids=…` | Coin detail drawer: description, logo, website, tags | `server.js` (`/api/info`) |
| 4 | `GET /v1/global-metrics/quotes/latest` | `GET /api/global-metrics` | Market header: total market cap, 24h volume, BTC/ETH dominance | `server.js` (`/api/global-metrics`) |
| 5 | `GET /v1/tools/price-conversion` | `GET /api/convert?amount=…&symbol=…` | Coin ⇄ USD converter in the detail drawer | `server.js` (`/api/convert`) |

All CMC requests are built in `lib/cmc.js` (`liveGet()` for HTTP, `fixtureGet()`
for the development fixture transport) and cached for `CMC_CACHE_TTL_MS`
(default 60 s) because CMC plans meter call credits per request.

## Response evidence in this folder

All five success-path files below are **REAL CoinMarketCap responses**,
captured live through the CMCPulse proxy against
`https://pro-api.coinmarketcap.com` on **2026-11-25 ~16:52 UTC** (Basic plan).
Each response carries the proxy envelope (`meta.source: "coinmarketcap"`,
`meta.creditCount: 1`). The API key appears nowhere in any of them.

| File | Source | What it shows |
|------|--------|---------------|
| `listings-latest.response.json` | **REAL** (pro-api, 2026-11-25) | Excerpt (first 2 of 5 returned) of `GET /api/listings?limit=5` — BTC at $58,338.19, ETH at $1,638.73 |
| `quotes-latest.response.json` | **REAL** (pro-api, 2026-11-25) | Full body of `GET /api/quotes?ids=1,1027` — the id-keyed quotes map for BTC + ETH |
| `info.response.json` | **REAL** (pro-api, 2026-11-25) | Full body of `GET /api/info?ids=1` — BTC metadata (description, logo, urls, tags) |
| `global-metrics.response.json` | **REAL** (pro-api, 2026-11-25) | Full body of `GET /api/global-metrics` — total market cap ≈ $2.006 T, BTC dominance ≈ 58.43 % |
| `price-conversion.response.json` | **REAL** (pro-api, 2026-11-25) | Full body of `GET /api/convert?amount=1&symbol=BTC` — 1 BTC = $58,338.19 |
| `live-pro-api-error.response.json` | **REAL** (pro-api, 2026-11-25) | CMC's actual reply to a keyless request: `error_code 1002, "API key missing."` — proves the production host/path/header contract our client implements |

Additionally verified live through the proxy: with an invalid key against
`pro-api.coinmarketcap.com`, CMC's real error is passed through cleanly —
`HTTP 401 {"error":{"code":1001,"message":"CoinMarketCap API error 1001: This API Key is invalid."}}`.

## Development fixtures

During development (before a real key was available), the success path was
verified against a fixture transport (`CMC_FIXTURES=1`) serving responses in
the documented CMC shapes, clearly labeled in the UI. Those fixtures remain in
`fixtures/` for offline development only; the evidence files above supersede
them and are the real API responses. No API key — real, sandbox, or the public
test key printed in CMC's docs — appears anywhere in this repository.
