/**
 * TradeProposal — the only structure an external decision maker (a human, a
 * strategy, or in a later stage an AI model) may hand to the trading core.
 *
 * Design notes that matter for safety:
 *
 * 1. The schema is CLOSED. Unknown keys are rejected rather than ignored, so a
 *    proposal cannot smuggle a field such as `quantity`, `notionalUsd` or
 *    `leverage` that a later layer might start honouring. Position size is
 *    derived by the Risk Engine and is never accepted as input.
 * 2. `confidence` is carried for logging and ranking only. It must not widen a
 *    risk limit or change position size — the Risk Engine ignores it for sizing
 *    by construction.
 * 3. Expected validation failures are returned as structured issues, not
 *    thrown, so callers can record *why* a proposal was malformed. Programmer
 *    errors (bad call shape) still throw.
 *
 * @module domain/proposal
 */
import { ConfigError } from '../config/config-error.mjs';
import { SIDES, isSide } from './side.mjs';
import { REASON_CODE } from './reason-code.mjs';

/** The complete, closed set of accepted proposal fields. */
export const PROPOSAL_FIELDS = Object.freeze([
  'symbol',
  'side',
  'entryPrice',
  'stopLossPrice',
  'takeProfitPrice',
  'confidence',
  'strategyId',
  'timestamp',
]);

const SYMBOL_PATTERN = /^[A-Z0-9]{2,30}$/;
const MAX_STRATEGY_ID_LENGTH = 64;

/**
 * @typedef {object} TradeProposal
 * @property {string} symbol e.g. "BTCUSDT"
 * @property {'LONG' | 'SHORT'} side
 * @property {number} entryPrice
 * @property {number} stopLossPrice
 * @property {number} takeProfitPrice
 * @property {number} confidence 0..1, informational only
 * @property {string} strategyId origin of the proposal
 * @property {number} timestamp epoch milliseconds (UTC)
 */

/**
 * MASTER_SPEC §8 names the strategy→risk abstraction "TradeIntent". The
 * implemented form of a TradeIntent is this `TradeProposal`: it deliberately
 * omits `quantity`/`leverage` because position size is derived by the Risk
 * Engine and must never travel in from a strategy or an AI model.
 *
 * @typedef {TradeProposal} TradeIntent
 */

/**
 * @typedef {object} ProposalIssue
 * @property {string} code one of REASON_CODE
 * @property {string} field offending field name
 * @property {string} message human-readable explanation
 */

/**
 * @typedef {object} ProposalValidationResult
 * @property {boolean} valid
 * @property {ProposalIssue[]} issues empty when valid
 * @property {TradeProposal | null} proposal frozen normalized proposal, or null
 */

function issue(code, field, message) {
  return /** @type {ProposalIssue} */ ({ code, field, message });
}

/**
 * Parse a price-like value. Numeric strings are accepted (JSON/LLM payloads
 * frequently carry prices as strings) and normalised to a number.
 *
 * @returns {{ ok: true, value: number } | { ok: false, message: string }}
 */
function parsePrice(raw) {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? { ok: true, value: raw } : { ok: false, message: `not a finite number: ${raw}` };
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const value = Number(raw.trim());
    return Number.isFinite(value) ? { ok: true, value } : { ok: false, message: `not a finite number: ${JSON.stringify(raw)}` };
  }
  return { ok: false, message: `expected a finite number, got ${JSON.stringify(raw)}` };
}

/**
 * Normalise a symbol: trimmed and upper-cased with a conservative charset.
 *
 * @returns {{ ok: true, value: string } | { ok: false, message: string }}
 */
export function normalizeSymbol(raw) {
  if (typeof raw !== 'string') {
    return { ok: false, message: `expected a string, got ${JSON.stringify(raw)}` };
  }
  const value = raw.trim().toUpperCase();
  if (!SYMBOL_PATTERN.test(value)) {
    return { ok: false, message: `must match ${SYMBOL_PATTERN} (e.g. "BTCUSDT"), got ${JSON.stringify(raw)}` };
  }
  return { ok: true, value };
}

/**
 * Parse a timestamp into epoch milliseconds.
 *
 * @returns {{ ok: true, value: number } | { ok: false, message: string }}
 */
function parseTimestamp(raw) {
  if (raw instanceof Date) {
    const value = raw.getTime();
    return Number.isFinite(value) ? { ok: true, value } : { ok: false, message: 'invalid Date' };
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || !Number.isInteger(raw) || raw <= 0) {
      return { ok: false, message: `expected positive epoch milliseconds, got ${raw}` };
    }
    return { ok: true, value: raw };
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return { ok: true, value: parsed };
    return { ok: false, message: `unparseable timestamp ${JSON.stringify(raw)}` };
  }
  return { ok: false, message: `expected epoch milliseconds or an ISO string, got ${JSON.stringify(raw)}` };
}

/**
 * Validate and normalise a raw proposal.
 *
 * This performs *shape* validation only. Side-relative geometry (whether the
 * stop really sits below a LONG entry, and so on) is decided by the Risk Engine,
 * which is the single place that owns side-aware logic.
 *
 * @param {unknown} raw
 * @returns {ProposalValidationResult}
 */
