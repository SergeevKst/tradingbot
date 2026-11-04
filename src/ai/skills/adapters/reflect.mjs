/**
 * REFLECT adapter — typed host contract for closed-trade reflection.
 *
 * Baseline: `src/telegram/reflect.mjs` (REFLECT_SYSTEM_PROMPT, inferExitCause,
 * appendReflection). The trusted caller stamps the timestamp and owns the
 * pending-rule queue; the model never applies a rule and cannot write.
 *
 * @module ai/skills/adapters/reflect
 */
import {
  closed,
  defineAdapter,
  finiteNumber,
  inputInvalid,
  outputInvalid,
  refuseSecretFields,
  stringField,
} from './shared.mjs';

const TRADE_KEYS = Object.freeze([
  'symbol',
  'side',
  'entry',
  'exit',
  'pnlUsd',
  'reason',
  'exitCause',
  'holdMinutes',
  'mfeUsd',
]);
const EXIT_CAUSES = Object.freeze(['stop', 'target', 'external', 'unknown']);
const SEVERITIES = Object.freeze(['high', 'medium', 'low']);

/**
 * @param {unknown} hostInput
 */
function shape(hostInput) {
  const input = closed(hostInput, ['trade', 'existingRules'], 'reflect input', inputInvalid);
  refuseSecretFields(hostInput, 'reflect input');
  const trade = closed(input.trade, TRADE_KEYS, 'reflect input.trade', inputInvalid);
  const existingRules = input.existingRules === null
    ? null
    : stringField(input.existingRules, 'reflect input.existingRules', { maxLength: 16000 });
  return {
    trade: {
      symbol: stringField(trade.symbol, 'reflect input.trade.symbol', { minLength: 1, maxLength: 40 }),
      side: stringField(trade.side, 'reflect input.trade.side', { values: ['LONG', 'SHORT'] }),
      entry: finiteNumber(trade.entry, 'reflect input.trade.entry', { min: 0 }),
      exit: finiteNumber(trade.exit, 'reflect input.trade.exit', { min: 0 }),
      pnlUsd: finiteNumber(trade.pnlUsd, 'reflect input.trade.pnlUsd', {}),
      reason: stringField(trade.reason, 'reflect input.trade.reason', { maxLength: 2000 }),
      exitCause: stringField(trade.exitCause, 'reflect input.trade.exitCause', { values: EXIT_CAUSES }),
      holdMinutes: finiteNumber(trade.holdMinutes, 'reflect input.trade.holdMinutes', { min: 0, nullable: true }),
      mfeUsd: finiteNumber(trade.mfeUsd, 'reflect input.trade.mfeUsd', { nullable: true }),
    },
    existingRules,
  };
}

/**
 * @param {unknown} value
 */
function validateOutput(value) {
  const output = closed(
    value,
    ['lesson', 'proposedRule', 'severity', 'matchedExistingRule'],
    'reflect output',
    outputInvalid,
  );
  const lesson = stringField(output.lesson, 'reflect output.lesson', { minLength: 1, maxLength: 1000 }, outputInvalid);
  const proposedRule = stringField(output.proposedRule, 'reflect output.proposedRule', { maxLength: 1000 }, outputInvalid);
  const severity = stringField(output.severity, 'reflect output.severity', { values: SEVERITIES }, outputInvalid);
  if (typeof output.matchedExistingRule !== 'boolean') {
    outputInvalid('reflect output.matchedExistingRule must be a boolean', 'reflect output.matchedExistingRule');
  }
  const matchedExistingRule = /** @type {boolean} */ (output.matchedExistingRule);
  if (matchedExistingRule && proposedRule.trim() !== '') {
    outputInvalid('reflect output: a matched existing rule must not also propose a new rule', 'reflect output.proposedRule');
  }
  return Object.freeze({ lesson, proposedRule, severity, matchedExistingRule });
}

/** Host contract catalogue entry. */
export const reflectAdapter = defineAdapter(
  'REFLECT',
  'reflect.v1',
  { id: 'reflect.input', version: '1.0.0' },
  { id: 'reflect.output', version: '1.0.0' },
  ['trade.closed.v1', 'rules.pending.v1'],
  shape,
  validateOutput,
);
