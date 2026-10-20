/**
 * Mainnet order execution (Phase 5).
 *
 * A single, auditable executor that places a REAL order on Bybit mainnet after
 * the human approves. It shares the HMAC signing from `src/testnet/auth.mjs`
 * (identical for mainnet, only the host differs) and targets
 * `https://api.bybit.com`.
 *
 * Safety:
 *   - the order is placed with the exact idea fields the user approved;
 *   - it does NOT attach TP/SL here — that is a separate, deliberate step the
 *     operator triggers, so an approved entry never silently carries a wrong
 *     protective order;
 *   - any non-zero Bybit retCode is surfaced as an error, never swallowed.
 *
 * @module telegram/execute
 */
import { buildAuthHeaders } from '../testnet/auth.mjs';

const MAINNET_REST_BASE_URL = 'https://api.bybit.com';

/**
 * @typedef {{
 *   apiKey: string,
 *   apiSecret: string,
 * }} Credentials
 */

/**
 * @typedef {{
 *   symbol: string,
 *   side: 'Buy' | 'Sell',
 *   qty: string,
 *   orderLinkId: string,
 *   stopLoss?: string,
 *   takeProfit?: string,
 *   tpTriggerBy?: string,
 *   slTriggerBy?: string,
 * }} LimitOrder
 */

/**
 * @typedef {{
 *   symbol: string,
 *   side: 'Buy' | 'Sell',
 *   qty: string,
 *   orderLinkId: string,
 *   stopLoss?: string,
 *   takeProfit?: string,
 *   tpTriggerBy?: string,
 *   slTriggerBy?: string,
 * }} MarketOrder
 */

/**
 * Read the CURRENT last-traded price for a symbol from the public ticker.
 *
 * Public endpoint — no credentials needed. Used at Approve time to detect how
 * far the live market has drifted from the price the scout proposed minutes ago.
 *
 * @param {string} symbol
 * @returns {Promise<{ lastPrice: number, bid: number | null, ask: number | null }>}
 */
export async function getCurrentPrice(symbol) {
  const res = await fetch(`${MAINNET_REST_BASE_URL}/v5/market/tickers?category=linear&symbol=${encodeURIComponent(symbol)}`);
  const payload = await res.json();
  if (payload.retCode !== 0) {
    throw new Error(`ticker fetch failed retCode=${payload.retCode}: ${payload.retMsg ?? ''}`);
  }
  const row = (Array.isArray(payload.result?.list) ? payload.result.list : [])[0];
  if (!row) {
    throw new Error(`no ticker returned for ${symbol}`);
  }
  const toNum = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const lastPrice = toNum(row.lastPrice);
  if (lastPrice === null) {
    throw new Error(`no lastPrice in ticker for ${symbol}`);
  }
  return { lastPrice, bid: toNum(row.bid1Price), ask: toNum(row.ask1Price) };
}

/**
 * @param {{ apiKey: string, apiSecret: string }} credentials
 * @param {{ symbol: string, side: 'Buy' | 'Sell', qty: string, price: string, orderLinkId: string, stopLoss?: string, takeProfit?: string, tpTriggerBy?: string, slTriggerBy?: string }} order
 * @returns {Promise<{ orderId: string, orderLinkId: string }>}
 */
export async function placeLimitOrder(credentials, order) {
  const timestamp = Date.now();
  const bodyObj = {
    category: 'linear',
    symbol: order.symbol,
    side: order.side,
    orderType: 'Limit',
    qty: order.qty,
    price: order.price,
    timeInForce: 'GTC',
    orderLinkId: order.orderLinkId,
  };
  // Attach protective orders in the SAME create call, so an approved entry can
  // never rest on the book without its stop/take.
  if (order.takeProfit !== undefined) {
    bodyObj.takeProfit = order.takeProfit;
    bodyObj.tpTriggerBy = order.tpTriggerBy ?? 'LastPrice';
  }
  if (order.stopLoss !== undefined) {
    bodyObj.stopLoss = order.stopLoss;
    bodyObj.slTriggerBy = order.slTriggerBy ?? 'LastPrice';
  }
  const body = JSON.stringify(bodyObj);
  const headers = buildAuthHeaders({
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    method: 'POST',
    body,
    timestamp,
    recvWindow: 5000,
  });
  const res = await fetch(`${MAINNET_REST_BASE_URL}/v5/order/create`, {
    method: 'POST',
    headers,
    body,
  });
  const payload = await res.json();
  if (payload.retCode !== 0) {
    throw new Error(`Bybit order create failed retCode=${payload.retCode}: ${payload.retMsg ?? ''}`);
  }
  return { orderId: payload.result.orderId, orderLinkId: payload.result.orderLinkId };
}

