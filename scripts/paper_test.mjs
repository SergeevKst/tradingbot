#!/usr/bin/env node
/**
 * `paper:test` — end-to-end self-check of the PAPER pipeline on FIXED data.
 *
 * A smoke test in command form: it runs the whole loop (risk -> paper fill ->
 * stop/target -> persistence -> restart recovery) against an offline static
 * market, on a temporary account, and prints a PASS/FAIL summary.
 *
 * It asserts INVARIANTS, not profitability. A green run says the plumbing is
 * coherent; it says nothing whatsoever about whether any strategy makes money.
 *
 * Usage: npm run paper:test
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_RISK_LIMITS } from '../src/config/risk.mjs';
import { createRateFeeModel } from '../src/state/fee-model.mjs';
import { createPaperSession } from '../src/session/paper-session.mjs';
import { createStaticMarketDataAdapter } from '../src/market/static-market-data-adapter.mjs';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

const INSTITUTION = {
  symbol: 'BTCUSDT',
  status: 'Trading',
  baseCoin: 'BTC',
  quoteCoin: 'USDT',
  settleCoin: 'USDT',
  tickSize: 0.1,
  qtyStep: 0.001,
  minOrderQty: 0.001,
  maxOrderQty: 1500,
  maxLeverage: 150,
  minNotionalUsd: 5,
};

const directory = await mkdtemp(join(tmpdir(), 'paper-test-'));
const paths = {
  stateFile: join(directory, 'state.json'),
  journalFile: join(directory, 'journal.jsonl'),
  initialEquityUsd: DEFAULT_RISK_LIMITS.initialCapitalUsd,
};

let failures = 0;
let checks = 0;

/**
 * @param {string} label
 * @param {boolean} condition
 * @param {string} [detail]
 */
