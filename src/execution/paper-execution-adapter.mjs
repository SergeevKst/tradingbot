/**
 * PaperExecutionAdapter — local-only simulated execution.
 *
 * Imports no exchange client, holds no credentials, and cannot place a real
 * order: it mutates an in-memory `PaperAccountState` and nothing else.
 *
 * Fill model (deliberately pessimistic)
 * -------------------------------------
 * Market entries cross the spread in the unfavourable direction, because a
 * taker pays the ask to buy and receives the bid to sell:
 *
 *   LONG  entry -> ask      LONG  exit -> bid
 *   SHORT entry -> bid      SHORT exit -> ask
 *
 * If the needed side of the book is missing, execution REFUSES. Inventing a
 * price from `lastPrice` would fabricate a fill that never existed, so the
 * adapter fails closed instead.
 *
 * Stop-loss / take-profit, and the ambiguous case
 * -----------------------------------------------
 * Triggers are evaluated against the reference price (mark, falling back to
 * last) using the same bid/ask-aware convention as exits.
 *
 * When a single market observation satisfies BOTH the stop and the target, the
 * order of the two moves inside that interval is genuinely unknowable from the
 * data available. Choosing the take-profit would silently inflate results with
 * a lucky-path assumption; choosing at random would make the simulation
 * non-reproducible. This adapter therefore takes the STOP, always, and records
 * `ambiguousTriggerResolvedTo: 'STOP_LOSS'` in the fill and the journal so the
 * conservatism is visible rather than buried. That is a documented worst-case
 * convention, not a claim about what really happened.
 *
 * @module execution/paper-execution-adapter
 */
import { ConfigError } from '../config/config-error.mjs';
import { REASON_CODE } from '../domain/reason-code.mjs';
import { SIDE } from '../domain/side.mjs';
import { normalizeInstrumentInfo, toRiskInstrumentView } from '../market/instrument-info.mjs';
import { normalizeAndValidateQuantity, normalizePrice, validateNotional } from '../market/normalize.mjs';
import { triggerReferencePrice } from '../market/market-snapshot.mjs';
import { computeInitialMargin, markPosition } from '../state/paper-position.mjs';
import { assertFeeModel } from '../state/fee-model.mjs';
import { recomputeAccount, lockedMarginUsd } from '../state/paper-account.mjs';
import { assertExecutionAdapter } from './execution-adapter.mjs';
import { assertFillModel, createFullFillModel } from './fill-model.mjs';

/**
 * @typedef {object} PaperAdapterOptions
 * @property {import('../state/paper-account.mjs').PaperAccountState} account initial account state
 * @property {import('../state/fee-model.mjs').FeeModel} feeModel
 * @property {import('./fill-model.mjs').FillModel} [fillModel] how much of an order fills; defaults to a full fill
 * @property {object} [logger]
 * @property {() => string} [now] injected clock (ISO string)
 * @property {(event: { eventType: string, [key: string]: unknown }) => void} [journal] append hook
 */

/**
 * Build a paper execution adapter.
 *
 * @param {PaperAdapterOptions} options
 * @returns {import('./execution-adapter.mjs').ExecutionAdapter & { setAccount: Function, snapshot: Function }}
 */