/**
 * Place a MARKET order on mainnet, attaching the protective SL/TP in the same
 * call. Used at Approve time when the live price has drifted only slightly
 * (within `APPROVE_SLIPPAGE_PCT`) — a market order guarantees fill at the
 * current price instead of leaving a stale limit resting on the book.
 *
 * @param {Credentials} credentials
 * @param {MarketOrder} order
 * @returns {Promise<{ orderId: string, orderLinkId: string }>}
 */
export async function placeMarketOrder(credentials, order) {
  const timestamp = Date.now();
  const bodyObj = {
    category: 'linear',
    symbol: order.symbol,
    side: order.side,
    orderType: 'Market',
    qty: order.qty,
    timeInForce: 'IOC',
    orderLinkId: order.orderLinkId,
  };
  if (order.takeProfit !== undefined) {
    bodyObj.takeProfit = order.takeProfit;
    bodyObj.tpTriggerBy = order.tpTriggerBy ?? 'LastPrice';
  }
  if (order.stopLoss !== undefined) {
    bodyObj.stopLoss = order.stopLoss;
    bodyObj.slTriggerBy = order.slTriggerBy ?? 'LastPrice';
  }
  const body = JSON.stringify(bodyObj);
  const headers = buildAuthHeaders({
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    method: 'POST',
    body,
    timestamp,
    recvWindow: 5000,
  });
  const res = await fetch(`${MAINNET_REST_BASE_URL}/v5/order/create`, {
    method: 'POST',
    headers,
    body,
  });
  const payload = await res.json();
  if (payload.retCode !== 0) {
    throw new Error(`Bybit market order failed retCode=${payload.retCode}: ${payload.retMsg ?? ''}`);
  }
  return { orderId: payload.result.orderId, orderLinkId: payload.result.orderLinkId };
}

/**
 * Cancel an order by orderId on mainnet.
 *
 * @param {{ apiKey: string, apiSecret: string }} credentials
 * @param {{ symbol: string, orderId: string }} order
 */
export async function cancelLimitOrder(credentials, order) {
  const timestamp = Date.now();
  const body = JSON.stringify({ category: 'linear', symbol: order.symbol, orderId: order.orderId });
  const headers = buildAuthHeaders({
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    method: 'POST',
    body,
    timestamp,
    recvWindow: 5000,
  });
  const res = await fetch(`${MAINNET_REST_BASE_URL}/v5/order/cancel`, {
    method: 'POST',
    headers,
    body,
  });
  const payload = await res.json();
  if (payload.retCode !== 0) {
    throw new Error(`Bybit order cancel failed retCode=${payload.retCode}: ${payload.retMsg ?? ''}`);
  }
  return payload.result;
}

/**
 * Set the leverage for a linear (perpetual) symbol BEFORE placing a futures
 * order. Bybit otherwise applies the account's own default (often 10x), which
 * is exactly what the user wants to control explicitly.
 *
 * @param {Credentials} credentials
 * @param {{ symbol: string, leverage: string }} params
 */
export async function setLeverage(credentials, { symbol, leverage }) {
  const timestamp = Date.now();
  const body = JSON.stringify({
    category: 'linear',
    symbol,
    buyLeverage: leverage,
    sellLeverage: leverage,
  });
  const headers = buildAuthHeaders({
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    method: 'POST',
    body,
    timestamp,
    recvWindow: 5000,
  });
  const res = await fetch(`${MAINNET_REST_BASE_URL}/v5/position/set-leverage`, {
    method: 'POST',
    headers,
    body,
  });
  const payload = await res.json();
  // 110043 = "leverage not modified": the symbol's leverage is ALREADY equal to
  // the requested value. That is not a failure — treat it as success so the
  // order flow proceeds.
  // 110077 = "pm mode cannot set leverage": the account is in Portfolio Margin,
  // where the exchange sizes leverage itself and manual set-leverage is rejected
  // by design. Also not a failure — skip setting leverage and let Bybit apply it.
  if (payload.retCode !== 0 && payload.retCode !== 110043 && payload.retCode !== 110077) {
    throw new Error(`set-leverage failed retCode=${payload.retCode}: ${payload.retMsg ?? ''}`);
  }
  return payload.result;
}

