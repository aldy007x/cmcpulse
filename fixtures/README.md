# Fixtures (development transport only)

These JSON files are **recorded sample responses** that follow the response
shapes documented in the official CoinMarketCap API reference. They exist so
the app can be developed and verified end-to-end in environments where the
CMC sandbox host is unreachable.

- They are used ONLY when the server is started with `CMC_FIXTURES=1`.
- Every response served from them is flagged `meta.source: "fixture"`, and
  the UI displays a prominent "FIXTURE MODE — not live market data" ribbon.
- Prices/figures are illustrative, internally consistent samples — **not**
  live market data, and never presented as such.
- `price-conversion-units.json` holds unit prices per symbol; the fixture
  transport multiplies by the requested amount to produce the documented
  `/v1/tools/price-conversion` response shape.

Production runs leave `CMC_FIXTURES` unset and always talk to the real API.