export function createPaperExecutionAdapter(options) {
  if (options === null || typeof options !== 'object') {
    throw new ConfigError('createPaperExecutionAdapter requires options');
  }
  if (options.account === null || typeof options.account !== 'object') {
    throw new ConfigError('createPaperExecutionAdapter requires an initial account state');
  }

  const now = options.now ?? (() => new Date().toISOString());
  const feeModel = assertFeeModel(options.feeModel);
  const fillModel = assertFillModel(options.fillModel ?? createFullFillModel());
  const logger = options.logger ?? { info() {}, warn() {}, error() {}, debug() {} };
  const journal = options.journal ?? (() => {});

  /** @type {import('../state/paper-account.mjs').PaperAccountState} */
  let account = options.account;

  /**
   * @param {{ eventType: string, symbol?: string, side?: string, quantity?: number, price?: number, pnl?: number, fee?: number, reason?: string, metadata?: object }} event
   */
  function emit(event) {
    journal({ timestamp: now(), ...event });
  }

  /**
   * @param {import('../market/market-snapshot.mjs').MarketSnapshot} market
   * @returns {Readonly<import('../market/instrument-info.mjs').InstrumentInfo>}
   */
  function requireInstrument(market) {
    if (!market || !market.instrument) {
      throw new ConfigError('Paper execution requires instrument metadata in the market snapshot', {
        field: 'instrument',
      });
    }
    return normalizeInstrumentInfo(market.instrument);
  }

  /**
   * Price at which a simulated order of `side` would execute, given the book.
   *
   * @param {import('../market/market-snapshot.mjs').MarketSnapshot} market
   * @param {'LONG' | 'SHORT'} side
   * @param {'entry' | 'exit'} stage
   * @returns {{ ok: true, price: number } | { ok: false, reasonCode: string, message: string }}
   */
  function fillPrice(market, side, stage) {
    // Buying lifts the ask; selling hits the bid.
    const buys = stage === 'entry' ? side === SIDE.LONG : side === SIDE.SHORT;
    const price = buys ? market.ask : market.bid;
    const needed = buys ? 'ask' : 'bid';

    if (!Number.isFinite(price) || price <= 0) {
      return {
        ok: false,
        reasonCode: REASON_CODE.MISSING_BID_ASK,
        message: `Refusing to simulate a ${stage} for ${side} ${market.symbol}: the ${needed} side of the book is unavailable. No invented price will be substituted.`,
      };
    }
    return { ok: true, price };
  }

  /**
   * @param {import('../domain/proposal.mjs').TradeProposal} proposal
   * @param {import('../domain/risk-result.mjs').ApprovedRiskResult} riskResult
   */
  function prepareOpen(proposal, riskResult) {
    if (riskResult === null || typeof riskResult !== 'object' || riskResult.approved !== true) {
      return {
        ok: false,
        reasonCode: REASON_CODE.EXECUTION_REQUIRES_APPROVAL,
        message:
          'The paper executor only executes orders the Risk Engine approved; it does not decide whether a trade may open.',
      };
    }
    if (account.positions.some((position) => position.symbol === proposal.symbol)) {
      return {
        ok: false,
        reasonCode: REASON_CODE.POSITION_ALREADY_OPEN,
        message: `A position on ${proposal.symbol} is already open. Close it before opening another (one net position per symbol).`,
      };
    }
    return { ok: true };
  }

  /**
   * Turn the risk-approved notional into an executable, step-aligned quantity.
   *
   * Returns the normalized size plus the notional it actually implies, since
   * rounding DOWN to the step always shrinks the position slightly.
   *
   * @param {number} quantity
   * @param {Readonly<import('../market/instrument-info.mjs').InstrumentInfo>} instrument
   * @param {number} price
   */
  function sizeOrder(quantity, instrument, price) {
    const normalized = normalizeAndValidateQuantity(quantity, instrument);
    if (!normalized.ok) {
      return { ok: false, reasonCode: REASON_CODE.UNREPRESENTABLE_QUANTITY, message: `Sizing is not tradable: ${normalized.reason}` };
    }

    const notionalUsd = normalized.quantity * price;
    const notionalCheck = validateNotional(notionalUsd, instrument);
    if (!notionalCheck.valid) {
      return { ok: false, reasonCode: REASON_CODE.UNREPRESENTABLE_QUANTITY, message: `Sizing is not tradable: ${notionalCheck.reason}` };
    }

    const priceCheck = normalizePrice(price, instrument.tickSize);
    if (!priceCheck.ok) {
      return { ok: false, reasonCode: REASON_CODE.UNREPRESENTABLE_QUANTITY, message: `Fill price ${price} is not representable: ${priceCheck.reason}` };
    }

    return { ok: true, quantity: normalized.quantity, price: priceCheck.value, notionalUsd };
  }

  /**
   * Ask the fill model how much of a normalized order actually fills, then
   * defensively validate its answer.
   *
   * A model is pluggable, so it is untrusted: a filled quantity that is
   * non-finite, negative or larger than requested would corrupt the account.
   * Such an answer is a hard failure (the caller's try/catch fails closed),
   * never a silent clamp.
   *
   * @param {import('./fill-model.mjs').FillRequest} request
   * @returns {import('./fill-model.mjs').FillDecision}
   */
  function resolveFill(request) {
    const decision = fillModel.resolveFill(request);
    const requested = request.requestedQuantity;
    const filled = Number(decision?.filledQuantity);
    if (!Number.isFinite(filled) || filled < 0 || filled > requested + 1e-9) {
      throw new ConfigError(
        `FillModel(${fillModel.kind()}) returned an invalid filledQuantity ${JSON.stringify(decision?.filledQuantity)} for requested ${requested}`,
        { field: 'filledQuantity', value: decision?.filledQuantity },
      );
    }
    return {
      filledQuantity: filled,
      unfilledQuantity: Math.max(0, requested - filled),
      partial: filled < requested - 1e-9,
      reason: decision?.reason ?? null,
    };
  }

  /**
   * Validate a fill quantity (which may be smaller than the original order)
   * against the instrument's size and notional rules.
   *
   * A partial fill that no longer clears `minOrderQty` or `minNotionalUsd` is
   * not a tradable order, so the whole entry is refused rather than filled with
   * a size the exchange would reject.
   *
   * @param {number} quantity
   * @param {Readonly<import('../market/instrument-info.mjs').InstrumentInfo>} instrument
   * @param {number} price
   */
  function validateFillQuantity(quantity, instrument, price) {
    const normalized = normalizeAndValidateQuantity(quantity, instrument);
    if (!normalized.ok) {
      return { ok: false, reasonCode: REASON_CODE.UNREPRESENTABLE_QUANTITY, message: `Partial fill ${quantity} is not tradable: ${normalized.reason}` };
    }
    const notionalUsd = normalized.quantity * price;
    const notionalCheck = validateNotional(notionalUsd, instrument);
    if (!notionalCheck.valid) {
      return { ok: false, reasonCode: REASON_CODE.UNREPRESENTABLE_QUANTITY, message: `Partial fill notional ${notionalUsd} is not tradable: ${notionalCheck.reason}` };
    }
    return { ok: true, quantity: normalized.quantity, notionalUsd };
  }

  /**
   * @param {'LONG' | 'SHORT'} side
   * @param {number} quantity
   * @param {number} price
   */
  function closePnL(side, quantity, entryPrice, price) {
    const direction = side === SIDE.LONG ? 1 : -1;
    return (price - entryPrice) * quantity * direction;
  }

  /**
   * Signed simulated slippage on an exit, relative to the price that was asked
   * for (a protective level, an explicit close price, or the reference price).
   *
   * Positive means the exit was WORSE than requested. Closing a LONG sells, so
   * filling below the requested price costs money; closing a SHORT buys, so
   * filling above it costs money. When no reference is known the request is
   * treated as the fill itself and slippage is exactly zero.
   *
   * @param {import('../state/paper-position.mjs').PaperPosition} position
   * @param {number} price actual fill price
   * @param {number} requestedPrice reference price
   * @returns {number}
   */
  function exitSlippageUsd(position, price, requestedPrice) {
    const isBuyOrder = position.side === SIDE.SHORT;
    return isBuyOrder
      ? (price - requestedPrice) * position.quantity
      : (requestedPrice - price) * position.quantity;
  }

  /**
   * Settle a position out at `price`, charging the exit fee.
   *
   * @param {import('../state/paper-position.mjs').PaperPosition} position
   * @param {number} price
   * @param {number | null | undefined} requestedPrice reference the exit was asked to achieve
   * @param {string} exitReason
   * @param {string} eventType
   * @param {object} [extraMetadata]
   */
  function settle(position, price, requestedPrice, exitReason, eventType, extraMetadata = {}) {
    const timestamp = now();
    const reference = Number.isFinite(requestedPrice) ? /** @type {number} */ (requestedPrice) : price;
    const exitNotional = price * position.quantity;
    const exitFee = feeModel.getExitFee({
      notionalUsd: exitNotional,
      price,
      quantity: position.quantity,
      symbol: position.symbol,
    });
    const grossPnl = closePnL(position.side, position.quantity, position.entryPrice, price);
    const slippageUsd = exitSlippageUsd(position, price, reference);

    const entryFee = Number.isFinite(position.entryFeeUsd) ? position.entryFeeUsd : 0;

    const fill = {
      symbol: position.symbol,
      side: position.side,
      quantity: position.quantity,
      requestedPrice: reference,
      fillPrice: price,
      slippageUsd,
      feeUsd: exitFee,
      notionalUsd: exitNotional,
      timestamp,
      // Net result attributable to this round trip, after both fees. Exposed on
      // the fill so callers never have to reconstruct it.
      netPnlUsd: grossPnl - exitFee - entryFee,
      grossPnlUsd: grossPnl,
      entryFeeUsd: entryFee,
      exitFeeUsd: exitFee,
      entryPrice: position.entryPrice,
      exitReason,
    };

    const remaining = account.positions.filter((candidate) => candidate.symbol !== position.symbol);
    account = recomputeAccount({
      ...account,
      positions: Object.freeze(remaining),
      realizedPnlUsd: account.realizedPnlUsd + grossPnl,
      feesUsd: account.feesUsd + exitFee,
      lastUpdatedAt: timestamp,
    });

    emit({
      eventType,
      symbol: position.symbol,
      side: position.side,
      quantity: position.quantity,
      price,
      pnl: grossPnl - exitFee - entryFee,
      fee: exitFee,
      reason: exitReason,
      metadata: {
        entryPrice: position.entryPrice,
        grossPnlUsd: grossPnl,
        exitFeeUsd: exitFee,
        entryFeeUsd: entryFee,
        requestedPrice: reference,
        slippageUsd,
        ...extraMetadata,
      },
    });

    // The exit-specific event (STOP_LOSS_FILLED / TAKE_PROFIT_FILLED) is
    // followed by the generic close marker. A manual close already IS
    // POSITION_CLOSED, so emitting it a second time would double-count the
    // close in any consumer that tallies events.
    if (eventType !== 'POSITION_CLOSED') {
      emit({
        eventType: 'POSITION_CLOSED',
        symbol: position.symbol,
        side: position.side,
        quantity: position.quantity,
        price,
        pnl: grossPnl - exitFee - entryFee,
        fee: exitFee,
        reason: exitReason,
        metadata: {
          entryPrice: position.entryPrice,
          equityUsd: account.equityUsd,
          ...extraMetadata,
        },
      });
    }

    return { fill, netPnl: grossPnl - exitFee - entryFee, exitFee, grossPnl, entryFee };
  }

  /**
   * Last observed reference price per symbol.
   *
   * Required to detect a GAP between two observations, which is the only way the
   * stop and the target can both be crossed without their order being knowable.
   * @type {Map<string, number>}
   */
  const lastReferenceBySymbol = new Map();

  /**
   * Decide whether a stop and/or target was crossed between two observations.
   *
   * A single reference price can never sit below the stop AND above the target
   * of the same position, so the ambiguous case cannot arise from one snapshot.
   * It arises from a GAP: the previous observation was above the target and the
   * current one is below the stop. Both levels therefore lie inside the interval
   * the market travelled through, and nothing in the data says which was touched
   * first.
   *
   * Conservative rule (documented, deterministic, never the favourable branch):
   * if both levels lie within the travelled interval, assume the STOP was hit
   * first. Ties resolve against the strategy, so a lucky path is never credited.
   *
   * @param {import('../state/paper-position.mjs').PaperPosition} position
   * @param {import('../market/market-snapshot.mjs').MarketSnapshot} market
   * @param {number | null} previousReference price at the previous observation
   */
  function evaluateTriggers(position, market, previousReference) {
    const reference = triggerReferencePrice(market);
    if (reference === null) {
      return { action: 'NONE', reasonCode: REASON_CODE.MISSING_REFERENCE_PRICE };
    }

    const { side, stopLoss, takeProfit } = position;
    const hasStop = Number.isFinite(stopLoss);
    const hasTarget = Number.isFinite(takeProfit);

    // The interval the price travelled since the last look. With no previous
    // observation, only the current price is known and no gap can be inferred.
    const low = previousReference === null || previousReference === undefined
      ? reference
      : Math.min(previousReference, reference);
    const high = previousReference === null || previousReference === undefined
      ? reference
      : Math.max(previousReference, reference);

    // LONG: the stop is below and the target above. SHORT: the reverse.
    const stopTouched = hasStop && (side === SIDE.LONG ? low <= stopLoss : high >= stopLoss);
    const targetTouched = hasTarget && (side === SIDE.LONG ? high >= takeProfit : low <= takeProfit);

    if (stopTouched && targetTouched) {
      return { action: 'STOP_LOSS', reference, ambiguous: true, reasonCode: null, travelled: { low, high } };
    }
    if (stopTouched) return { action: 'STOP_LOSS', reference, ambiguous: false, reasonCode: null };
    if (targetTouched) return { action: 'TAKE_PROFIT', reference, ambiguous: false, reasonCode: null };
    return { action: 'NONE', reference, ambiguous: false, reasonCode: null };
  }

  const adapter = {
    kind: () => 'PAPER',
    canPlaceRealOrders: false,

    /**
     * Open a simulated position from a risk-approved proposal.
     *
     * @param {import('./execution-adapter.mjs').OpenPositionRequest} request
     * @returns {Promise<import('./execution-adapter.mjs').ExecutionResult>}
     */
    async openPosition(request) {
      try {
        const { proposal, riskResult, market } = request;
        const timestamp = request.timestamp ?? now();

        emit({
          eventType: 'ORDER_SUBMITTED',
          symbol: proposal?.symbol,
          side: proposal?.side,
          quantity: riskResult?.estimatedQuantity,
          price: riskResult?.stopLossDistance !== undefined ? proposal?.entryPrice : null,
          reason: 'paper market entry',
          metadata: { strategyId: proposal?.strategyId, mode: 'PAPER' },
        });

        const prepared = prepareOpen(proposal, riskResult);
        if (!prepared.ok) {
          emit({
            eventType: 'RISK_REJECTED',
            symbol: proposal?.symbol,
            side: proposal?.side,
            reason: prepared.reasonCode,
            metadata: { message: prepared.message, stage: 'paper-executor' },
          });
          return { ok: false, reasonCode: prepared.reasonCode, message: prepared.message };
        }

        const instrument = requireInstrument(market);
        const priced = fillPrice(market, proposal.side, 'entry');
        if (!priced.ok) {
          emit({
            eventType: 'RISK_REJECTED',
            symbol: proposal.symbol,
            side: proposal.side,
            reason: priced.reasonCode,
            metadata: { message: priced.message, stage: 'paper-executor' },
          });
          return { ok: false, reasonCode: priced.reasonCode, message: priced.message };
        }

        const sized = sizeOrder(riskResult.estimatedQuantity, instrument, priced.price);
        if (!sized.ok) {
          emit({
            eventType: 'RISK_REJECTED',
            symbol: proposal.symbol,
            side: proposal.side,
            reason: sized.reasonCode,
            metadata: { message: sized.message, stage: 'paper-executor' },
          });
          return { ok: false, reasonCode: sized.reasonCode, message: sized.message };
        }

        // How much of the approved order actually fills. The default fills all
        // of it; a partial-fill model may fill less, and the remainder is
        // cancelled (a market taker order does not rest on the book).
        const decision = resolveFill({
          requestedQuantity: sized.quantity,
          price: sized.price,
          symbol: proposal.symbol,
          side: proposal.side,
          stage: 'entry',
          instrument,
        });

        if (decision.filledQuantity <= 0) {
          const message = `FillModel(${fillModel.kind()}) filled no tradable quantity for the requested ${sized.quantity} ${proposal.symbol}`;
          emit({
            eventType: 'RISK_REJECTED',
            symbol: proposal.symbol,
            side: proposal.side,
            reason: REASON_CODE.UNREPRESENTABLE_QUANTITY,
            metadata: { message, stage: 'paper-executor' },
          });
          return { ok: false, reasonCode: REASON_CODE.UNREPRESENTABLE_QUANTITY, message };
        }

        // A partial fill must still be a tradable order in its own right.
        const filled = validateFillQuantity(decision.filledQuantity, instrument, sized.price);
        if (!filled.ok) {
          emit({
            eventType: 'RISK_REJECTED',
            symbol: proposal.symbol,
            side: proposal.side,
            reason: filled.reasonCode,
            metadata: { message: filled.message, stage: 'paper-executor' },
          });
          return { ok: false, reasonCode: filled.reasonCode, message: filled.message };
        }

        const fillQuantity = filled.quantity;
        const fillNotionalUsd = filled.notionalUsd;
        const unfilledQuantity = Math.max(0, sized.quantity - fillQuantity);
        const partial = unfilledQuantity > 1e-9;

        const entryFee = feeModel.getEntryFee({
          notionalUsd: fillNotionalUsd,
          price: sized.price,
          quantity: fillQuantity,
          symbol: proposal.symbol,
        });

        // Isolated-margin leverage actually applied to this position: the configured
// cap the Risk Engine approved. Deriving "leverage" from notional/equity would
// be a category error — it would make initial margin equal to the entire
// equity and every entry would look unaffordable.
        const leverage = Number.isFinite(riskResult.maxAllowedLeverage) && riskResult.maxAllowedLeverage > 0
          ? riskResult.maxAllowedLeverage
          : 1;
        const initialMarginUsd = computeInitialMargin({ notionalUsd: fillNotionalUsd, leverage });

        // Guard: never let a simulated entry push locked margin past equity.
        const projectedLocked = lockedMarginUsd(account) + initialMarginUsd + entryFee;
        if (projectedLocked > account.equityUsd + 1e-9) {
          const message = `Refusing to open: locked margin ${projectedLocked.toFixed(2)} would exceed equity ${account.equityUsd.toFixed(2)}`;
          emit({
            eventType: 'RISK_REJECTED',
            symbol: proposal.symbol,
            side: proposal.side,
            reason: REASON_CODE.INSUFFICIENT_BALANCE,
            metadata: { message, stage: 'paper-executor' },
          });
          return { ok: false, reasonCode: REASON_CODE.INSUFFICIENT_BALANCE, message };
        }

        const slippageUsd = (sized.price - proposal.entryPrice) * fillQuantity * (proposal.side === SIDE.LONG ? 1 : -1);

        const position = Object.freeze({
          symbol: proposal.symbol,
          side: proposal.side,
          quantity: fillQuantity,
          entryPrice: sized.price,
          markPrice: sized.price,
          leverage,
          initialMarginUsd,
          entryFeeUsd: entryFee,
          stopLoss: Number.isFinite(proposal.stopLossPrice) ? proposal.stopLossPrice : null,
          takeProfit: Number.isFinite(proposal.takeProfitPrice) ? proposal.takeProfitPrice : null,
          unrealizedPnlUsd: 0,
          realizedPnlUsd: 0,
          openedAt: timestamp,
          updatedAt: timestamp,
        });

        account = recomputeAccount({
          ...account,
          positions: Object.freeze([...account.positions, position]),
          feesUsd: account.feesUsd + entryFee,
          lastUpdatedAt: timestamp,
        });

        // Anchor the gap detector to the entry observation: a stop/target may
        // not be considered "crossed" by a move that happened before the
        // position existed.
        lastReferenceBySymbol.set(proposal.symbol, sized.price);

        const fill = {
          symbol: proposal.symbol,
          side: proposal.side,
          quantity: fillQuantity,
          requestedQuantity: sized.quantity,
          filledQuantity: fillQuantity,
          unfilledQuantity,
          partial,
          requestedPrice: proposal.entryPrice,
          fillPrice: sized.price,
          slippageUsd,
          feeUsd: entryFee,
          notionalUsd: fillNotionalUsd,
          timestamp,
        };

        emit({
          eventType: 'ORDER_FILLED',
          symbol: proposal.symbol,
          side: proposal.side,
          quantity: fillQuantity,
          price: sized.price,
          fee: entryFee,
          reason: 'market entry filled at ' + (proposal.side === SIDE.LONG ? 'ask' : 'bid'),
          metadata: fill,
        });

        // A partial fill is a distinct, auditable fact: the order was not fully
        // satisfied and the remainder never became a position.
        if (partial) {
          emit({
            eventType: 'PARTIAL_FILL',
            symbol: proposal.symbol,
            side: proposal.side,
            quantity: fillQuantity,
            price: sized.price,
            fee: entryFee,
            reason: decision.reason ?? 'PARTIAL_FILL',
            metadata: { requestedQuantity: sized.quantity, filledQuantity: fillQuantity, unfilledQuantity },
          });
        }

        emit({
          eventType: 'POSITION_OPENED',
          symbol: proposal.symbol,
          side: proposal.side,
          quantity: fillQuantity,
          price: sized.price,
          fee: entryFee,
          reason: 'PAPER',
          metadata: {
            ...fill,
            stopLoss: position.stopLoss,
            takeProfit: position.takeProfit,
            leverage,
            initialMarginUsd,
            strategyId: proposal.strategyId,
          },
        });

        logger.info('paper position opened', {
          symbol: position.symbol,
          side: position.side,
          qty: fillQuantity,
          fillPrice: sized.price,
          partial,
          equityUsd: account.equityUsd,
        });

        return { ok: true, fill, account, position: /** @type {any} */ (position) };
      } catch (error) {
        return {
          ok: false,
          reasonCode: REASON_CODE.INTERNAL_ERROR,
          message: `Paper openPosition failed closed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },

    /**
     * Close a simulated position at the prevailing exit price.
     *
     * @param {{ symbol: string, price?: number, reason?: string, market?: import('../market/market-snapshot.mjs').MarketSnapshot }} input
     * @returns {Promise<import('./execution-adapter.mjs').ExecutionResult>}
     */
    async closePosition(input) {
      try {
        const position = account.positions.find((candidate) => candidate.symbol === input.symbol);
        if (!position) {
          return {
            ok: false,
            reasonCode: REASON_CODE.NO_OPEN_POSITION,
            message: `No open paper position on ${input.symbol}`,
          };
        }

        let price = input.price;
        // The price the close was asked to achieve, for slippage attribution: an
        // explicit close price is exact (zero slippage), a market close uses the
        // current reference price.
        let requestedPrice = Number.isFinite(price) ? /** @type {number} */ (price) : null;
        if (!Number.isFinite(price)) {
          if (!input.market) {
            return {
              ok: false,
              reasonCode: REASON_CODE.MISSING_BID_ASK,
              message: `Refusing to close ${input.symbol}: no price supplied and no market snapshot to derive one from.`,
            };
          }
          const reference = triggerReferencePrice(input.market);
          requestedPrice = reference;
          const priced = fillPrice(input.market, position.side, 'exit');
          if (!priced.ok) {
            return { ok: false, reasonCode: priced.reasonCode, message: priced.message };
          }
          price = priced.price;
        }

        const settled = settle(
          position,
          /** @type {number} */ (price),
          requestedPrice,
          input.reason ?? 'MANUAL',
          'POSITION_CLOSED',
        );
        return { ok: true, fill: settled.fill, account };
      } catch (error) {
        return {
          ok: false,
          reasonCode: REASON_CODE.INTERNAL_ERROR,
          message: `Paper closePosition failed closed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },

    /**
     * Update protective levels on an open simulated position.
     *
     * @param {{ symbol: string, stopLoss?: number | null, takeProfit?: number | null }} input
     * @returns {Promise<import('./execution-adapter.mjs').ExecutionResult>}
     */
    async modifyPositionProtection(input) {
      try {
        const position = account.positions.find((candidate) => candidate.symbol === input.symbol);
        if (!position) {
          return {
            ok: false,
            reasonCode: REASON_CODE.NO_OPEN_POSITION,
            message: `No open paper position on ${input.symbol}`,
          };
        }

        const nextStop = input.stopLoss === undefined ? position.stopLoss : input.stopLoss;
        const nextTarget = input.takeProfit === undefined ? position.takeProfit : input.takeProfit;

        // A protective level on the wrong side of entry would trigger instantly.
        const direction = position.side === SIDE.LONG ? 1 : -1;
        if (Number.isFinite(nextStop) && (/** @type {number} */ (nextStop) - position.entryPrice) * direction >= 0) {
          return {
            ok: false,
            reasonCode: REASON_CODE.INVALID_PROTECTION_LEVEL,
            message: `Stop loss ${nextStop} is not on the loss side of entry ${position.entryPrice} for a ${position.side}`,
          };
        }
        if (Number.isFinite(nextTarget) && (/** @type {number} */ (nextTarget) - position.entryPrice) * direction <= 0) {
          return {
            ok: false,
            reasonCode: REASON_CODE.INVALID_PROTECTION_LEVEL,
            message: `Take profit ${nextTarget} is not on the profit side of entry ${position.entryPrice} for a ${position.side}`,
          };
        }

        const timestamp = now();
        const updated = Object.freeze({ ...position, stopLoss: nextStop, takeProfit: nextTarget, updatedAt: timestamp });
        account = recomputeAccount({
          ...account,
          positions: Object.freeze(account.positions.map((candidate) => (candidate.symbol === input.symbol ? updated : candidate))),
          lastUpdatedAt: timestamp,
        });

        emit({
          eventType: 'POSITION_UPDATED',
          symbol: position.symbol,
          side: position.side,
          quantity: position.quantity,
          price: position.markPrice,
          reason: 'protection modified',
          metadata: { stopLoss: nextStop, takeProfit: nextTarget },
        });

        return { ok: true, account, position: /** @type {any} */ (updated) };
      } catch (error) {
        return {
          ok: false,
          reasonCode: REASON_CODE.INTERNAL_ERROR,
          message: `Paper modifyPositionProtection failed closed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    },

    async getAccountState() {
      return account;
    },

    async getPosition(symbol) {
      return account.positions.find((candidate) => candidate.symbol === symbol) ?? null;
    },

    async getOpenPositions() {
      return [...account.positions];
    },

    /**
     * Mark open positions to a fresh market snapshot and process stop/target.
     *
     * This is the only place SL/TP are acted upon. Positions are re-priced
     * before triggers are evaluated so that a triggered exit settles at the
     * current mark, not a stale one.
     *
     * @param {import('../market/market-snapshot.mjs').MarketSnapshot} market
     * @returns {Promise<{ closed: Array<{ symbol: string, exitReason: string, fill: object, netPnlUsd: number }>, updated: number, errors: string[] }>}
     */
    async onMarketUpdate(market) {
      const closed = [];
      const errors = [];
      let updated = 0;

      // Captured before any of this snapshot's observations are recorded, so
      // each position is compared against the *previous* look, not its own.
      const previousReference = lastReferenceBySymbol.has(market.symbol)
        ? /** @type {number} */ (lastReferenceBySymbol.get(market.symbol))
        : null;

      for (const position of [...account.positions]) {
        if (position.symbol !== market.symbol) continue;

        try {
          const reference = triggerReferencePrice(market);
          if (reference === null) {
            errors.push(`${position.symbol}: no reference price available`);
            continue;
          }

          const timestamp = now();

          // Re-price first so equity/PnL reflect this observation regardless of
          // whether a trigger fires. `markPosition` recomputes unrealized PnL
          // from the new price — updating `markPrice` alone would leave the PnL
          // stale and make equity disagree with the position.
          const repriced = markPosition(position, reference, timestamp);
          account = recomputeAccount({
            ...account,
            positions: Object.freeze(
              account.positions.map((candidate) => (candidate.symbol === position.symbol ? repriced : candidate)),
            ),
            lastUpdatedAt: timestamp,
          });

          const trigger = evaluateTriggers(repriced, market, previousReference);
          if (trigger.action === 'NONE') {
            updated += 1;
            emit({
              eventType: 'POSITION_UPDATED',
              symbol: repriced.symbol,
              side: repriced.side,
              quantity: repriced.quantity,
              price: reference,
              reason: 'mark-to-market',
              metadata: { unrealizedPnlUsd: repriced.unrealizedPnlUsd },
            });
            continue;
          }

          // The exit fills at the prevailing market side, NOT at the protective
          // level: a LONG is sold into the bid, a SHORT is bought at the ask.
          //
          // This matters when price gapped through the level, and it is the
          // pessimistic choice: filling AT the stop would credit a better price
          // than the market was actually offering.
          const priced = fillPrice(market, repriced.side, 'exit');
          if (!priced.ok) {
            errors.push(`${repriced.symbol}: ${priced.reasonCode} — ${priced.message}`);
            continue;
          }

          const triggerLevel = trigger.action === 'STOP_LOSS' ? repriced.stopLoss : repriced.takeProfit;
          const settled = settle(
            repriced,
            priced.price,
            triggerLevel,
            trigger.action,
            trigger.action === 'STOP_LOSS' ? 'STOP_LOSS_FILLED' : 'TAKE_PROFIT_FILLED',
            {
              triggerLevel,
              ...(trigger.ambiguous
                ? {
                    ambiguousTriggerResolvedTo: 'STOP_LOSS',
                    note:
                      'Both the stop and the target were satisfied by the same market observation; ' +
                      'the stop is assumed to have been reached first (conservative).',
                  }
                : {}),
            },
          );

          closed.push({
            symbol: repriced.symbol,
            exitReason: trigger.action,
            fill: settled.fill,
            netPnlUsd: settled.netPnl,
          });
        } catch (error) {
          errors.push(`${position.symbol}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // Remember this observation for the next call, so a future gap that spans
      // both protective levels is detected rather than passed over.
      const currentReference = triggerReferencePrice(market);
      if (currentReference !== null) {
        lastReferenceBySymbol.set(market.symbol, currentReference);
      }

      return { closed, updated, errors };
    },

    /** Replace the working account (used after a restore). */
    setAccount(next) {
      account = next;
    },

    /** Read-only copy of the current account, for persistence. */
    snapshot() {
      return account;
    },
  };

  return assertExecutionAdapter(
    /** @type {any} */ (Object.freeze(adapter)),
  );
}

export { toRiskInstrumentView };