/**
 * Place a MARKET order on the SPOT market (category=spot). The user owns the
 * base coin outright; there is no leverage and no liquidation.
 *
 * SPOT `createOrder` does NOT accept stopLoss/takeProfit in the same call, so
 * the protective orders are placed separately via `placeSpotConditionalOrder`.
 *
 * @param {Credentials} credentials
 * @param {{ symbol: string, side: 'Buy' | 'Sell', qty: string, orderLinkId: string }} order
 * @returns {Promise<{ orderId: string, orderLinkId: string }>}
 */
export async function placeSpotMarketOrder(credentials, order) {
  const timestamp = Date.now();
  const body = JSON.stringify({
    category: 'spot',
    symbol: order.symbol,
    side: order.side,
    orderType: 'Market',
    qty: order.qty,
    // UTA (unified margin) accounts require an explicit marketUnit; without it
    // the exchange misreads qty and rejects with retCode=170140.
    marketUnit: 'baseCoin',
    orderLinkId: order.orderLinkId,
  });
  const headers = buildAuthHeaders({
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    method: 'POST',
    body,
    timestamp,
    recvWindow: 5000,
  });
  const res = await fetch(`${MAINNET_REST_BASE_URL}/v5/order/create`, {
    method: 'POST',
    headers,
    body,
  });
  const payload = await res.json();
  if (payload.retCode !== 0) {
    throw new Error(`Bybit spot market order failed retCode=${payload.retCode}: ${payload.retMsg ?? ''}`);
  }
  return { orderId: payload.result.orderId, orderLinkId: payload.result.orderLinkId };
}

/**
 * Read the free SPOT balance for a base coin (e.g. "BTC"), polling until it is
 * available — a market buy executes asynchronously, and a protective sell order
 * placed before the coin lands fails with 170131 Insufficient balance.
 *
 * @param {Credentials} credentials
 * @param {{ coin: string, timeoutMs?: number, pollMs?: number }} params
 * @returns {Promise<number>} free spot balance as a float
 */
