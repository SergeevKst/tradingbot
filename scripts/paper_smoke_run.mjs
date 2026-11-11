#!/usr/bin/env node
/**
 * `paper:smoke` — reproducible PAPER smoke run on public market data.
 *
 * What this does
 * --------------
 * Fetches PUBLIC, unauthenticated Bybit market data (ticker + klines +
 * instrument metadata), records it to `<out>/market-data.json`, then replays
 * those candles through the canonical PAPER session: deterministic
 * `deterministic-ma-crossover` strategy -> Risk Engine -> simulated fills ->
 * persistence -> journal.
 *
 * Then it closes whatever is still open at the final candle and writes
 * `<out>/smoke-summary.json`, which carries the trades, the fees, the equity
 * change AND the self-checks:
 *
 *   - net PnL reconciliation: Σ(round-trip net PnL) === equity change, 1e-6;
 *   - the same figure recomputed from the journal, independently of the fills;
 *   - zero exchange write attempts: every HTTP request is recorded and the
 *     wrapper REFUSES any non-GET or non-`/v5/market/*` request, so an order
 *     attempt would fail the run loudly instead of silently succeeding.
 *
 * Re-running offline is exact:
 *
 *   node scripts/paper_smoke_run.mjs --replay <out>/market-data.json --out <dir2>
 *
 * What this does NOT do
 * ---------------------
 * It places no orders, reads no credentials, calls no model, and proves nothing
 * about profitability. The strategy is a fixed MA crossover used as a signal
 * source; the result is a plumbing and accounting check, not a trading result.
 * The bid/ask for each historical candle is DERIVED (see `--spread-usd`) from
 * the observed live spread around the candle close, because public klines carry
 * no book. That modelling choice is recorded in the summary.
 *
 * Usage:
 *   node scripts/paper_smoke_run.mjs [--symbol BTCUSDT] [--interval 5]
 *                                    [--candles 200] [--out <dir>]
 *                                    [--replay <market-data.json>]
 *                                    [--spread-usd 0.2] [--equity 340]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

import { loadConfig } from '../src/config/env.mjs';
import { createRateFeeModel } from '../src/state/fee-model.mjs';
import { createPaperSession } from '../src/session/paper-session.mjs';
import { createRestMarketDataAdapter } from '../src/market/rest-market-data-adapter.mjs';
import { createMarketSnapshot } from '../src/market/market-snapshot.mjs';
import { normalizePrice } from '../src/market/normalize.mjs';
import { MA_CROSSOVER_ID } from '../src/strategy/deterministic-ma-crossover.mjs';
import { createLogger } from '../src/util/logger.mjs';
import { createAuditedFetch } from './lib/audited-market-fetch.mjs';

const RECONCILIATION_TOLERANCE_USD = 1e-6;

/** Naive flag parsing: `--name value` and bare `--flag`. */
function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      args[token.slice(2)] = true;
    } else {
      args[token.slice(2)] = next;
      index += 1;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const logger = createLogger('SMOKE');

/**
 * @param {number} value
 * @param {number} tickSize
 * @returns {number}
 */
function roundToTick(value, tickSize) {
  const normalized = normalizePrice(value, tickSize);
  return normalized.ok ? normalized.value : value;
}

/**
 * Read the journal and pull out the numbers the summary cross-checks.
 *
 * @param {string} journalFile
 */
async function auditJournal(journalFile) {
  let text;
  try {
    text = await readFile(journalFile, 'utf8');
  } catch {
    return { events: 0, closeEvents: [], closePnlUsd: 0, entryFeesUsd: 0, eventTypes: [] };
  }

  const events = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // A partial trailing line is tolerated by the journal reader too.
    }
  }

  const closeEvents = events.filter((event) => event.eventType === 'POSITION_CLOSED');
  const entryFills = events.filter((event) => event.eventType === 'ORDER_FILLED');
  const sum = (list, key) => list.reduce((total, event) => total + (Number(event[key]) || 0), 0);

  return {
    events: events.length,
    eventTypes: [...new Set(events.map((event) => event.eventType))],
    closeEvents: closeEvents.map((event) => ({
      symbol: event.symbol,
      side: event.side,
      quantity: event.quantity,
      price: event.price,
      pnl: event.pnl,
      fee: event.fee,
      reason: event.reason,
      at: event.timestamp,
    })),
    closePnlUsd: sum(closeEvents, 'pnl'),
    entryFeesUsd: sum(entryFills, 'fee'),
  };
}

