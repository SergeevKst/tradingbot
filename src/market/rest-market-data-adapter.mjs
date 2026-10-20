/**
 * Backwards-compatible entry point for the Bybit REST market data adapter.
 *
 * The implementation now lives in `adapters/bybit/rest-market-data-adapter.mjs`
 * so that the exchange-specific REST client, retry policy and normalizers sit in
 * the Phase 2 adapter/normalizer modules. This file only re-exports it under the
 * historical name so existing imports keep working.
 *
 * Public and unauthenticated by construction: see the adapter module for the
 * no-credentials, GET-only contract.
 *
 * @module market/rest-market-data-adapter
 */
export { createBybitRestMarketDataAdapter as createRestMarketDataAdapter } from '../adapters/bybit/rest-market-data-adapter.mjs';