export function validateProposal(raw) {
  /** @type {ProposalIssue[]} */
  const issues = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      valid: false,
      issues: [
        issue(REASON_CODE.MALFORMED_PROPOSAL, 'proposal', `expected an object, got ${Array.isArray(raw) ? 'array' : typeof raw}`),
      ],
      proposal: null,
    };
  }

  const input = /** @type {Record<string, unknown>} */ (raw);

  // Reject unknown keys: nothing may be smuggled into the risk decision.
  const unknownFields = Object.keys(input).filter((key) => !PROPOSAL_FIELDS.includes(key));
  for (const field of unknownFields) {
    issues.push(
      issue(REASON_CODE.MALFORMED_PROPOSAL, field, `unknown field "${field}" is not part of TradeProposal and is rejected`),
    );
  }

  // --- symbol --------------------------------------------------------------
  const symbol = normalizeSymbol(input.symbol);
  if (!symbol.ok) {
    issues.push(issue(REASON_CODE.INVALID_SYMBOL, 'symbol', symbol.message));
  }

  // --- side ----------------------------------------------------------------
  let side = null;
  if (typeof input.side !== 'string' || !isSide(input.side.trim().toUpperCase())) {
    issues.push(
      issue(REASON_CODE.INVALID_SIDE, 'side', `must be one of: ${SIDES.join(', ')} — got ${JSON.stringify(input.side)}`),
    );
  } else {
    side = /** @type {'LONG' | 'SHORT'} */ (input.side.trim().toUpperCase());
  }

  // --- prices --------------------------------------------------------------
  const entry = parsePrice(input.entryPrice);
  if (!entry.ok) {
    issues.push(issue(REASON_CODE.INVALID_ENTRY_PRICE, 'entryPrice', entry.message));
  } else if (entry.value <= 0) {
    issues.push(issue(REASON_CODE.INVALID_ENTRY_PRICE, 'entryPrice', `must be > 0, got ${entry.value}`));
  }

  const stopLoss = parsePrice(input.stopLossPrice);
  const hasStopLoss = typeof input.stopLossPrice !== 'undefined' && input.stopLossPrice !== null;
  if (hasStopLoss && !stopLoss.ok) {
    issues.push(issue(REASON_CODE.INVALID_STOP_LOSS, 'stopLossPrice', stopLoss.message));
  } else if (hasStopLoss && stopLoss.ok && stopLoss.value <= 0) {
    issues.push(issue(REASON_CODE.INVALID_STOP_LOSS, 'stopLossPrice', `must be > 0, got ${stopLoss.value}`));
  }

  const takeProfit = parsePrice(input.takeProfitPrice);
  const hasTakeProfit = typeof input.takeProfitPrice !== 'undefined' && input.takeProfitPrice !== null;
  if (hasTakeProfit && !takeProfit.ok) {
    issues.push(issue(REASON_CODE.INVALID_TAKE_PROFIT, 'takeProfitPrice', takeProfit.message));
  } else if (hasTakeProfit && takeProfit.ok && takeProfit.value <= 0) {
    issues.push(issue(REASON_CODE.INVALID_TAKE_PROFIT, 'takeProfitPrice', `must be > 0, got ${takeProfit.value}`));
  }

  // --- confidence ----------------------------------------------------------
  let confidence = null;
  if (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence)) {
    issues.push(
      issue(REASON_CODE.INVALID_CONFIDENCE, 'confidence', `must be a finite number in [0, 1], got ${JSON.stringify(input.confidence)}`),
    );
  } else if (input.confidence < 0 || input.confidence > 1) {
    issues.push(issue(REASON_CODE.INVALID_CONFIDENCE, 'confidence', `must be within [0, 1], got ${input.confidence}`));
  } else {
    confidence = input.confidence;
  }

  // --- strategy id ---------------------------------------------------------
  let strategyId = null;
  if (typeof input.strategyId !== 'string' || input.strategyId.trim() === '') {
    issues.push(issue(REASON_CODE.MISSING_STRATEGY_ID, 'strategyId', 'must be a non-empty string'));
  } else if (input.strategyId.trim().length > MAX_STRATEGY_ID_LENGTH) {
    issues.push(
      issue(REASON_CODE.MISSING_STRATEGY_ID, 'strategyId', `must be at most ${MAX_STRATEGY_ID_LENGTH} characters`),
    );
  } else {
    strategyId = input.strategyId.trim();
  }

  // --- timestamp -----------------------------------------------------------
  const timestamp = parseTimestamp(input.timestamp);
  if (!timestamp.ok) {
    issues.push(issue(REASON_CODE.MALFORMED_PROPOSAL, 'timestamp', timestamp.message));
  }

  if (issues.length > 0) {
    return { valid: false, issues, proposal: null };
  }

  /** @type {TradeProposal} */
  const proposal = Object.freeze({
    symbol: /** @type {string} */ (symbol.ok ? symbol.value : undefined),
    side: /** @type {'LONG' | 'SHORT'} */ (side),
    entryPrice: /** @type {number} */ (entry.ok ? entry.value : undefined),
    stopLossPrice: /** @type {number} */ (stopLoss.ok ? stopLoss.value : undefined),
    takeProfitPrice: /** @type {number} */ (takeProfit.ok ? takeProfit.value : undefined),
    confidence: /** @type {number} */ (confidence),
    strategyId: /** @type {string} */ (strategyId),
    timestamp: /** @type {number} */ (timestamp.ok ? timestamp.value : undefined),
  });

  return { valid: true, issues: [], proposal };
}

/**
 * Validate a proposal and throw on failure.
 *
 * Use this at boundaries where a malformed proposal is a programming error
 * rather than a trade decision; the Risk Engine uses `validateProposal`
 * directly so it can report a structured rejection instead.
 *
 * @param {unknown} raw
 * @returns {TradeProposal}
 * @throws {ConfigError}
 */
export function assertValidProposal(raw) {
  const { valid, issues, proposal } = validateProposal(raw);
  if (!valid || proposal === null) {
    const detail = issues.map((i) => `${i.field}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid trade proposal — ${detail}`, { field: issues[0]?.field });
  }
  return proposal;
}