function check(label, condition, detail = '') {
  checks += 1;
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

try {
  const marketData = createStaticMarketDataAdapter({
    instrument: INSTITUTION,
    ticker: { lastPrice: 86000, markPrice: 86000, bid: 85999.9, ask: 86000.1, volume: 1000 },
  });

  const makeSession = () =>
    createPaperSession({
      riskConfig: DEFAULT_RISK_LIMITS,
      feeModel: createRateFeeModel({ entryRate: 0.001, exitRate: 0.001 }),
      paths,
      logger: quiet,
    });

  console.log('PAPER SELF-CHECK (offline, fixed data)');
  console.log('  note: this verifies INVARIANTS, never profitability');
  console.log('');

  console.log('1. initial account');
  let session = await makeSession();
  let account = await session.getAccountState();
  check('fresh account starts at the configured equity', account.equityUsd === 340, `got ${account.equityUsd}`);
  check('no positions initially', account.positions.length === 0);
  check('no fees initially', account.feesUsd === 0);

  console.log('2. approved proposal executes');
  const proposal = {
    symbol: 'BTCUSDT',
    side: 'LONG',
    entryPrice: 86000,
    stopLossPrice: 85280,
    takeProfitPrice: 87600,
    confidence: 0.5,
    strategyId: 'self-check',
    timestamp: Date.now(),
  };
  let outcome = await session.submit({ proposal, market: await marketData.getSnapshot('BTCUSDT') });
  check('proposal approved by the risk engine', outcome.approved === true, outcome.reasonCode);
  check('proposal executed by the paper executor', outcome.executed === true, outcome.reasonCode);

  account = await session.getAccountState();
  check('one open position', account.positions.length === 1);
  check('LONG entry filled at the ask', account.positions[0]?.entryPrice === 86000.1, `got ${account.positions[0]?.entryPrice}`);
  check('entry fee charged', account.feesUsd > 0);
  check('equity reflects the entry fee', account.equityUsd < 340);
  check('trade counted against the daily limit', account.tradesToday === 1, `got ${account.tradesToday}`);
  const locked = account.equityUsd - account.availableBalanceUsd;
  check('margin is locked by the open position', locked > 0, `locked ${locked}`);

  console.log('3. duplicate protection');
  outcome = await session.submit({ proposal, market: await marketData.getSnapshot('BTCUSDT') });
  check('same-direction duplicate refused', outcome.approved === false && outcome.reasonCode === 'DUPLICATE_PROPOSAL', outcome.reasonCode);
  outcome = await session.submit({
    proposal: { ...proposal, side: 'SHORT', stopLossPrice: 86800, takeProfitPrice: 84400 },
    market: await marketData.getSnapshot('BTCUSDT'),
  });
  check('opposite position refused (reversal needs an explicit close)', outcome.reasonCode === 'CONFLICTING_POSITION', outcome.reasonCode);

  console.log('4. missing book refuses execution');
  const blind = createStaticMarketDataAdapter({
    instrument: INSTITUTION,
    ticker: { lastPrice: 86000, markPrice: 86000, bid: null, ask: null },
  });
  const blindSession = await createPaperSession({
    riskConfig: DEFAULT_RISK_LIMITS,
    feeModel: createRateFeeModel({}),
    paths: { ...paths, stateFile: join(directory, 'blind.json'), journalFile: join(directory, 'blind.jsonl') },
    logger: quiet,
  });
  outcome = await blindSession.submit({ proposal, market: await blind.getSnapshot('BTCUSDT') });
  check('no fill without a bid/ask (no invented price)', outcome.executed === false, `executed=${outcome.executed}`);
  check('refusal is explicit about the missing book', outcome.reasonCode === 'MISSING_BID_ASK', outcome.reasonCode);

  console.log('5. unrealized PnL is deterministic');
  marketData.setTicker({ markPrice: 86500, bid: 86499.9, ask: 86500.1, lastPrice: 86500 });
  await session.onMarketUpdate(await marketData.getSnapshot('BTCUSDT'));
  account = await session.getAccountState();
  const expected = (86500 - 86000.1) * account.positions[0].quantity;
  check('unrealized PnL matches (mark - entry) * qty', Math.abs(account.unrealizedPnlUsd - expected) < 1e-9, `${account.unrealizedPnlUsd} vs ${expected}`);

  console.log('6. take profit closes and realizes');
  marketData.setTicker({ markPrice: 87650, bid: 87649.9, ask: 87650.1, lastPrice: 87650 });
  const update = await session.onMarketUpdate(await marketData.getSnapshot('BTCUSDT'));
  check('take profit fired', update.closed[0]?.exitReason === 'TAKE_PROFIT', String(update.closed[0]?.exitReason));
  account = await session.getAccountState();
  check('position closed', account.positions.length === 0);
  check('realized PnL is positive on a winning trade', account.realizedPnlUsd > 0, `got ${account.realizedPnlUsd}`);
  const equityAfterWin = account.equityUsd;
  check('equity grew by roughly the net win', equityAfterWin > 340, `equity ${equityAfterWin}`);

  console.log('7. state survives a restart');
  const restored = await makeSession();
  const restoredAccount = await restored.getAccountState();
  check('restart restored rather than reset', restored.restored === true);
  check('equity preserved across restart', Math.abs(restoredAccount.equityUsd - equityAfterWin) < 1e-9, `${restoredAccount.equityUsd} vs ${equityAfterWin}`);
  check('daily counters preserved across restart', restoredAccount.tradesToday === 1, `got ${restoredAccount.tradesToday}`);
  check('fees preserved across restart', Math.abs(restoredAccount.feesUsd - account.feesUsd) < 1e-9);

  console.log('8. journal recorded the history');
  const { events } = await restored.journal.read();
  check('journal is non-empty', events.length > 0, `${events.length} events`);
  const types = new Set(events.map((event) => event.eventType));
  for (const required of ['SIGNAL_RECEIVED', 'RISK_ACCEPTED', 'POSITION_OPENED', 'TAKE_PROFIT_FILLED', 'POSITION_CLOSED']) {
    check(`journal contains ${required}`, types.has(required));
  }

  console.log('9. corrupt state fails closed');
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(directory, 'broken.json'), '{ not valid json');
  let threw = false;
  try {
    await createPaperSession({
      riskConfig: DEFAULT_RISK_LIMITS,
      feeModel: createRateFeeModel({}),
      paths: { ...paths, stateFile: join(directory, 'broken.json') },
      logger: quiet,
    });
  } catch {
    threw = true;
  }
  check('corrupt state refuses to start (no silent reset)', threw === true);

  console.log('');
  console.log(`RESULT: ${checks - failures}/${checks} checks passed`);
  if (failures > 0) {
    console.log('This build is NOT safe to run: the paper invariants above failed.');
    process.exitCode = 1;
  } else {
    console.log('All invariants hold. This says NOTHING about strategy profitability.');
  }
} catch (error) {
  console.error('paper:test crashed:', error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}