async function main() {
  const config = loadConfig();
  const symbol = String(args.symbol ?? config.paper.defaultSymbol ?? 'BTCUSDT').toUpperCase();
  const interval = String(args.interval ?? '5');
  const candleLimit = Number(args.candles ?? 200);
  const outDir = resolve(String(args.out ?? 'artifacts/paper-smoke'));
  const initialEquityUsd = Number(args.equity ?? config.risk.initialCapitalUsd);

  await mkdir(outDir, { recursive: true });
  const marketDataFile = join(outDir, 'market-data.json');
  const stateFile = join(outDir, 'paper-state.json');
  const journalFile = join(outDir, 'journal.jsonl');

  const network = { requests: [] };
  /** @type {{ source: string, fetchedAt: string, endpoints: string[], dataFile: string, sha256: string }} */
  let provenance;

  /** @type {{ symbol: string, interval: string, instrument: object, candles: object[], observedBook: object | null }} */
  let recorded;

  if (args.replay) {
    const replayFile = resolve(String(args.replay));
    const parsed = JSON.parse(await readFile(replayFile, 'utf8'));
    recorded = parsed.recorded;
    provenance = {
      source: 'replay',
      fetchedAt: parsed.provenance?.fetchedAt ?? 'unknown',
      endpoints: parsed.provenance?.endpoints ?? [],
      dataFile: replayFile,
      sha256: createHash('sha256').update(JSON.stringify(parsed.recorded)).digest('hex'),
    };
    if (recorded.symbol !== symbol) {
      throw new Error(`Replay file holds ${recorded.symbol}, but --symbol is ${symbol}`);
    }
    logger.info('replaying recorded public market data', { file: replayFile, candles: recorded.candles.length });
  } else {
    const marketData = createRestMarketDataAdapter({
      baseUrl: config.bybitBaseUrl,
      category: config.paper.market.category,
      timeoutMs: config.paper.market.requestTimeoutMs,
      fetchImpl: createAuditedFetch(network),
    });

    const snapshot = await marketData.getSnapshot(symbol, { interval, candleLimit, includeCandles: true });
    recorded = {
      symbol: snapshot.symbol,
      interval,
      instrument: snapshot.instrument,
      candles: snapshot.candles.map((candle) => ({ ...candle })),
      observedBook: { bid: snapshot.bid, ask: snapshot.ask, markPrice: snapshot.markPrice, lastPrice: snapshot.lastPrice },
    };
    provenance = {
      source: `public REST ${config.bybitBaseUrl}`,
      fetchedAt: new Date().toISOString(),
      endpoints: network.requests.map((request) => `${request.method} ${request.path}`),
      dataFile: marketDataFile,
      sha256: createHash('sha256').update(JSON.stringify(recorded)).digest('hex'),
    };
    await writeFile(
      marketDataFile,
      `${JSON.stringify({ schemaVersion: 1, recordedAt: new Date().toISOString(), provenance, recorded }, null, 2)}\n`,
      'utf8',
    );
    logger.info('recorded public market data', {
      file: marketDataFile,
      candles: recorded.candles.length,
      requests: network.requests.length,
    });
  }

  const candles = recorded.candles;
  if (candles.length < 20) throw new Error(`Need at least 20 candles to replay, got ${candles.length}`);

  const tickSize = Number(recorded.instrument?.tickSize ?? 0.1);
  // Spread model: the observed live spread, applied symmetrically around every
  // historical close. It is a documented assumption, not observed book data.
  const observedSpread =
    Number.isFinite(recorded.observedBook?.ask) && Number.isFinite(recorded.observedBook?.bid)
      ? recorded.observedBook.ask - recorded.observedBook.bid
      : null;
  const spreadUsd = Number(args['spread-usd'] ?? (observedSpread && observedSpread > 0 ? observedSpread : tickSize));
  if (!Number.isFinite(spreadUsd) || spreadUsd <= 0) throw new Error(`Invalid --spread-usd ${args['spread-usd']}`);

  // The session clock follows the candle being replayed, not the wall clock.
  // Without this the journal would stamp every event with the real time of the
  // run, and the same recorded data would produce a different journal (and
  // different UTC day rollovers) on every replay.
  let simulationClock = new Date(candles[0].startTime).toISOString();

  const session = await createPaperSession({
    riskConfig: config.risk,
    feeModel: createRateFeeModel({ entryRate: config.paper.takerFeeRate, exitRate: config.paper.exitFeeRate }),
    paths: { stateFile, journalFile, initialEquityUsd, persist: true },
    logger: createLogger('PAPER'),
    now: () => simulationClock,
  });

  const accountStart = await session.getAccountState();
  if (accountStart.positions.length > 0 || accountStart.equityUsd !== initialEquityUsd) {
    throw new Error(
      `The output directory already holds a paper account (${accountStart.positions.length} positions, equity ${accountStart.equityUsd}). ` +
        'Point --out at a fresh directory so the smoke run starts from a known flat state.',
    );
  }

  /** @type {object[]} */
  const entries = [];
  /** @type {object[]} */
  const exits = [];
  /** @type {object[]} */
  const rejections = [];
  const roundTripNetPnl = [];

  /**
   * @param {number} index
   */
  function snapshotAt(index) {
    const candle = candles[index];
    const close = candle.close;
    return createMarketSnapshot({
      symbol,
      timestamp: new Date(candle.startTime).toISOString(),
      lastPrice: close,
      markPrice: close,
      bid: roundToTick(close - spreadUsd / 2, tickSize),
      ask: roundToTick(close + spreadUsd / 2, tickSize),
      candleTimeframe: recorded.interval,
      candles: candles.slice(0, index + 1),
      instrument: recorded.instrument,
    });
  }

  for (let index = 0; index < candles.length; index += 1) {
    const snapshot = snapshotAt(index);
    simulationClock = snapshot.timestamp;

    const update = await session.onMarketUpdate(snapshot);
    for (const closed of update.closed) {
      roundTripNetPnl.push(closed.netPnlUsd);
      exits.push({
        kind: 'protective',
        symbol: closed.symbol,
        exitReason: closed.exitReason,
        price: closed.fill.fillPrice,
        quantity: closed.fill.quantity,
        entryFeeUsd: closed.fill.entryFeeUsd,
        exitFeeUsd: closed.fill.exitFeeUsd,
        grossPnlUsd: closed.fill.grossPnlUsd,
        netPnlUsd: closed.netPnlUsd,
        at: closed.fill.timestamp,
      });
    }
    for (const error of update.errors) rejections.push({ kind: 'market-update', detail: error });

    // Only ask for entries once there is enough history for the strategy.
    if (index >= 7) {
      const outcome = await session.submitFromStrategy({ market: snapshot, strategyId: MA_CROSSOVER_ID });
      if (outcome.signal === true && outcome.executed === true) {
        const fill = outcome.executionResult.fill;
        entries.push({
          symbol: fill.symbol,
          side: fill.side,
          price: fill.fillPrice,
          quantity: fill.quantity,
          notionalUsd: fill.notionalUsd,
          entryFeeUsd: fill.feeUsd,
          stopLossPrice: outcome.proposal.stopLossPrice,
          takeProfitPrice: outcome.proposal.takeProfitPrice,
          riskUsd: outcome.riskResult.riskAmountUsd,
          riskReward: outcome.riskResult.riskReward,
          at: fill.timestamp,
        });
      } else if (outcome.signal === true && outcome.executed === false) {
        rejections.push({ kind: 'execution', reasonCode: outcome.reasonCode, detail: outcome.message ?? null, at: snapshot.timestamp });
      }
    }
  }

  // Close whatever survived to the end so every round trip is complete and the
  // reconciliation covers the whole run.
  let open = await session.getOpenPositions();
  if (open.length > 0) {
    const finalSnapshot = snapshotAt(candles.length - 1);
    await session.onMarketUpdate(finalSnapshot);
    open = await session.getOpenPositions();
    for (const position of open) {
      const result = await session.closePosition({ symbol: position.symbol, market: finalSnapshot, reason: 'END_OF_REPLAY' });
      if (result.ok) {
        roundTripNetPnl.push(result.fill.netPnlUsd);
        exits.push({
          kind: 'end-of-replay',
          symbol: result.fill.symbol,
          exitReason: 'END_OF_REPLAY',
          price: result.fill.fillPrice,
          quantity: result.fill.quantity,
          entryFeeUsd: result.fill.entryFeeUsd,
          exitFeeUsd: result.fill.exitFeeUsd,
          grossPnlUsd: result.fill.grossPnlUsd,
          netPnlUsd: result.fill.netPnlUsd,
          at: result.fill.timestamp,
        });
      } else {
        rejections.push({ kind: 'close', reasonCode: result.reasonCode, detail: result.message ?? null });
      }
    }
  }

  await session.flushJournal();
  const accountEnd = await session.getAccountState();
  const journal = await auditJournal(journalFile);

  const equityChangeUsd = accountEnd.equityUsd - accountEnd.initialEquityUsd;
  const summedRoundTripUsd = roundTripNetPnl.reduce((sum, value) => sum + value, 0);
  const reconciliationDeltaUsd = equityChangeUsd - summedRoundTripUsd;
  const journalDeltaUsd = equityChangeUsd - journal.closePnlUsd;

  const nonMarketRequests = network.requests.filter((request) => !request.path.startsWith('/v5/market/'));
  const writeAttempts = network.requests.filter((request) => request.method !== 'GET');

  /** Count rejections by reason so the gate's behaviour is readable at a glance. */
  const rejectionCounts = {};
  for (const rejection of rejections) {
    const key = rejection.reasonCode ?? rejection.kind;
    rejectionCounts[key] = (rejectionCounts[key] ?? 0) + 1;
  }

  const checks = [
    {
      name: 'reconciliation: Σ(round-trip net PnL) equals the equity change',
      ok: Math.abs(reconciliationDeltaUsd) <= RECONCILIATION_TOLERANCE_USD,
      detail: `delta ${reconciliationDeltaUsd.toExponential(3)} USD (tolerance ${RECONCILIATION_TOLERANCE_USD})`,
    },
    {
      name: 'journal cross-check: Σ(POSITION_CLOSED pnl) equals the equity change',
      ok: Math.abs(journalDeltaUsd) <= RECONCILIATION_TOLERANCE_USD,
      detail: `delta ${journalDeltaUsd.toExponential(3)} USD over ${journal.closeEvents.length} close events`,
    },
    {
      name: 'zero exchange writes: every request was a GET to /v5/market/*',
      ok: writeAttempts.length === 0 && nonMarketRequests.length === 0,
      detail: `${network.requests.length} requests, ${nonMarketRequests.length} non-market, ${writeAttempts.length} non-GET`,
    },
    {
      name: 'at least one simulated round trip with real fees was recorded',
      ok: entries.length > 0 && exits.length > 0 && accountEnd.feesUsd > 0,
      detail: `${entries.length} entries, ${exits.length} exits, ${accountEnd.feesUsd.toFixed(6)} USD fees`,
    },
    {
      name: 'the account is flat at the end',
      ok: accountEnd.positions.length === 0,
      detail: `${accountEnd.positions.length} open positions`,
    },
  ];

  const summary = {
    schemaVersion: 1,
    task: 't_3b7bc926',
    generatedAt: new Date().toISOString(),
    mode: 'PAPER',
    disclaimer:
      'Simulated PAPER run on public market data. No exchange order was placed, no credential was read, no model was called. ' +
      'A deterministic MA-crossover strategy supplied the signals. These numbers are a plumbing and accounting check and are NOT a profitability claim.',
    market: {
      symbol,
      interval,
      candles: candles.length,
      firstCandleAt: new Date(candles[0].startTime).toISOString(),
      lastCandleAt: new Date(candles[candles.length - 1].startTime).toISOString(),
      priceFirstClose: candles[0].close,
      priceLastClose: candles[candles.length - 1].close,
      spreadModel: `observed live spread ${spreadUsd} USD applied symmetrically around each candle close (public klines carry no book)`,
      spreadUsd,
      tickSize,
    },
    session: {
      initialEquityUsd,
      feeRates: { entry: config.paper.takerFeeRate, exit: config.paper.exitFeeRate },
      feeNote: 'Fee rates are the project\'s synthetic placeholders, not Bybit\'s real schedule.',
      riskConfig: config.risk,
      strategyId: MA_CROSSOVER_ID,
    },
    provenance,
    execution: {
      adapterKind: 'PAPER',
      canPlaceRealOrders: false,
      network: {
        total: network.requests.length,
        endpoints: network.requests.map((request) => `${request.method} ${request.path}`),
        nonMarket: nonMarketRequests.length,
        writeAttempts: writeAttempts.length,
      },
    },
    results: {
      entries,
      exits,
      rejections,
      rejectionCounts,
      entryCount: entries.length,
      exitCount: exits.length,
      feesUsd: accountEnd.feesUsd,
      realizedPnlUsd: accountEnd.realizedPnlUsd,
      unrealizedPnlUsd: accountEnd.unrealizedPnlUsd,
      equityStartUsd: accountEnd.initialEquityUsd,
      equityEndUsd: accountEnd.equityUsd,
      equityChangeUsd,
      summedRoundTripNetPnlUsd: summedRoundTripUsd,
      reconciliationDeltaUsd,
      journal: {
        events: journal.events,
        eventTypes: journal.eventTypes,
        closeEvents: journal.closeEvents,
        closePnlUsd: journal.closePnlUsd,
        entryFeesUsd: journal.entryFeesUsd,
      },
    },
    checks,
    ok: checks.every((check) => check.ok),
  };

  const summaryFile = join(outDir, 'smoke-summary.json');
  await writeFile(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');

  // ---- console report -----------------------------------------------------
  console.log('');
  console.log('PAPER SMOKE RUN');
  console.log('  mode           : PAPER (local simulated fills only)');
  console.log('  symbol/interval:', `${symbol} / ${interval}m`);
  console.log('  candles        :', candles.length, summary.market.firstCandleAt, '->', summary.market.lastCandleAt);
  console.log('  data source    :', provenance.source);
  console.log('  data sha256    :', provenance.sha256);
  console.log('');
  console.log('EXECUTION');
  console.log('  entries        :', entries.length);
  console.log('  exits          :', exits.length, `(protective ${exits.filter((e) => e.kind === 'protective').length}, end-of-replay ${exits.filter((e) => e.kind === 'end-of-replay').length})`);
  console.log('  rejections     :', rejections.length, JSON.stringify(rejectionCounts));
  console.log('  network calls  :', network.requests.length, '(non-market 0, non-GET 0 expected)');
  console.log('  real orders    : 0');
  console.log('');
  console.log('ACCOUNTING');
  console.log('  equity start   :', accountEnd.initialEquityUsd.toFixed(6));
  console.log('  equity end     :', accountEnd.equityUsd.toFixed(6));
  console.log('  equity change  :', equityChangeUsd.toFixed(6));
  console.log('  Σ round trips  :', summedRoundTripUsd.toFixed(6));
  console.log('  reconciliation :', reconciliationDeltaUsd.toExponential(3), 'USD');
  console.log('  fees paid      :', accountEnd.feesUsd.toFixed(6));
  console.log('  realized       :', accountEnd.realizedPnlUsd.toFixed(6));
  console.log('  unrealized     :', accountEnd.unrealizedPnlUsd.toFixed(6));
  console.log('');
  console.log('CHECKS');
  for (const check of checks) console.log(`  ${check.ok ? 'PASS' : 'FAIL'}  ${check.name} — ${check.detail}`);
  console.log('');
  console.log('  summary        :', summaryFile);
  console.log('  journal        :', journalFile);
  console.log('  state          :', stateFile);
  if (!args.replay) console.log('  market data    :', marketDataFile);
  console.log('');

  if (!summary.ok) {
    console.error('SMOKE RUN FAILED — one or more checks did not pass.');
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('paper:smoke failed:', error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
