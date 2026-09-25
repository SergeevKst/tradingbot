#!/usr/bin/env node
/**
 * `paper:state` — show the current PAPER account, positions and journal tail.
 *
 * Read-only: never mutates state, never touches the exchange.
 *
 * Usage: npm run paper:state
 */
import { loadConfig } from '../src/config/env.mjs';
import { createRateFeeModel } from '../src/state/fee-model.mjs';
import { createPaperSession } from '../src/session/paper-session.mjs';
import { describeAccount } from '../src/state/paper-account.mjs';

const config = loadConfig();

try {
  const session = await createPaperSession({
    riskConfig: config.risk,
    feeModel: createRateFeeModel({ entryRate: config.paper.takerFeeRate, exitRate: config.paper.exitFeeRate }),
    paths: {
      stateFile: config.paper.stateFile,
      journalFile: config.paper.journalFile,
      initialEquityUsd: config.risk.initialCapitalUsd,
      persist: config.paper.persist,
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });

  const account = await session.getAccountState();
  const positions = await session.getOpenPositions();

  console.log('PAPER ACCOUNT');
  console.log('  origin            :', session.restored ? 'restored from disk' : 'new account');
  console.log('  state file        :', config.paper.stateFile);
  console.log('  journal file      :', config.paper.journalFile);
  console.log('  initial equity    :', account.initialEquityUsd.toFixed(2), 'USD');
  for (const [key, value] of Object.entries(describeAccount(account))) {
    console.log(`  ${key.padEnd(18)}:`, value);
  }

  const daily = session.dailyState();
  console.log('  trading day (UTC) :', daily.tradingDay);
  console.log('  sockets/orders    : no real orders — PAPER only');

  console.log('');
  console.log(`OPEN POSITIONS (${positions.length})`);
  if (positions.length === 0) {
    console.log('  none');
  } else {
    for (const position of positions) {
      console.log(
        `  ${position.symbol} ${position.side} qty=${position.quantity} entry=${position.entryPrice} ` +
          `mark=${position.markPrice} SL=${position.stopLoss ?? '-'} TP=${position.takeProfit ?? '-'} ` +
          `uPnL=${position.unrealizedPnlUsd.toFixed(4)}`,
      );
    }
  }

  const { events, skippedTail } = await session.journal.read();
  console.log('');
  console.log(`JOURNAL (${events.length} events)${skippedTail ? ' — a malformed tail line was ignored' : ''}`);
  for (const event of events.slice(-10)) {
    console.log(
      `  ${event.timestamp} ${event.eventType.padEnd(20)} ${event.symbol ?? '-'} ${event.side ?? '-'} ` +
        `${event.reason ?? ''}`,
    );
  }
} catch (error) {
  console.error('paper:state failed:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}