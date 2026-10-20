/**
 * TestnetExecutionAdapter — the authenticated TESTNET execution port.
 *
 * This is the one adapter that may place an order on an exchange, and it is
 * pinned to api-testnet.bybit.com with dedicated testnet credentials. It is NOT
 * a live adapter: `canPlaceRealOrders` stays false because no real-money order
 * is ever placed, and `isLiveMode` refuses to treat TESTNET as LIVE.
 *
 * Design boundary
 * ---------------
 * The adapter itself holds no signing, no HTTP and no credentials. It is handed
 * an already-constructed authenticated testnet client (and, optionally, a
 * reconciliation engine wrapping it) and it refuses any client that does not
 * declare `testnet === true` with the testnet host. Order submission is routed
 * through the SAME `ReconciliationEngine` used everywhere else, so the
 * at-most-once/idempotency and ambiguous-failure recovery guarantees are not
 * re-implemented here.
 *
 * What it deliberately does NOT do:
 *   - it never changes leverage or margin mode;
 *   - it cannot amend an order or set an exchange-side trading stop (those
 *     operations are absent capabilities, not deferred features);
 *   - `closePosition`/`modifyPositionProtection` fail closed rather than issue
 *     an un-idempotent reduce order on a path this task does not arm.
 *
 * @module execution/testnet-execution-adapter
 */
import { ConfigError } from '../config/config-error.mjs';
import { REASON_CODE } from '../domain/reason-code.mjs';
import { ORDER_TYPE, TIME_IN_FORCE } from '../types/enums.mjs';
import { createOrderRequest } from '../domain/order.mjs';
import { createReconciliationEngine } from '../reconciliation/reconciliation-engine.mjs';
import { TESTNET_REST_BASE_URL } from '../testnet/endpoints.mjs';
import { assertExecutionAdapter } from './execution-adapter.mjs';

const NOOP_LOGGER = Object.freeze({ info() {}, warn() {}, error() {}, debug() {} });

/**
 * @typedef {object} TestnetAdapterOptions
 * @property {object} client authenticated testnet REST client (declares testnet === true)
 * @property {true} testnet explicit testnet acknowledgement; never inferred
 * @property {() => Promise<object>} accountProvider current account view for the Risk Engine
 * @property {object} [reconciliation] an existing reconciliation engine wrapping `client`
 * @property {object} [journal] append hook or { record }
 * @property {() => string} [now] injected clock returning an ISO timestamp
 * @property {object} [logger]
 * @property {boolean} [oneShot] enforce at most ONE order submission (TESTNET_ONCE)
 */

/**
 * Build the testnet execution adapter.
 *
 * @param {TestnetAdapterOptions} options
 * @returns {import('./execution-adapter.mjs').ExecutionAdapter}
 * @throws {ConfigError} when the context is not unambiguously testnet
 */
