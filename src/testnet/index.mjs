/**
 * Testnet layer barrel (MASTER_SPEC Phase 8).
 *
 * Everything exported here is TESTNET ONLY. Importing this module is the one
 * sanctioned way for the system to reach an authenticated Bybit endpoint, and
 * each constructor still enforces the testnet guard independently.
 *
 * @module testnet
 */
export {
  MAINNET_PRIVATE_WS_URL,
  MAINNET_REST_BASE_URL,
  TESTNET_PATHS,
  TESTNET_PRIVATE_WS_URL,
  TESTNET_REST_BASE_URL,
  TESTNET_WRITE_PATHS,
  assertTestnetRestBaseUrl,
  isAllowedTestnetPath,
  isTestnetWritePath,
  resolveTestnetPrivateWsUrl,
} from './endpoints.mjs';
export { DEFAULT_RECV_WINDOW_MS, WS_AUTH_WINDOW_MS, buildAuthHeaders, buildWebSocketAuthMessage, signRequest, signWebSocketAuth } from './auth.mjs';
export { TESTNET_GUARD, assertTestnetMode, checkTestnetMode } from './mode-guard.mjs';
export { mapBybitOrder, mapBybitOrderStatus, mapBybitTimeInForce, toBybitOrderParams, toBybitSide } from './order-mapper.mjs';
export { initialOrderStatus, isKnownOrderStatus, isTerminalOrderStatus, reduceOrderStatus } from './order-state-machine.mjs';
export { createBybitTestnetRestClient } from './authenticated-rest-client.mjs';
export { createBybitTestnetPrivateWebSocket } from './private-websocket.mjs';