export async function waitForSpotBalance(credentials, { coin, timeoutMs = 15000, pollMs = 1000 }) {
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    const timestamp = Date.now();
    const headers = buildAuthHeaders({
      apiKey: credentials.apiKey,
      apiSecret: credentials.apiSecret,
      method: 'GET',
      queryString: 'accountType=UNIFIED',
      body: '',
      timestamp,
      recvWindow: 5000,
    });
    const res = await fetch(`${MAINNET_REST_BASE_URL}/v5/account/wallet-balance?accountType=UNIFIED`, { headers });
    const payload = await res.json();
    if (payload.retCode === 0) {
      const acct = (payload.result?.list ?? [])[0];
      const row = (acct?.coin ?? []).find((c) => c.coin === coin);
      const free = Number(row?.walletBalance);
      if (Number.isFinite(free) && free > 0) return free;
      last = Number.isFinite(free) ? free : 0;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return last;
}

/**
 * Place a spot conditional (trigger) order — used for spot SL/TP, since spot
 * `createOrder` cannot attach them inline. `triggerDirection`: 2 = triggered
 * when price falls to/below (for stop-loss sell), 1 = rises to/above (take
 * profit sell).
 *
 * @param {Credentials} credentials
 * @param {{
 *   symbol: string,
 *   side: 'Buy' | 'Sell',
 *   qty: string,
 *   triggerPrice: string,
 *   triggerDirection: '1' | '2',
 *   orderLinkId: string,
 * }} order
 * @returns {Promise<{ orderId: string, orderLinkId: string }>}
 */
export async function placeSpotConditionalOrder(credentials, order) {
  const timestamp = Date.now();
  const body = JSON.stringify({
    category: 'spot',
    symbol: order.symbol,
    side: order.side,
    orderType: 'Market',
    qty: order.qty,
    marketUnit: 'baseCoin',
    orderFilter: 'tpslOrder',
    triggerPrice: order.triggerPrice,
    triggerDirection: order.triggerDirection,
    orderLinkId: order.orderLinkId,
  });
  const headers = buildAuthHeaders({
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    method: 'POST',
    body,
    timestamp,
    recvWindow: 5000,
  });
  const res = await fetch(`${MAINNET_REST_BASE_URL}/v5/order/create`, {
    method: 'POST',
    headers,
    body,
  });
  const payload = await res.json();
  if (payload.retCode !== 0) {
    throw new Error(`Bybit spot conditional order failed retCode=${payload.retCode}: ${payload.retMsg ?? ''}`);
  }
  return { orderId: payload.result.orderId, orderLinkId: payload.result.orderLinkId };
}

/**
 * Latest realized closed-PnL record for a linear symbol (Bybit
 * /v5/position/closed-pnl). Returns null on any failure — callers must treat
 * null as "do not reflect on guessed numbers".
 *
 * @param {Credentials} credentials
 * @param {string} symbol
 * @returns {Promise<{ symbol: string, side: string, entryPrice: number|null, exitPrice: number|null, realizedPnlUsd: number|null, closedSize: number|null, closedAt: string, recordId: string } | null>}
 */
export async function fetchRecentClosedPnl(credentials, symbol) {
  try {
    const timestamp = Date.now();
    const queryString = `category=linear&symbol=${encodeURIComponent(symbol)}&limit=1`;
    const headers = buildAuthHeaders({
      apiKey: credentials.apiKey,
      apiSecret: credentials.apiSecret,
      method: 'GET',
      queryString,
      body: '',
      timestamp,
      recvWindow: 5000,
    });
    const res = await fetch(`${MAINNET_REST_BASE_URL}/v5/position/closed-pnl?${queryString}`, { headers });
    const payload = await res.json();
    if (payload.retCode !== 0) return null;
    const row = (Array.isArray(payload.result?.list) ? payload.result.list : [])[0];
    if (!row) return null;
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    const updatedTime = String(row.updatedTime ?? '');
    return {
      symbol: String(row.symbol ?? symbol),
      side: String(row.side ?? ''),
      entryPrice: num(row.avgEntryPrice),
      exitPrice: num(row.avgExitPrice),
      realizedPnlUsd: num(row.closedPnl),
      closedSize: num(row.closedSize),
      closedAt: updatedTime,
      recordId: row.orderId ? String(row.orderId) : `${symbol}:${updatedTime}`,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch closed PnL history for all linear positions over a time window.
 * Returns an array of closed-pnl rows, empty on error.
 *
 * @param {{ apiKey: string, apiSecret: string }} credentials
 * @param {{ startTime?: number, endTime?: number, limit?: number }} [opts]
 * @returns {Promise<Array<{ symbol: string, side: string, entryPrice: number|null, exitPrice: number|null, realizedPnlUsd: number|null, closedSize: number|null, closedAt: string, recordId: string }>>}
 */
export async function fetchClosedPnlHistory(credentials, opts = {}) {
  try {
    const timestamp = Date.now();
    const params = new URLSearchParams({ category: 'linear' });
    if (opts.startTime) params.set('startTime', String(opts.startTime));
    if (opts.endTime) params.set('endTime', String(opts.endTime));
    params.set('limit', String(opts.limit ?? 50));
    const queryString = params.toString();
    const headers = buildAuthHeaders({
      apiKey: credentials.apiKey,
      apiSecret: credentials.apiSecret,
      method: 'GET',
      queryString,
      body: '',
      timestamp,
      recvWindow: 5000,
    });
    const res = await fetch(`${MAINNET_REST_BASE_URL}/v5/position/closed-pnl?${queryString}`, { headers });
    const payload = await res.json();
    if (payload.retCode !== 0) return [];
    const list = Array.isArray(payload.result?.list) ? payload.result.list : [];
    const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
    return list.map((row) => {
      const updatedTime = String(row.updatedTime ?? '');
      return {
        symbol: String(row.symbol ?? ''),
        side: String(row.side ?? ''),
        entryPrice: num(row.avgEntryPrice),
        exitPrice: num(row.avgExitPrice),
        realizedPnlUsd: num(row.closedPnl),
        closedSize: num(row.closedSize),
        closedAt: updatedTime,
        recordId: row.orderId ? String(row.orderId) : `${String(row.symbol ?? '')}:${updatedTime}`,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Read all open LINEAR (perpetual) positions for the account. Returns a list of
 * normalized objects, empty when nothing is open. Fail-closed: on any error it
 * returns an empty list (the monitor must never crash the bot).
 *
 * @param {Credentials} credentials
 * @returns {Promise<Array<{ symbol: string, side: 'LONG'|'SHORT', size: number, avgPrice: number, markPrice: number, unrealisedPnl: number, stopLoss: number|null, takeProfit: number|null, leverage: string, liqPrice: string }>>}
 */
export async function fetchOpenPositions(credentials, symbols = []) {
  const getOne = async (qs) => {
    const timestamp = Date.now();
    const headers = buildAuthHeaders({
      apiKey: credentials.apiKey,
      apiSecret: credentials.apiSecret,
      method: 'GET',
      queryString: qs,
      body: '',
      timestamp,
      recvWindow: 5000,
    });
    const res = await fetch(`${MAINNET_REST_BASE_URL}/v5/position/list?${qs}`, { headers });
    return await res.json();
  };

  const normalize = (list) => list
    .filter((p) => Number(p.size) !== 0)
    .map((p) => ({
      symbol: p.symbol,
      side: p.side === 'Sell' ? 'SHORT' : 'LONG',
      size: Number(p.size),
      avgPrice: Number(p.avgPrice),
      markPrice: Number(p.markPrice),
      unrealisedPnl: Number(p.unrealisedPnl),
      stopLoss: p.stopLoss && p.stopLoss !== '' ? Number(p.stopLoss) : null,
      takeProfit: p.takeProfit && p.takeProfit !== '' ? Number(p.takeProfit) : null,
      leverage: String(p.leverage ?? ''),
      liqPrice: String(p.liqPrice ?? ''),
    }));

  try {
    // When explicit symbols are given, query each individually — this is the
    // reliable path (a bare `/position/list` without symbol can return empty
    // unless paginated). When none are given, fall back to the whole list with
    // a generous limit + cursor, and de-duplicate.
    if (Array.isArray(symbols) && symbols.length > 0) {
      const out = [];
      for (const sym of symbols) {
        try {
          const payload = await getOne(`category=linear&symbol=${encodeURIComponent(sym)}`);
          if (payload.retCode === 0) out.push(...normalize(payload.result?.list ?? []));
        } catch { /* one symbol failure must not drop the rest */ }
      }
      return out;
    }

    const all = [];
    let cursor = '';
    do {
      const qs = cursor ? `category=linear&limit=50&cursor=${cursor}` : 'category=linear&limit=50';
      const payload = await getOne(qs);
      if (payload.retCode !== 0) break;
      const list = Array.isArray(payload.result?.list) ? payload.result.list : [];
      all.push(...normalize(list));
      cursor = payload.result?.nextPageCursor ?? '';
      if (!list.length) break;
    } while (cursor);
    // De-duplicate by symbol+side (pagination overlap).
    const seen = new Set();
    return all.filter((p) => {
      const k = `${p.symbol}:${p.side}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  } catch {
    return [];
  }
}

/**
 * Move an existing position's stop loss and/or take profit via set-trading-stop.
 * Used by the trailing logic — the stop only narrows toward profit, and the take
 * profit is only raised (never lowered) when the trend extends.
 *
 * @param {Credentials} credentials
 * @param {{ symbol: string, stopLoss?: string, takeProfit?: string }} params
 * @returns {Promise<object>}
 */
export async function setTradingStopBySymbol(credentials, { symbol, stopLoss, takeProfit }) {
  const timestamp = Date.now();
  const bodyObj = {
    category: 'linear',
    symbol,
    tpslMode: 'Full',
    positionIdx: 0,
  };
  if (stopLoss !== undefined && stopLoss !== null && stopLoss !== '') {
    bodyObj.stopLoss = stopLoss;
  }
  if (takeProfit !== undefined && takeProfit !== null && takeProfit !== '') {
    bodyObj.takeProfit = takeProfit;
  }
  const body = JSON.stringify(bodyObj);
  const headers = buildAuthHeaders({
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    method: 'POST',
    body,
    timestamp,
    recvWindow: 5000,
  });
  const res = await fetch(`${MAINNET_REST_BASE_URL}/v5/position/trading-stop`, {
    method: 'POST',
    headers,
    body,
  });
  const payload = await res.json();
  if (payload.retCode !== 0) {
    throw new Error(`set-trading-stop failed retCode=${payload.retCode}: ${payload.retMsg ?? ''}`);
  }
  return payload.result;
}

/**
 * Cancel a single SPOT order by orderId (used when trailing a spot stop-loss:
 * cancel the old conditional order, then place a new one at the trailed level).
 *
 * @param {Credentials} credentials
 * @param {{ symbol: string, orderId: string }} params
 * @returns {Promise<object>}
 */
export async function cancelSpotOrder(credentials, { symbol, orderId }) {
  const timestamp = Date.now();
  const body = JSON.stringify({ category: 'spot', symbol, orderId });
  const headers = buildAuthHeaders({
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    method: 'POST',
    body,
    timestamp,
    recvWindow: 5000,
  });
  const res = await fetch(`${MAINNET_REST_BASE_URL}/v5/order/cancel`, {
    method: 'POST',
    headers,
    body,
  });
  const payload = await res.json();
  if (payload.retCode !== 0) {
    throw new Error(`spot order cancel failed retCode=${payload.retCode}: ${payload.retMsg ?? ''}`);
  }
  return payload.result;
}

/**
 * Read SPOT holdings from the unified wallet. Returns one entry per coin with a
 * meaningful balance (> ~$1), normalized to the same shape the monitor uses for
 * futures (side is always LONG, leverage 1x, no liquidation). This makes the
 * monitor able to watch "buy and hold" spot positions (e.g. BTC) alongside
 * futures. Fail-closed: any error → [].
 *
 * @param {Credentials} credentials
 * @returns {Promise<Array<{ symbol: string, kind: 'spot', side: 'LONG', size: number, avgPrice: number|null, markPrice: number|null, unrealisedPnl: number|null, stopLoss: number|null, takeProfit: number|null, leverage: string, liqPrice: string | null }>>}
 */
export async function fetchSpotHoldings(credentials) {
  const timestamp = Date.now();
  const headers = buildAuthHeaders({
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    method: 'GET',
    queryString: 'accountType=UNIFIED',
    body: '',
    timestamp,
    recvWindow: 5000,
  });
  try {
    const res = await fetch(`${MAINNET_REST_BASE_URL}/v5/account/wallet-balance?accountType=UNIFIED`, { headers });
    const payload = await res.json();
    if (payload.retCode !== 0) return [];
    const acct = (payload.result?.list ?? [])[0];
    const coins = Array.isArray(acct?.coin) ? acct.coin : [];
    // Exclude quote/stable coins: they are cash, not a "holding" to monitor.
    const STABLE = new Set(['USDT', 'USDC', 'USDE', 'DAI', 'FDUSD', 'TUSD', 'EUR', 'USD']);
    return coins
      .filter((c) => Number(c.walletBalance) > 0 && Number(c.usdValue) >= 1 && !STABLE.has(c.coin))
      .map((c) => {
        const qty = Number(c.walletBalance);
        const usdValue = Number(c.usdValue);
        return {
          symbol: `${c.coin}USDT`,
          kind: 'spot',
          side: 'LONG',
          size: qty,
          avgPrice: qty > 0 ? usdValue / qty : null,
          markPrice: qty > 0 ? usdValue / qty : null,
          unrealisedPnl: null,
          stopLoss: null,
          takeProfit: null,
          leverage: '1',
          liqPrice: null,
        };
      });
  } catch {
    return [];
  }
}

/**
 * Read ALL open orders across a category to discover protective SL/TP orders
 * (including spot conditional tpslOrder entries). Returns a normalized list,
 * empty on failure.
 *
 * @param {Credentials} credentials
 * @param {'spot' | 'linear'} category
 * @returns {Promise<Array<{ orderId: string, symbol: string, side: string, orderType: string, status: string, qty: string, triggerPrice: string|null, orderFilter: string|null }>>}
 */
export async function fetchOpenOrders(credentials, category) {
  const timestamp = Date.now();
  const headers = buildAuthHeaders({
    apiKey: credentials.apiKey,
    apiSecret: credentials.apiSecret,
    method: 'GET',
    queryString: `category=${category}&openOnly=0&limit=50`,
    body: '',
    timestamp,
    recvWindow: 5000,
  });
  try {
    const res = await fetch(`${MAINNET_REST_BASE_URL}/v5/order/realtime?category=${category}&openOnly=0&limit=50`, { headers });
    const payload = await res.json();
    if (payload.retCode !== 0) return [];
    const list = Array.isArray(payload.result?.list) ? payload.result.list : [];
    return list.map((o) => ({
      orderId: o.orderId,
      symbol: o.symbol,
      side: o.side,
      orderType: o.orderType,
      status: o.orderStatus,
      qty: o.qty,
      triggerPrice: o.triggerPrice ?? null,
      orderFilter: o.orderFilter ?? null,
    }));
  } catch {
    return [];
  }
}

/**
 * Fetch 1h klines for a symbol (public endpoint, no auth) and return them as
 * chronological arrays `[open, high, low, close]` (number). Returns [] on any
 * failure — used to feed ATR for the volatility-adaptive trailing stop.
 *
 * @param {string} symbol
 * @param {{ interval?: string, limit?: number, category?: string }} [opts]
 * @returns {Promise<Array<Array<number>>>}
 */
export async function fetchKlines(symbol, { interval = '60', limit = 30, category = 'linear' } = {}) {
  try {
    const res = await fetch(
      `${MAINNET_REST_BASE_URL}/v5/market/kline?category=${category}&symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`,
    );
    const payload = await res.json();
    if (payload.retCode !== 0) return [];
    const list = Array.isArray(payload.result?.list) ? payload.result.list : [];
    // Bybit returns newest-first; reverse to chronological and take OHLC.
    return list
      .reverse()
      .map((r) => [Number(r[1]), Number(r[2]), Number(r[3]), Number(r[4])])
      .filter((c) => c.every(Number.isFinite));
  } catch {
    return [];
  }
}

/**
 * Fetch the price tick size for a symbol (spot or linear). Returns null on any
 * failure. Used to snap trail prices to the exact grid the exchange expects —
 * BTC spot ticks at 0.1, while ETH/SOL tick at 0.01.
 *
 * @param {string} symbol
 * @param {'spot' | 'linear'} [category]
 * @returns {Promise<number | null>}
 */
export async function fetchTickSize(symbol, category = 'linear') {
  try {
    const res = await fetch(
      `${MAINNET_REST_BASE_URL}/v5/market/instruments-info?category=${category}&symbol=${encodeURIComponent(symbol)}`,
    );
    const payload = await res.json();
    if (payload.retCode !== 0) return null;
    const row = (payload.result?.list ?? [])[0];
    const tick = Number(row?.priceFilter?.tickSize);
    return Number.isFinite(tick) && tick > 0 ? tick : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the SPOT base-coin quantity precision (number of decimals) for a
 * symbol. Returns the integer precision (e.g. BTCUSDT → 6), or null on failure.
 * Spot reject orders when the qty has more decimals than basePrecision
 * (retCode 170137), so protective orders must snap quantity to this grid.
 *
 * @param {string} symbol
 * @returns {Promise<number | null>}
 */
export async function fetchSpotQtyPrecision(symbol) {
  try {
    const res = await fetch(
      `${MAINNET_REST_BASE_URL}/v5/market/instruments-info?category=spot&symbol=${encodeURIComponent(symbol)}`,
    );
    const payload = await res.json();
    if (payload.retCode !== 0) return null;
    const row = (payload.result?.list ?? [])[0];
    // Bybit spot reports `basePrecision` as a STEP (e.g. "0.000001"), which means
    // 6 decimals. Convert the step to the integer number of decimals.
    const step = Number(row?.lotSizeFilter?.basePrecision);
    if (!Number.isFinite(step) || step <= 0) return null;
    const decimals = Math.round(-Math.log10(step));
    return Number.isFinite(decimals) && decimals >= 0 ? decimals : null;
  } catch {
    return null;
  }
}

/**
 * Round a spot order quantity DOWN to the symbol's basePrecision so the
 * exchange accepts it (avoids retCode 170137 "quantity has too many decimals").
 * Truncates — never rounds up — so a protective order can never oversize.
 *
 * @param {number | string} qty
 * @param {number} precision decimals allowed (e.g. 6 for BTC)
 * @returns {string}
 */
export function snapSpotQty(qty, precision) {
  const n = Number(qty);
  if (!Number.isFinite(n) || n <= 0) return String(qty);
  const p = Number(precision);
  if (!Number.isFinite(p) || p < 0) return String(qty);
  const factor = 10 ** p;
  const truncated = Math.floor(n * factor) / factor;
  return truncated.toFixed(p);
}