export function createTestnetExecutionAdapter(options) {
  if (options === null || typeof options !== 'object') {
    throw new ConfigError('createTestnetExecutionAdapter requires options');
  }
  if (options.testnet !== true) {
    throw new ConfigError('TestnetExecutionAdapter requires an explicit testnet=true; it is never inferred', {
      field: 'testnet',
    });
  }
  const client = options.client;
  if (client === null || typeof client !== 'object' || typeof client.placeOrder !== 'function') {
    throw new ConfigError('TestnetExecutionAdapter requires an authenticated testnet client with placeOrder()', {
      field: 'client',
    });
  }
  if (client.testnet !== true) {
    throw new ConfigError('TestnetExecutionAdapter refuses a client that is not explicitly testnet', {
      field: 'client.testnet',
    });
  }
  const baseUrl = typeof client.baseUrl === 'string' ? client.baseUrl.trim().replace(/\/+$/, '') : '';
  if (baseUrl !== TESTNET_REST_BASE_URL) {
    throw new ConfigError(`TestnetExecutionAdapter refuses any host other than ${TESTNET_REST_BASE_URL}`, {
      field: 'client.baseUrl',
      value: client.baseUrl,
    });
  }
  if (typeof options.accountProvider !== 'function') {
    throw new ConfigError('TestnetExecutionAdapter requires an accountProvider() for the Risk Engine', {
      field: 'accountProvider',
    });
  }

  const now = options.now ?? (() => new Date().toISOString());
  const logger = options.logger ?? NOOP_LOGGER;
  const accountProvider = options.accountProvider;

  // Hard one-order invariant for TESTNET_ONCE. The counter is incremented at the
  // exact point a submission is handed to the reconciliation engine — i.e. as
  // close to the exchange write as this adapter can get — so a second attempt is
  // refused even when the first one failed at the exchange. Off by default, so
  // continuous TESTNET is untouched.
  const oneShot = options.oneShot === true;
  let orderAttempts = 0;

  const reconciliation =
    options.reconciliation ??
    createReconciliationEngine({
      exchange: client,
      journal: options.journal,
      now,
      logger,
    });

  /**
   * Build the risk-approved order the exchange will receive. Entries are market
   * orders: the Risk Engine approved a quantity, not a resting price.
   *
   * @param {import('./execution-adapter.mjs').OpenPositionRequest} request
   */
  function toOrderRequest(request) {
    const { proposal, riskResult } = request;
    const timestamp = Number.isFinite(proposal?.timestamp) ? proposal.timestamp : Date.parse(now());
    return createOrderRequest({
      symbol: proposal.symbol,
      side: proposal.side,
      type: ORDER_TYPE.MARKET,
      quantity: riskResult.estimatedQuantity,
      stopLossPrice: Number.isFinite(proposal.stopLossPrice) ? proposal.stopLossPrice : undefined,
      takeProfitPrice: Number.isFinite(proposal.takeProfitPrice) ? proposal.takeProfitPrice : undefined,
      leverage: Number.isFinite(riskResult.maxAllowedLeverage) ? riskResult.maxAllowedLeverage : undefined,
      timeInForce: TIME_IN_FORCE.IOC,
      timestamp,
    });
  }

  /**
   * A deterministic idempotency identity for one approved trade. Distinct
   * proposals share no `intentId`; a retry of the same proposal does.
   *
   * @param {import('./execution-adapter.mjs').OpenPositionRequest} request
   */
  function toIntent(request) {
    const { proposal } = request;
    return {
      strategyId: proposal.strategyId,
      intentId: `${proposal.strategyId}:${proposal.timestamp}:${proposal.entryPrice}`,
    };
  }

  /**
   * @param {object} order the reconciliation guard record
   * @param {import('./execution-adapter.mjs').OpenPositionRequest} request
   */
  function toFill(order, request) {
    const quantity = Number.isFinite(order?.quantity) ? order.quantity : request.riskResult.estimatedQuantity;
    const filledQuantity = Number.isFinite(order?.filledQuantity) ? order.filledQuantity : 0;
    if (filledQuantity <= 0) return null;
    const fillPrice = Number.isFinite(order?.averagePrice)
      ? order.averagePrice
      : Number.isFinite(order?.price)
        ? order.price
        : request.proposal.entryPrice;
    return {
      symbol: order.symbol,
      side: order.side,
      quantity: filledQuantity,
      requestedQuantity: quantity,
      filledQuantity,
      unfilledQuantity: Math.max(0, quantity - filledQuantity),
      partial: filledQuantity < quantity,
      requestedPrice: request.proposal.entryPrice,
      fillPrice,
      slippageUsd: (fillPrice - request.proposal.entryPrice) * filledQuantity * (order.side === 'LONG' ? 1 : -1),
      feeUsd: 0,
      notionalUsd: fillPrice * filledQuantity,
      timestamp: now(),
      orderId: order.orderId ?? null,
      clientOrderId: order.clientOrderId ?? null,
    };
  }

  const adapter = {
    kind: () => 'TESTNET',
    // No real-money order can originate here: TESTNET is pinned to the testnet
    // host. The reconciliation engine still routes every submission through the
    // idempotency and ambiguous-failure machinery.
    canPlaceRealOrders: false,
    // Declares whether this adapter enforces the TESTNET_ONCE invariant itself.
    oneShot,
    /** How many order submissions have been attempted through this adapter. */
    ordersAttempted: () => orderAttempts,

    /**
     * Submit a risk-approved entry as an authenticated testnet order.
     *
     * @param {import('./execution-adapter.mjs').OpenPositionRequest} request
     * @returns {Promise<import('./execution-adapter.mjs').ExecutionResult>}
     */
    async openPosition(request) {
      if (oneShot && orderAttempts >= 1) {
        logger.warn('one-shot testnet submission refused: the single permitted order was already attempted', {
          attempts: orderAttempts,
        });
        return {
          ok: false,
          reasonCode: REASON_CODE.ONE_SHOT_EXHAUSTED,
          message:
            'TESTNET_ONCE permits exactly one order submission; the single permitted attempt has already been made.',
        };
      }
      try {
        const { proposal, riskResult } = request ?? {};
        if (riskResult === null || typeof riskResult !== 'object' || riskResult.approved !== true) {
          return {
            ok: false,
            reasonCode: REASON_CODE.EXECUTION_REQUIRES_APPROVAL,
            message:
              'The testnet executor only executes orders the Risk Engine approved; it does not decide whether a trade may open.',
          };
        }
        if (!Number.isFinite(riskResult.estimatedQuantity) || riskResult.estimatedQuantity <= 0) {
          return {
            ok: false,
            reasonCode: REASON_CODE.UNREPRESENTABLE_QUANTITY,
            message: 'The approved risk result carries no tradable quantity',
          };
        }

        const orderRequest = toOrderRequest(request);
        // Count the attempt here, not on success: ONE_SHOT means at most one
        // order is ever handed to the exchange, whether it fills, is refused,
        // or ends in an unknown state.
        orderAttempts += 1;
        const submitted = await reconciliation.submitOrder({
          request: orderRequest,
          intent: toIntent(request),
        });

        if (!submitted.ok) {
          logger.warn('testnet order not placed', { symbol: proposal.symbol, reason: submitted.reasonCode });
          return {
            ok: false,
            reasonCode: submitted.reasonCode ?? REASON_CODE.INTERNAL_ERROR,
            message: submitted.message,
          };
        }

        const fill = toFill(submitted.order, request);
        logger.info('testnet order accepted', {
          symbol: proposal.symbol,
          orderId: submitted.order?.orderId ?? null,
          status: submitted.order?.status ?? null,
        });
        return fill === null
          ? { ok: true, order: submitted.order }
          : { ok: true, fill, order: submitted.order };
      } catch (error) {
        return {
          ok: false,
          reasonCode: REASON_CODE.INTERNAL_ERROR,
          message: `Testnet openPosition failed closed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },

    /**
     * Exit/halt management is intentionally not armed in this task. Reducing an
     * exchange position is a fresh, non-idempotent order and must not be issued
     * from a half-wired path, so the adapter fails closed and reports it.
     *
     * @param {{ symbol: string }} input
     */
    async closePosition(input) {
      return {
        ok: false,
        reasonCode: REASON_CODE.UNSUPPORTED_MODE,
        message: `Testnet closePosition for ${input?.symbol ?? 'unknown'} is not enabled in this build; no reduction order was sent.`,
      };
    },

    /**
     * Exchange-side protective levels are a withheld capability (see
     * FORBIDDEN_EXCHANGE_OPERATIONS), never applied from here.
     */
    async modifyPositionProtection(input) {
      return {
        ok: false,
        reasonCode: REASON_CODE.UNSUPPORTED_MODE,
        message: `Testnet modifyPositionProtection for ${input?.symbol ?? 'unknown'} is not supported: exchange stop amendment is a forbidden operation.`,
      };
    },

    async getAccountState() {
      const state = await accountProvider();
      if (state === null || typeof state !== 'object') {
        throw new ConfigError('Testnet accountProvider must return an account state object', { field: 'account' });
      }
      return state;
    },

    async getPosition(symbol) {
      const state = await accountProvider();
      return (state?.positions ?? []).find((position) => position.symbol === symbol) ?? null;
    },

    async getOpenPositions() {
      const state = await accountProvider();
      return [...(state?.positions ?? [])];
    },

    /**
     * Reconcile tracked orders against the exchange. This reuses the shared
     * reconciliation engine; a disagreement disables trading rather than being
     * smoothed over.
     *
     * @param {{ symbol?: string }} [market]
     */
    async onMarketUpdate(market = {}) {
      const result = await reconciliation.reconcileOpenOrders({ symbol: market?.symbol });
      return {
        closed: [],
        updated: result.results.length,
        errors: result.tradingEnabled ? [] : [result.reasonCode],
        tradingEnabled: result.tradingEnabled,
      };
    },
  };

  return assertExecutionAdapter(/** @type {any} */ (Object.freeze(adapter)));
}
