/**
 * Telegram bot entry — full pipeline (Phases 1–5).
 *
 * Flow:
 *   /trade → collect market data → DeepSeek scout (flash) proposes ideas
 *          → DeepSeek guard (pro) validates each idea → survivors get inline
 *          Approve/Decline buttons → on Approve an order is placed on mainnet.
 *
 * Long-polling (no public IP/server). Every stage writes an audit record so the
 * whole chain — market → scout → guard → approve → execute — is traceable.
 */

import { Bot, InlineKeyboard } from 'grammy';
import { readFileSync, writeFileSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeepSeekChat } from './deepseek-client.mjs';
import { createBybitRestMarketDataAdapter } from '../adapters/bybit/rest-market-data-adapter.mjs';
import { createPipelineLogger } from './pipeline-log.mjs';
import {
  placeLimitOrder,
  placeMarketOrder,
  placeSpotMarketOrder,
  placeSpotConditionalOrder,
  setLeverage,
  getCurrentPrice,
  waitForSpotBalance,
  fetchOpenPositions,
  fetchSpotHoldings,
  fetchOpenOrders,
  setTradingStopBySymbol,
  cancelSpotOrder,
  fetchKlines,
  fetchTickSize,
  fetchSpotQtyPrecision,
  snapSpotQty,
  fetchRecentClosedPnl,
  fetchClosedPnlHistory,
} from './execute.mjs';
import { sizePosition, snapPrice } from './size.mjs';
import { normalizeQuantity } from '../market/normalize.mjs';
import { gatherNews } from './news.mjs';
import { fetchMarketSentiment, formatSentiment } from './sentiment.mjs';
import { computeTrailingStop, snapTrailingPrice, computeATR, trailDistanceFromATR, computeTrailingTakeProfit, harvestDecision } from './trailing.mjs';
import { buildMonitorPrompt, parseMonitorResponse } from './monitor.mjs';
import { buildStopcheckPrompt, parseStopcheckResponse, shouldConsultStopcheck, isTrendAgainst, decideStopcheckAction } from './stopcheck.mjs';
import { createReflector, appendReflection, readPendingRulesTail, inferExitCause } from './reflect.mjs';
import { loadState, saveState } from './state.mjs';
import { summarizeCandles, computeBtcBlock, summarize4h } from './market-summary.mjs';
import { precheckIdea, shouldSkipAutoEntry } from './risk-filter.mjs';
import { buildAuthHeaders } from '../testnet/auth.mjs';

/** Symbols the scout looks at. 15 liquid coins, no scam tokens. */
const WATCH_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'DOGEUSDT', 'SUIUSDT', 'NEARUSDT', 'XRPUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT', 'LTCUSDT', 'DOTUSDT', '1000PEPEUSDT', 'APTUSDT', 'BCHUSDT'];

function loadBotToken(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (typeof token !== 'string' || token.trim() === '') {
    throw new Error('TELEGRAM_BOT_TOKEN is not set in the environment. Add it to .env.');
  }
  return token.trim();
}

/**
 * Build a compact market context for the scout from live snapshots.
 * Includes true 24h high/low (last 24 hourly bars), a volatility unit, and a
 * precomputed BTC trend block.
 */
async function buildMarketContext(marketData) {
  const snapshots = [];
  for (const symbol of WATCH_SYMBOLS) {
    try {
      const snap = await marketData.getSnapshot(symbol, { interval: '60', candleLimit: 100 });
      const candles = snap.candles ?? [];
      const summary = summarizeCandles(candles);

      // S-6: compact 4h summary for longer-horizon context
      let summary4h = null;
      try {
        const snap4h = await marketData.getSnapshot(symbol, { interval: '240', candleLimit: 30 });
        const candles4h = snap4h.candles ?? [];
        summary4h = summarize4h(candles4h);
      } catch {
        /* 4h is advisory; skip if unavailable */
      }

      snapshots.push({
        symbol,
        lastPrice: snap.lastPrice,
        bid: snap.bid,
        ask: snap.ask,
        high24h: summary.high24h,
        low24h: summary.low24h,
        avgRange14h: summary.avgRange14h,
        bias4h: summary4h?.bias4h ?? null,
        swingHigh4h: summary4h?.swingHigh4h ?? null,
        swingLow4h: summary4h?.swingLow4h ?? null,
        instrument: {
          tickSize: snap.instrument?.tickSize,
          qtyStep: snap.instrument?.qtyStep,
          minOrderQty: snap.instrument?.minOrderQty,
          maxOrderQty: snap.instrument?.maxOrderQty,
          minNotionalUsd: snap.instrument?.minNotionalUsd,
        },
        candles: candles.slice(-30).map((c) => ({ o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume })),
      });
    } catch {
      /* one broken symbol must not kill the run */
    }
  }
  const btcSnap = snapshots.find((s) => s.symbol === 'BTCUSDT');
  const btc = btcSnap ? computeBtcBlock(btcSnap.candles) : null;
  return { symbols: snapshots, btc, generatedAt: new Date().toISOString() };
}

/**
 * Read live wallet equity + available balance from Bybit mainnet.
 * Returns `{ equityUsd, availableBalanceUsd }`; throws on failure.
 */
async function fetchWalletBalance(apiKey, apiSecret) {
  const timestamp = Date.now();
  const headers = buildAuthHeaders({
    apiKey,
    apiSecret,
    method: 'GET',
    queryString: 'accountType=UNIFIED',
    body: '',
    timestamp,
    recvWindow: 5000,
  });
  const res = await fetch(`${'https://api.bybit.com'}/v5/account/wallet-balance?accountType=UNIFIED`, { headers });
  const payload = await res.json();
  if (payload.retCode !== 0) {
    throw new Error(`wallet-balance failed retCode=${payload.retCode}: ${payload.retMsg ?? ''}`);
  }
  const list = payload.result?.list ?? [];
  const acct = list[0] ?? {};
  const totalEquity = acct.totalEquity;
  const totalAvailable = acct.totalAvailableBalance;
  const totalWallet = acct.totalWalletBalance;
  const equity = Number(totalEquity);
  // On a UTA (unified margin) account `totalAvailableBalance` is EMPTY, and
  // `totalWalletBalance` counts coins locked in spot holdings (e.g. BTC held
  // spot) as "available" when they are not free to trade. The RELIABLE "free to
  // open new orders" figure is the USDT the account actually holds available:
  // sum the wallet balances of quote/stable coins (USDT, USDC, ...). Fall back
  // to totalWalletBalance only when no stable coin is present.
  const coins = Array.isArray(acct.coin) ? acct.coin : [];
  const STABLE = new Set(['USDT', 'USDC', 'USDE', 'DAI', 'FDUSD', 'TUSD', 'EUR', 'USD']);
  let freeStableUsd = 0;
  let hasStable = false;
  for (const c of coins) {
    if (STABLE.has(c.coin)) {
      hasStable = true;
      freeStableUsd += Number(c.walletBalance) || 0;
    }
  }
  let available;
  if (totalAvailable !== '' && totalAvailable !== undefined && totalAvailable !== null && totalAvailable !== 0) {
    available = Number(totalAvailable);
  } else if (hasStable) {
    available = freeStableUsd;
  } else {
    available = Number(totalWallet);
  }
  return {
    equityUsd: Number.isFinite(equity) ? equity : null,
    availableBalanceUsd: Number.isFinite(available) ? available : null,
  };
}

/** Slim market context for the guard: only the idea's symbol + the BTC block. */
export function contextForIdea(context, symbol) {
  const snap = context.symbols.find((s) => s.symbol === symbol) ?? null;
  return { symbol: snap, btc: context.btc ?? null };
}

/** Escape a string for Telegram HTML parse_mode. */
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Format one approved idea into a full card for the user. */
function formatCard(idea, verdict) {
  const reason = Array.isArray(verdict.reasons) ? verdict.reasons.join('; ') : '';
  return [
    `🔸 <b>${escapeHtml(idea.symbol)}</b> — ${escapeHtml(idea.side)}`,
    `Вход: <code>${escapeHtml(idea.entry)}</code>`,
    `Стоп: <code>${escapeHtml(idea.stopLoss)}</code>`,
    `Тейк: <code>${escapeHtml(idea.takeProfit)}</code>`,
    `Качество сетапа: ${escapeHtml(Math.round(verdict.confidence * 100))}%`,
    '',
    `<i>${escapeHtml(String(idea.rationale ?? '').slice(0, 400))}</i>`,
    '',
    `✅ Одобрено гвардом: ${escapeHtml(reason)}`,
  ].join('\n');
}

/**
 * Read the approve-time price-drift thresholds from the environment.
 *
 * The thresholds are percentages (of the proposed entry price), not absolute
 * cents, so one profile works across BTC ($100k), ETH ($2.5k) and low-priced
 * alts alike.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ slippagePct: number, refreshPct: number }}
 */
function loadApproveThresholds(env = process.env) {
  const num = (raw, def, name) => {
    const v = Number(raw);
    if (raw !== undefined && raw !== '' && (!Number.isFinite(v) || v <= 0)) {
      throw new Error(`${name} must be a positive number, got ${JSON.stringify(raw)}`);
    }
    return (raw === undefined || raw === '') ? def : v;
  };
  const slippagePct = num(env.APPROVE_SLIPPAGE_PCT, 0.15, 'APPROVE_SLIPPAGE_PCT');
  const refreshPct = num(env.APPROVE_REFRESH_PCT, 1.0, 'APPROVE_REFRESH_PCT');
  if (refreshPct <= slippagePct) {
    throw new Error('APPROVE_REFRESH_PCT must be greater than APPROVE_SLIPPAGE_PCT');
  }
  return { slippagePct, refreshPct };
}

/**
 * Decide how to enter, comparing the scout's proposed entry against the live
 * price at the moment the user pressed Approve.
 *
 *   diff ≤ slippagePct              → 'market'   (fill now at current price)
 *   slippagePct < diff ≤ refreshPct → 'refresh'  (re-place limit at live price)
 *   diff > refreshPct               → 'reject'   (market moved too far)
 *
 * `diffPct` is the unsigned percent the live price moved off the proposed entry.
 *
 * @param {{ entry: number, live: number, slippagePct: number, refreshPct: number }} input
 * @returns {{ action: 'market' | 'refresh' | 'reject', diffPct: number }}
 */
function decideEntryMode({ entry, live, slippagePct, refreshPct }) {
  const diffPct = Math.abs(live - entry) / entry * 100;
  if (diffPct <= slippagePct) return { action: 'market', diffPct };
  if (diffPct <= refreshPct) return { action: 'refresh', diffPct };
  return { action: 'reject', diffPct };
}

async function main() {
  const token = loadBotToken();
  const bot = new Bot(token);
  const marketData = createBybitRestMarketDataAdapter();
  const log = createPipelineLogger({ file: process.env.PIPELINE_LOG_FILE ?? 'data/telegram/pipeline.jsonl' });

  let chat = null;
  function getChat() {
    if (chat === null) {
      chat = createDeepSeekChat({
        // Per-role providers: the scout runs cheap (DeepSeek Flash), the guard can
        // be a stronger model. Env-driven so switching costs no code change.
        scoutProvider: process.env.SCOUT_PROVIDER ?? 'deepseek',
        guardProvider: process.env.GUARD_PROVIDER ?? 'deepseek',
        scoutBaseUrl: process.env.SCOUT_BASE_URL,
        guardBaseUrl: process.env.GUARD_BASE_URL,
        deepseekApiKey: process.env.DEEPSEEK_API_KEY,
        kimiApiKey: process.env.KIMI_API_KEY,
        scoutApiKey: process.env.SCOUT_API_KEY,
        guardApiKey: process.env.GUARD_API_KEY,
        model: process.env.SCOUT_MODEL ?? process.env.AI_MODEL,
        guardModel: process.env.GUARD_MODEL ?? process.env.AI_GUARD_MODEL,
        temperature: 0.7,
        // Per-call timeout, env-tunable: reasoning models on a 15-symbol
        // context can exceed the 60s library default.
        timeoutMs: Number(process.env.AI_TIMEOUT_MS ?? 60000),
      });
    }
    return chat;
  }

  // Telegram chat id the monitor sends async notifications to. Persisted to a
  // file so a bot restart does not forget where to send background monitor
  // notifications (otherwise notifications stay silent until the user messages
  // the bot again after every restart).
  const NOTIFY_CHAT_FILE = 'data/telegram/notify-chat.json';
  let notifyChatId = null;

  function setNotifyChatId(id) {
    if (id === null || id === undefined) return;
    notifyChatId = id;
    try {
      writeFileSync(NOTIFY_CHAT_FILE, JSON.stringify({ chatId: id }), { flag: 'w' });
    } catch {
      /* best-effort persistence */
    }
  }

  // Load any previously-saved chat id on startup.
  try {
    const raw = readFileSync(NOTIFY_CHAT_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (Number.isFinite(Number(parsed?.chatId))) notifyChatId = Number(parsed.chatId);
  } catch {
    /* no saved chat id yet */
  }

  // Send a monitor notification to the user (no-op when no chat id is known).
  async function notifyUser(text) {
    if (!notifyChatId) {
      console.error('[notify] skipped — no notifyChatId');
      return;
    }
    try {
      await bot.api.sendMessage(notifyChatId, text, { parse_mode: 'HTML' });
    } catch (error) {
      console.error('[notify] send failed:', error instanceof Error ? error.message : String(error));
      // Retry without HTML in case a stray entity broke parsing.
      try {
        await bot.api.sendMessage(notifyChatId, text.replace(/<[^>]+>/g, ''), { parse_mode: undefined });
      } catch {
        /* give up */
      }
    }
  }

  // DEBUG middleware: log EVERY incoming update so we can verify the bot is
  // actually receiving messages from Telegram. Remove after diagnosis.
  bot.use(async (ctx, next) => {
    console.error('[telegram] UPDATE received:', JSON.stringify({
      update_id: ctx.update.update_id,
      msg: ctx.message ? { from: ctx.message.from?.id, text: ctx.message.text, chat: ctx.message.chat?.id } : null,
      cb: ctx.callbackQuery ? { from: ctx.callbackQuery.from?.id, data: ctx.callbackQuery.data } : null,
    }));
    await next();
  });

  // In-memory store of the last approved ideas, keyed by `${batchId}:${index}`,
  // so Approve/Decline callbacks can resolve what was decided. Cleared per call.
  const pending = new Map();

  // In-memory store for the multi-step preview flow (type → leverage → confirm),
  // keyed by a fresh `orderId` the callback data carries.
  const preview = new Map();
  // How long a preview ticket stays valid (ms). Long enough to wait out a slow
  // reasoner + pick a different coin after an error, without re-running /trade.
  const PREVIEW_TTL_MS = 60 * 60 * 1000; // 60 minutes
  function getPreview(previewId) {
    const p = preview.get(previewId);
    if (!p) return null;
    if (Date.now() - (p.createdAt ?? 0) > PREVIEW_TTL_MS) {
      preview.delete(previewId);
      return null;
    }
    return p;
  }

  bot.command('trade', async (ctx) => {
    const started = Date.now();
    setNotifyChatId(ctx.chat?.id);
    try {
      await ctx.reply('🔍 Собираю рынок и анализирую… (scout → guard, ~30–90 сек)');

      // 1. Market data.
      const context = await buildMarketContext(marketData);
      log.market('market gathered', { symbols: context.symbols.length, symbolsList: context.symbols.map((s) => s.symbol) });

      // 1b. News context — so the scout does not propose a trade that fights an
      // active news catalyst (e.g. shorting SOL into ETF-inflow headlines).
      let fng = null;
      try {
        const { text: newsText, fng: fngValue } = await gatherNews();
        if (newsText) context.news = newsText;
        fng = fngValue ?? null;
        log.market('news gathered', { hasNews: Boolean(newsText), length: newsText?.length ?? 0 });
      } catch {
        /* news is advisory; proceed without it on failure */
      }

      // 1c. Open positions so the scout avoids duplicates and correlated reversals.
      try {
        const apiKey = process.env.BYBIT_API_KEY;
        const apiSecret = process.env.BYBIT_API_SECRET;
        if (apiKey && apiSecret) {
          const [fut, spotH] = await Promise.all([
            fetchOpenPositions({ apiKey, apiSecret }, WATCH_SYMBOLS),
            fetchSpotHoldings({ apiKey, apiSecret }),
          ]);
          context.openPositions = [
            ...fut.map((p) => ({ symbol: p.symbol, side: p.side })),
            ...spotH.map((s) => ({ symbol: s.symbol, side: 'LONG' })),
          ];
        }
      } catch { /* advisory: scout works without positions */ }

      // 2. Scout (deepseek-chat).
      const api = getChat();
      const scout = await api.generateIdeas(context);
      log.scout('scout response', { symbolsSeen: context.symbols.length, ok: scout.parsed.ok, ideaCount: scout.parsed.ideas?.length ?? 0, issues: scout.parsed.issues ?? [], raw: scout.raw });

      if (!scout.parsed.ok) {
        await ctx.reply(`⚠️ Scout вернул неразбираемый ответ.\n\nПричины:\n${scout.parsed.issues.join('\n')}`);
        return;
      }

      const ideas = scout.parsed.ideas;
      if (ideas.length === 0) {
        const issueList = (scout.parsed.issues ?? []).slice(0, 6).join('\n· ');
        await ctx.reply(
          [
            '🤷 Готовых идей нет — рынок не даёт сетап по нашим правилам.',
            '',
            `📥 Собрано символов: ${context.symbols.length}`,
            '🧠 Scout (flash) вернул идей: 0',
            ...(issueList.length ? ['', 'Отсеяно по валидации:', `· ${issueList}`] : ['', 'Модель вернула пустой список — нет сетапа с широким стопом + R/R ≥ 1.5.']),
            '',
            `⏱ Заняло ${((Date.now() - started) / 1000).toFixed(1)} сек`,
          ].join('\n'),
        );
        return;
      }

      // 3. Deterministic precheck + guard (deepseek-reasoner) filters each idea.
      // Run them in parallel so 15 ideas do not take 15 × 40s sequentially.
      const approved = [];
      const rejected = [];
      const guardResults = await Promise.all(
        ideas.map(async (idea) => {
          const pre = precheckIdea(idea, context);
          if (!pre.pass) {
            log.guard('precheck rejected', { symbol: idea.symbol, side: idea.side, reasons: pre.reasons });
            return { idea, guard: null, precheckReasons: pre.reasons };
          }
          // Per-idea sentiment (funding, volume, open interest) + the shared news
          // context, so the guard weighs crowd positioning and liquidity, not just
          // the numeric rules.
          let sentimentText = null;
          try {
            const sent = await fetchMarketSentiment(idea.symbol);
            if (fng && Number.isFinite(fng.value)) {
              sent.fearGreed = fng.value;
              sent.fearGreedClass = fng.classification ?? null;
            }
            sentimentText = formatSentiment(sent);
          } catch {
            sentimentText = null;
          }
          const guard = await api.filterIdea(idea, contextForIdea(context, idea.symbol), { sentiment: sentimentText, news: context.news ?? null });
          log.guard('guard verdict', { symbol: idea.symbol, side: idea.side, verdict: guard.parsed.ok ? guard.parsed.value.verdict : 'PARSE_ERROR', reasons: guard.parsed.ok ? guard.parsed.value.reasons : guard.parsed.issues, raw: guard.raw });
          return { idea, guard, precheckReasons: null };
        }),
      );
      for (const { idea, guard, precheckReasons } of guardResults) {
        if (guard === null) {
          rejected.push({ idea, reasons: precheckReasons });
        } else if (guard.parsed.ok && guard.parsed.value.verdict === 'APPROVED') {
          approved.push({ idea, verdict: guard.parsed.value });
        } else {
          rejected.push({ idea, reasons: guard.parsed.ok ? guard.parsed.value.reasons : guard.parsed.issues });
        }
      }

      // 4. Report: survivors get Approve/Decline buttons.
      if (approved.length === 0) {
        const rejectedSummary = rejected.slice(0, 4).map((r) => `· ${r.idea.symbol} ${r.idea.side}: ${(r.reasons ?? []).join('; ') || 'PARSE_ERROR'}`).join('\n');
        await ctx.reply(
          [
            `📊 Scout предложил ${ideas.length} идей, но гвард (pro) отклонил все.`,
            '',
            rejectedSummary || '',
            '',
            '✅ Итог: не торгуем — правила риска всё отфильтровали.',
          ].join('\n'),
        );
        return;
      }

      const cards = [];
      for (let i = 0; i < approved.length; i++) {
        const { idea, verdict } = approved[i];
        cards.push(`${formatCard(idea, verdict)}`);
      }

      // Send each survivor as its own message with an Approve/Decline keyboard.
      const batchId = String(Date.now());
      for (let i = 0; i < approved.length; i++) {
        const { idea, verdict } = approved[i];
        // Find the instrument grid for this idea's symbol so sizing can snap qty/price.
        const snapForIdea = context.symbols.find((s) => s.symbol === idea.symbol);
        pending.set(`${batchId}:${i}`, {
          idea,
          verdict,
          chatId: ctx.chat?.id,
          createdAt: Date.now(),
          instrument: snapForIdea?.instrument ?? null,
        });
        const keyboard = new InlineKeyboard()
          .text('✅ Approve', `approve:${batchId}:${i}`)
          .text('❌ Decline', `decline:${batchId}:${i}`);
        await ctx.reply(formatCard(idea, verdict), { parse_mode: 'HTML', reply_markup: keyboard });
      }
      await ctx.reply(`📥 Проанализировано монет: <b>${context.symbols.length}</b> · Скаут дал идей: ${ideas.length} · Гвард одобрил: ${approved.length} · Отклонил: ${rejected.length}\n⏱ Заняло ${((Date.now() - started) / 1000).toFixed(1)} сек. Нажми Approve, чтобы поставить ордер, или Decline.`, { parse_mode: 'HTML' });
    } catch (error) {
      log.market('pipeline error', { error: error instanceof Error ? error.message : String(error) });
      await ctx.reply(`❌ Ошибка: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  bot.command('start', async (ctx) => {
    setNotifyChatId(ctx.chat?.id);
    await ctx.reply(
      [
        '👋 Привет! Я локальный крипто-трейд-агент.',
        '',
        '📊 <b>Команды:</b>',
        '/trade — анализ рынка → идеи → апрув → ордер',
        '/status — портфель одной строкой',
        '/orders — карточки позиций с кнопкой «Закрыть»',
        '/monitor — полная проверка позиций (трейлинг стопов)',
        '/stopcheck — проверка убыточности/разворота',
        '/autotrade on|off — авто-вход без апрува (вкл/выкл)',
        '',
        'ℹ️ Авто-режимы:',
        '· монитор — каждые 15 мин',
        '· stop-check — каждые 5 мин',
        '· авто-вход — каждые 30 мин (если включён)',
      ].join('\n'),
      { parse_mode: 'HTML' },
    );
  });

  // Fallback for non-command text. Skip anything that looks like a command so
  // the real command handlers (registered later) still get it.
  // ---- Approve → size via risk engine → multi-step preview ----
  //
  // Flow: Approve → preview card (Спот/Фьючерс) → [Фьючерс: выбор плеча]
  //        → final confirm → execute. The HUMAN decides EVERYTHING; the bot
  //        only prepares numbers and waits.

  async function buildPreview(idea, instrument, apiKey, apiSecret) {
    // Read live equity/balance for the risk engine.
    const walletPayload = await fetchWalletBalance(apiKey, apiSecret);
    const equity = walletPayload.equityUsd;
    const available = walletPayload.availableBalanceUsd;
    if (!Number.isFinite(equity) || equity <= 0) {
      return { error: 'Не удалось прочитать баланс — исполнение отменено.' };
    }

    // One-way mode guard: Bybit keeps ONE position per symbol. If there is
    // already an open position in the OPPOSITE direction, a new order will
    // silently reduce/close it instead of opening the requested side. Warn the
    // user rather than silently doing the wrong thing.
    let oppositeWarning = null;
    try {
      const existing = await fetchOpenPositions({ apiKey, apiSecret }, [idea.symbol]);
      const opp = existing.find((p) => p.side !== idea.side);
      if (opp) {
        oppositeWarning = `⚠️ У тебя уже открыта позиция ${opp.side} ${idea.symbol} (${opp.size}). В one-way режиме Bybit НЕ откроет ${idea.side} — новый ордер закроет/уменьшит существующую позицию.`;
      }
    } catch {
      /* position check is advisory */
    }

    const sizing = sizePosition({ idea, instrument, wallet: { equityUsd: equity, availableBalanceUsd: available } });
    if (!sizing.approved) {
      return { error: `🛑 Риск-движок отклонил сделку:\n${sizing.reason}`, reasonCode: sizing.reasonCode };
    }

    const live = await getCurrentPrice(idea.symbol);
    const proposedEntry = Number(idea.entry);

    return {
      idea,
      instrument,
      sizing,
      live,
      proposedEntry,
      stopLossStr: snapPrice(idea.stopLoss, instrument.tickSize),
      takeProfitStr: snapPrice(idea.takeProfit, instrument.tickSize),
      oppositeWarning,
    };
  }

  function buildPreviewCard(p, extraLines = []) {
    const side = p.idea.side;
    const rr = p.sizing.riskReward != null ? p.sizing.riskReward.toFixed(2) : '—';
    const diffPct = Math.abs(p.live.lastPrice - p.proposedEntry) / p.proposedEntry * 100;
    return [
      `📋 <b>Предпросмотр сделки</b> — <code>${escapeHtml(p.idea.symbol)}</code> ${escapeHtml(side)}`,
      '',
      `Вход (предложено): <code>${snapPrice(p.proposedEntry, p.instrument.tickSize)}</code>`,
      `Сейчас: <code>${p.live.lastPrice}</code> (дрейф ${diffPct.toFixed(2)}%)`,
      `Стоп: <code>${p.stopLossStr}</code>`,
      `Тейк: <code>${p.takeProfitStr}</code> (R/R ≈ ${rr})`,
      '',
      `📏 Размер: <code>${p.sizing.quantityStr}</code> (≈$${p.sizing.notionalUsd.toFixed(2)})`,
      `🎯 Риск: <code>$${p.sizing.riskAmountUsd.toFixed(2)}</code>`,
      '',
      `👉 Выбери <b>тип торговли</b>:`,
      ...extraLines,
    ].join('\n');
  }

  bot.callbackQuery(/^approve:(.+):(\d+)$/, async (ctx) => {
    const key = `${ctx.match[1]}:${ctx.match[2]}`;
    const entry = pending.get(key);
    if (!entry) {
      await ctx.answerCallbackQuery({ text: 'Сделка устарела — запусти /trade заново.' });
      return;
    }
    pending.delete(key);

    const { idea, instrument } = entry;
    try {
      const apiKey = process.env.BYBIT_API_KEY;
      const apiSecret = process.env.BYBIT_API_SECRET;
      if (!apiKey || !apiSecret) {
        await ctx.answerCallbackQuery({ text: 'Нет Bybit-ключей в .env' });
        await ctx.reply('❌ Исполнение невозможно: нет BYBIT_API_KEY/BYBIT_API_SECRET.');
        return;
      }
      if (!instrument || !Number.isFinite(instrument.qtyStep)) {
        await ctx.answerCallbackQuery({ text: 'Нет сетки инструмента' });
        await ctx.reply('❌ Нет instrument-сетки (qtyStep/tickSize) — пропускаю исполнение.');
        return;
      }

      const previewData = await buildPreview(idea, instrument, apiKey, apiSecret);
      if (previewData.error) {
        await ctx.answerCallbackQuery({ text: 'Не получилось собрать предпросмотр' });
        await ctx.reply(previewData.error);
        if (previewData.reasonCode) log.guard('size rejected', { symbol: idea.symbol, reason: previewData.error, reasonCode: previewData.reasonCode });
        return;
      }
      log.guard('size approved', { symbol: idea.symbol, qty: previewData.sizing.quantity, notionalUsd: previewData.sizing.notionalUsd, riskUsd: previewData.sizing.riskAmountUsd });

      const previewId = `pv-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
      previewData.createdAt = Date.now();
      preview.set(previewId, previewData);

      // SHORT is not possible on spot — offer it, but mark spot unavailable for shorts.
      const isShort = idea.side === 'SHORT';
      const spotLabel = isShort ? 'Спот (недоступно)' : 'Спот';
      const keyboard = new InlineKeyboard();
      if (!isShort) keyboard.text(spotLabel, `type:${previewId}:spot`);
      keyboard.text('Фьючерс', `type:${previewId}:linear`);

      await ctx.answerCallbackQuery({ text: 'Собираю предпросмотр' });
      const extraLines = [];
      if (isShort) extraLines.push('· Спот недоступен для SHORT (нельзя шортить, если владеешь монетой)');
      if (previewData.oppositeWarning) extraLines.push(previewData.oppositeWarning);
      await ctx.reply(
        buildPreviewCard(previewData, extraLines),
        { parse_mode: 'HTML', reply_markup: keyboard },
      );
    } catch (error) {
      log.execute('preview failed', { symbol: idea.symbol, error: error instanceof Error ? error.message : String(error) });
      await ctx.answerCallbackQuery({ text: 'Ошибка' });
      await ctx.reply(`❌ Ошибка предпросмотра: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  // ---- Type chosen (Спот / Фьючерс) ----
  bot.callbackQuery(/^type:(.+):(spot|linear)$/, async (ctx) => {
    const previewId = ctx.match[1];
    const type = ctx.match[2];
    const p = getPreview(previewId);
    if (!p) {
      await ctx.answerCallbackQuery({ text: 'Устарело — запусти /trade заново.' });
      return;
    }
    p.type = type;
    const isShort = p.idea.side === 'SHORT';

    if (type === 'linear') {
      // Futures → ask for leverage.
      const keyboard = new InlineKeyboard()
        .text('1×', `lev:${previewId}:1`)
        .text('2×', `lev:${previewId}:2`)
        .text('5×', `lev:${previewId}:5`)
        .text('10×', `lev:${previewId}:10`);
      await ctx.answerCallbackQuery({ text: 'Фьючерс — выбери плечо' });
      await ctx.reply(
        [
          `⚙️ <b>Выбери плечо</b> для фьючерса <code>${escapeHtml(p.idea.symbol)}</code>:`,
          '',
          '· 1× — как спот, ликвидация почти невозможна',
          '· 2× — нужно падение ~50% для ликвидации',
          '· 5× — падение ~20% до ликвидации',
          '· 10× — падение ~10% до ликвидации',
          '',
          '⚠️ Чем выше плечо, тем меньше залога нужно, но тем ближе ликвидация.',
        ].join('\n'),
        { parse_mode: 'HTML', reply_markup: keyboard },
      );
      return;
    }

    // Spot long → straight to final confirm (no leverage on spot).
    const keyboard = new InlineKeyboard()
      .text('✅ Исполнить', `exec:${previewId}:spot`)
      .text('❌ Отмена', `cancel:${previewId}`);
    await ctx.answerCallbackQuery({ text: 'Спот — финальное подтверждение' });
    await ctx.reply(
      finalConfirmCard(p, { type: 'Спот (реальный ETH на кошелёк, без плеча и ликвидации)' }),
      { parse_mode: 'HTML', reply_markup: keyboard },
    );
  });

  // ---- Leverage chosen (futures only) ----
  bot.callbackQuery(/^lev:(.+):(\d+)$/, async (ctx) => {
    const previewId = ctx.match[1];
    const lev = ctx.match[2];
    const p = getPreview(previewId);
    if (!p || p.type !== 'linear') {
      await ctx.answerCallbackQuery({ text: 'Устарело — запусти /trade заново.' });
      return;
    }
    p.leverage = lev;
    const keyboard = new InlineKeyboard()
      .text('✅ Исполнить', `exec:${previewId}:linear`)
      .text('❌ Отмена', `cancel:${previewId}`);
    await ctx.answerCallbackQuery({ text: `Плечо ${lev}×` });
    await ctx.reply(
      finalConfirmCard(p, { type: `Фьючерс с плечом ${lev}×` }),
      { parse_mode: 'HTML', reply_markup: keyboard },
    );
  });

  function finalConfirmCard(p, { type }) {
    const rr = p.sizing.riskReward != null ? p.sizing.riskReward.toFixed(2) : '—';
    const diffPct = Math.abs(p.live.lastPrice - p.proposedEntry) / p.proposedEntry * 100;
    return [
      `⚡ <b>Финальное подтверждение</b> — <code>${escapeHtml(p.idea.symbol)}</code> ${escapeHtml(p.idea.side)}`,
      '',
      `Тип: <b>${escapeHtml(type)}</b>`,
      `Вход (сейчас): <code>${p.live.lastPrice}</code>`,
      `Стоп: <code>${p.stopLossStr}</code>`,
      `Тейк: <code>${p.takeProfitStr}</code> (R/R ≈ ${rr})`,
      '',
      `📏 Размер: <code>${p.sizing.quantityStr}</code> (≈$${p.sizing.notionalUsd.toFixed(2)})`,
      `🎯 Риск: <code>$${p.sizing.riskAmountUsd.toFixed(2)}</code>`,
      `Дрейф от скаута: <code>${diffPct.toFixed(2)}%</code>`,
      '',
      `Точно исполняем?`,
    ].join('\n');
  }

  // ---- Final execution ----
  bot.callbackQuery(/^exec:(.+):(spot|linear)$/, async (ctx) => {
    const previewId = ctx.match[1];
    const type = ctx.match[2];
    const p = getPreview(previewId);
    if (!p) {
      await ctx.answerCallbackQuery({ text: 'Устарело — запусти /trade заново.' });
      return;
    }
    p.type = type;

    const apiKey = process.env.BYBIT_API_KEY;
    const apiSecret = process.env.BYBIT_API_SECRET;
    const { idea, instrument, sizing } = p;
    const side = idea.side === 'LONG' ? 'Buy' : 'Sell';

    try {
      const orderLinkId = `tg-${Date.now()}`;
      let resultMsg;

      if (type === 'spot') {
        // Spot uses a finer qty grid than linear; re-read the SPOT instrument and
        // re-snap the quantity so the order is never rejected for a step mismatch.
        // Spot also enforces a minimum order value (minOrderAmt, usually ~$5);
        // the risk engine's quantity can be smaller than that (it sizes for the
        // stop distance, not for the minimum ticket). We raise the quantity to the
        // spot minimum and report the TRUE notional the user is committing.
        let spotQtyNum = sizing.quantity;
        let spotQtyStep = null;
        let spotMinOrderAmt = null;
        try {
          const spotRes = await fetch(`https://api.bybit.com/v5/market/instruments-info?category=spot&symbol=${encodeURIComponent(idea.symbol)}`);
          const spotP = await spotRes.json();
          const spotInstr = (spotP.result?.list ?? [])[0];
          const lsf = spotInstr?.lotSizeFilter;
          // Spot reports `basePrecision` (not `qtyStep`); the step is 10^-precision.
          const basePrecision = Number(lsf?.basePrecision);
          spotQtyStep = Number.isFinite(basePrecision) && basePrecision > 0 ? Number(`1e-${basePrecision}`) : null;
          spotMinOrderAmt = Number(lsf?.minOrderAmt);
          if (Number.isFinite(spotQtyStep) && spotQtyStep > 0) {
            const norm = normalizeQuantity(spotQtyNum, spotQtyStep);
            if (norm.ok && norm.value !== null) spotQtyNum = norm.value;
          }
        } catch { /* fall back to linear-qty on any spot-metadata error */ }

        const spotPrice = p.live.lastPrice;
        let notional = spotQtyNum * spotPrice;
        // Raise to the exchange minimum order value (with a small buffer so a
        // moving price can't dip it back under the limit mid-flight).
        if (Number.isFinite(spotMinOrderAmt) && spotMinOrderAmt > 0 && notional < spotMinOrderAmt) {
          const targetQty = spotMinOrderAmt * 1.02 / spotPrice;
          if (Number.isFinite(spotQtyStep) && spotQtyStep > 0) {
            const norm = normalizeQuantity(targetQty, spotQtyStep);
            if (norm.ok && norm.value !== null) {
              spotQtyNum = norm.value;
              notional = spotQtyNum * spotPrice;
            }
          } else {
            spotQtyNum = targetQty;
            notional = spotQtyNum * spotPrice;
          }
        }
        const spotQty = String(spotQtyNum);

        // Spot market order, then attach protective TP/SL as conditional orders.
        const entryOrder = await placeSpotMarketOrder(
          { apiKey, apiSecret },
          { symbol: idea.symbol, side, qty: spotQty, orderLinkId },
        );

        // A market buy settles asynchronously: wait for the base coin to land on
        // the spot balance before placing the protective SELL orders, otherwise
        // Bybit rejects them with 170131 Insufficient balance.
        const baseCoin = idea.symbol.replace(/USDT$/, '');
        await waitForSpotBalance({ apiKey, apiSecret }, { coin: baseCoin });

        // Stop-loss (sell when price falls to stop) + take-profit (sell when rises to TP).
        const slDirection = idea.side === 'LONG' ? '2' : '1';
        const tpDirection = idea.side === 'LONG' ? '1' : '2';
        const closeSide = side === 'Buy' ? 'Sell' : 'Buy';
        const slErrors = [];
        let slId = null, tpId = null;
        try {
          slId = await placeSpotConditionalOrder(
            { apiKey, apiSecret },
            { symbol: idea.symbol, side: closeSide, qty: spotQty, triggerPrice: p.stopLossStr, triggerDirection: slDirection, orderLinkId: `${orderLinkId}-sl` },
          );
        } catch (e) { slErrors.push(`Стоп-лосс: ${e instanceof Error ? e.message : String(e)}`); }
        try {
          tpId = await placeSpotConditionalOrder(
            { apiKey, apiSecret },
            { symbol: idea.symbol, side: closeSide, qty: spotQty, triggerPrice: p.takeProfitStr, triggerDirection: tpDirection, orderLinkId: `${orderLinkId}-tp` },
          );
        } catch (e) { slErrors.push(`Тейк-профит: ${e instanceof Error ? e.message : String(e)}`); }

        log.execute('spot order placed', { symbol: idea.symbol, side: idea.side, qty: spotQty, notionalUsd: notional, entryOrderId: entryOrder.orderId, slOrderId: slId?.orderId ?? null, tpOrderId: tpId?.orderId ?? null, slErrors });
        const slWarn = slErrors.length
          ? `\n\n⚠️ <b>Внимание:</b> защитные ордера НЕ поставлены:\n· ${slErrors.join('\n· ')}\n\nБот купил актив, но без стопа/тейка. Проверь вручную!`
          : '';
        resultMsg = buildResultCard(idea, sizing, { entry: p.live.lastPrice, mode: 'spot', orderId: entryOrder.orderId, stopLoss: p.stopLossStr, takeProfit: p.takeProfitStr, diffPct: Math.abs(p.live.lastPrice - p.proposedEntry) / p.proposedEntry * 100, qty: spotQty, notionalUsd: notional }) + slWarn;
      } else {
        // Futures → set leverage explicitly, then place.
        const lev = p.leverage ?? '1';
        try {
          await setLeverage({ apiKey, apiSecret }, { symbol: idea.symbol, leverage: lev });
        } catch (levErr) {
          const msg = levErr instanceof Error ? levErr.message : String(levErr);
          if (msg.includes('110043') || msg.includes('110077')) {
            // 110043 = leverage already equals the requested value.
            // 110077 = Portfolio Margin — exchange sizes leverage itself.
            // Neither is a real error; proceed to place the order.
          } else {
            throw new Error(`Не удалось выставить плечо ${lev}×. ${msg}\n\nЭто значит биржа не применила плечо — попробуй меньшее плечо или другую монету.`);
          }
        }

        const thresholds = loadApproveThresholds();
        const decision = decideEntryMode({
          entry: p.proposedEntry,
          live: p.live.lastPrice,
          slippagePct: thresholds.slippagePct,
          refreshPct: thresholds.refreshPct,
        });

        if (decision.action === 'reject') {
          await ctx.answerCallbackQuery({ text: 'Рынок ушёл — отменено' });
          await ctx.reply(`⛔ Рынок ушёл слишком далеко (${decision.diffPct.toFixed(2)}%) — сделка отменена. Запусти /trade заново.`, { parse_mode: 'HTML' });
          return;
        }

        const baseOrder = {
          symbol: idea.symbol,
          side,
          qty: sizing.quantityStr,
          orderLinkId,
          stopLoss: p.stopLossStr,
          takeProfit: p.takeProfitStr,
          slTriggerBy: 'LastPrice',
          tpTriggerBy: 'LastPrice',
        };
        const isLeveraged = Number(lev) > 1;
        let order;
        if (!isLeveraged) {
          // 1x → place a limit order to avoid market slippage ambiguity.
          const refreshedEntry = snapPrice(p.live.lastPrice, instrument.tickSize);
          order = await placeLimitOrder({ apiKey, apiSecret }, { ...baseOrder, price: refreshedEntry });
          log.execute('futures order placed (1x limit)', { symbol: idea.symbol, side: idea.side, lev, qty: sizing.quantityStr, price: refreshedEntry, orderId: order.orderId });
          resultMsg = buildResultCard(idea, sizing, { entry: refreshedEntry, mode: `futures ${lev}× limit`, orderId: order.orderId, stopLoss: p.stopLossStr, takeProfit: p.takeProfitStr, diffPct: decision.diffPct });
        } else {
          order = await placeMarketOrder({ apiKey, apiSecret }, baseOrder);
          log.execute('futures order placed (market)', { symbol: idea.symbol, side: idea.side, lev, qty: sizing.quantityStr, live: p.live.lastPrice, orderId: order.orderId });
          resultMsg = buildResultCard(idea, sizing, { entry: String(p.live.lastPrice), mode: `futures ${lev}× market`, orderId: order.orderId, stopLoss: p.stopLossStr, takeProfit: p.takeProfitStr, diffPct: decision.diffPct });
        }
      }

      await ctx.answerCallbackQuery({ text: 'Ордер поставлен' });
      await ctx.reply(resultMsg, { parse_mode: 'HTML' });
      preview.delete(previewId); // only drop the ticket AFTER a successful order
    } catch (error) {
      log.execute('order failed', { symbol: idea.symbol, error: error instanceof Error ? error.message : String(error) });
      const raw = error instanceof Error ? error.message : String(error);
      let friendly = raw;
      // 110007 = not enough available balance. Explain what's missing instead of a raw code.
      if (raw.includes('110007')) {
        const free = p?.live ? (p.live.lastPrice * Number(sizing.quantityStr)) : 0;
        friendly = `Не хватает свободного баланса (маржи) для этого ордера.\n\nПозиция ≈ $${free.toFixed(2)}, но на кошельке свободно меньше (часть денег заморожена в других холдах/позициях).\n\nПопробуй: снизить плечо, уменьшить размер, или свободно выбрать другую монету в списке идей.`;
      }
      // Keep the preview ticket alive so the user can pick another coin/leverage
      // without re-running /trade and burning tokens.
      await ctx.answerCallbackQuery({ text: 'Ошибка исполнения' });
      await ctx.reply(
        `❌ Не удалось поставить ордер: ${friendly}\n\nМожно выбрать другую монету в списке идей или нажать /trade заново.`,
        { parse_mode: 'HTML' },
      );
    }
  });

  function buildResultCard(idea, sizing, { entry, mode, orderId, stopLoss, takeProfit, diffPct, qty, notionalUsd }) {
    const finalQty = qty ?? sizing.quantityStr;
    const finalNotional = notionalUsd ?? sizing.notionalUsd;
    return [
      `✅ Ордер поставлен на mainnet (${mode}):`,
      `Символ: <code>${escapeHtml(idea.symbol)}</code> ${escapeHtml(idea.side)}`,
      `Кол-во: <code>${escapeHtml(String(finalQty))}</code> (≈$${Number(finalNotional).toFixed(2)})`,
      `Вход: <code>${escapeHtml(String(entry))}</code>`,
      `Стоп: <code>${escapeHtml(stopLoss)}</code>`,
      `Тейк: <code>${escapeHtml(takeProfit)}</code>`,
      `Дрейф: <code>${diffPct.toFixed(2)}%</code>`,
      `Order ID: <code>${escapeHtml(orderId)}</code>`,
    ].join('\n');
  }

  bot.callbackQuery(/^cancel:(.+)$/, async (ctx) => {
    const previewId = ctx.match[1];
    preview.delete(previewId);
    await ctx.answerCallbackQuery({ text: 'Отменено' });
    await ctx.reply('❌ Сделка отменена тобой. Бот ничего не ставил.');
  });

  bot.callbackQuery(/^decline:(.+):(\d+)$/, async (ctx) => {
    const key = `${ctx.match[1]}:${ctx.match[2]}`;
    pending.delete(key);
    await ctx.answerCallbackQuery({ text: 'Отклонено' });
  });

  // Also keep the simple (no batch) pattern working if any older cards linger.
  bot.callbackQuery(/^approve:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Устаревшая карточка — запусти /trade заново.' });
  });
  bot.callbackQuery(/^decline:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery({ text: 'Отклонено' });
  });

  // ---- MVP-2: position monitor ----

  // Persistent process state: daily loss counters, auto-opened symbols,
  // reflected close ids, and previous-position snapshots.
  const state = await loadState();

  // Track close record ids we've already reflected on, so the reflector fires
  // once per closed position, not on every poll.
  const reflected = new Set(state.reflectedCloseIds ?? []);

  // In-memory store for pending EXIT proposals, keyed by proposal id.
  const exitProposals = new Map();

  // Auto-trader state: enabled flag, daily realized-loss tally (USD), and a
  // small set of the auto-entries currently open (symbols).
  let autoTradeEnabled = false;
  let autoDailyLossUsd = state.autoDailyLossUsd ?? 0;
  // Symbols the auto-trader has opened, so its position cap counts ONLY its own
  // entries and does not block on the human's manual positions.
  const autoOpenedSymbols = new Set(state.autoOpenedSymbols ?? []);

  // Snapshot of positions seen on the previous pass, keyed by `kind:symbol`,
  // to detect when a position closes between monitor cycles.
  const prevPositions = new Map(Object.entries(state.prevPositions ?? {}));

  // Peak unrealised PnL per position key (T-1 harvest lock).
  const positionsPeak = new Map(Object.entries(state.positionsPeak ?? {}));

  /** Persist the mutable slices of process state. Never throws. */
  async function persistState() {
    state.reflectedCloseIds = Array.from(reflected).slice(-500);
    state.autoDailyLossUsd = autoDailyLossUsd;
    state.autoOpenedSymbols = Array.from(autoOpenedSymbols);
    state.prevPositions = Object.fromEntries(prevPositions);
    state.positionsPeak = Object.fromEntries(positionsPeak);
    await saveState(state);
  }

  // Lazily-created reflector for post-close analysis.
  let reflector = null;
  function getReflector() {
    if (reflector === null) {
      // The reflector is a cheap post-mortem task, so it rides the SCOUT provider
      // (fast/cheap) rather than the guard's reasoning model.
      const provider = process.env.SCOUT_PROVIDER ?? 'deepseek';
      const baseUrl = process.env.SCOUT_BASE_URL
        ?? (provider === 'kimi' ? 'https://api.moonshot.ai' : 'https://api.deepseek.com');
      reflector = createReflector({
        apiKey: provider === 'kimi'
          ? (process.env.KIMI_API_KEY ?? process.env.SCOUT_API_KEY)
          : (process.env.DEEPSEEK_API_KEY ?? process.env.SCOUT_API_KEY),
        baseUrl,
        model: process.env.AI_REFLECT_MODEL ?? process.env.SCOUT_MODEL ?? undefined,
      });
    }
    return reflector;
  }

  /**
   * Run the post-close reflector for a position that just closed. Writes the
   * proposed rule change to the pending file. Never throws.
   *
   * @param {{ symbol: string, side: string, entry: number, exit: number, pnlUsd: number, reason: string, closedId?: string, holdMinutes?: number|null, exitCause?: string }} closed
   */
  async function reflectClosedTrade(closed) {
    const closedId = closed.closedId ?? `${closed.symbol}:${closed.side}`;
    if (reflected.has(closedId)) return;
    reflected.add(closedId);
    // Fold realized loss into the auto-trader daily-loss tally, so the $10/day
    // cap actually reflects today's real losses. Only count auto-opened positions.
    const counted = autoOpenedSymbols.has(closed.symbol);
    const pnl = Number(closed.pnlUsd) || 0;
    if (pnl < 0 && counted) autoDailyLossUsd += pnl;
    // Free the auto-position slot when an auto-opened symbol closes.
    autoOpenedSymbols.delete(closed.symbol);
    try {
      const existingRules = await readPendingRulesTail('data/telegram/rules.pending.md', 20);
      const key = `linear:${closed.symbol}`;
      const mfeUsd = positionsPeak.get(key) ?? null;
      const input = {
        ...closed,
        holdMinutes: closed.holdMinutes ?? null,
        existingRules,
        mfeUsd,
      };
      const refl = await getReflector().reflect(input);
      if (refl) {
        if (refl.matchedExistingRule === true && refl.proposedRule === '') {
          log.guard('reflection skipped (duplicate)', { symbol: closed.symbol, side: closed.side, lesson: refl.lesson });
        } else {
          await appendReflection(refl);
          log.guard('reflection written', { symbol: closed.symbol, side: closed.side, lesson: refl.lesson, severity: refl.severity });
        }
      }
    } catch (error) {
      log.market('reflection failed', { symbol: closed.symbol, error: error instanceof Error ? error.message : String(error) });
    }
    await persistState();
  }

  // Reusable low-level completion for the monitor, using the guard model.
  async function monitorComplete(prompt) {
    const content = await getChat()._completeGuard(prompt);
    const parsed = parseMonitorResponse(content);
    return { parsed, raw: content };
  }

  /**
   * One monitor pass: read futures + spot holdings → for each, gather
   * market+news → review. TRAIL is applied automatically (narrow stop only);
   * EXIT is proposed (never auto-executed).
   *
   * @param {boolean} notify
   * @param {{ forceSummary?: boolean, background?: boolean }} [opts]
   */
  async function runMonitorPass(notify = true, { forceSummary = false, background = false } = {}) {
    const apiKey = process.env.BYBIT_API_KEY;
    const apiSecret = process.env.BYBIT_API_SECRET;
    if (!apiKey || !apiSecret) return;

    const startedAt = Date.now();
    if (notify && !background) await notifyUser('🔍 <b>Мониторинг начался</b> — проверяю позиции, новости и рынок…');

    // Combine futures positions and spot holdings into one list. Each entry
    // carries `kind: 'linear' | 'spot'` so trailing/exits route correctly.
    const [futures, spot] = await Promise.all([
      fetchOpenPositions({ apiKey, apiSecret }, WATCH_SYMBOLS),
      fetchSpotHoldings({ apiKey, apiSecret }),
    ]);
    const positions = [
      ...futures.map((p) => ({ ...p, kind: 'linear' })),
      ...spot.map((s) => ({ ...s, kind: 'spot' })),
    ];

    // Detect position closures → run the reflector once per closed symbol.
    const currentKeys = new Set(positions.map((p) => `${p.kind}:${p.symbol}`));
    for (const [key, prev] of prevPositions) {
      if (!currentKeys.has(key)) {
        if (prev.kind === 'spot') {
          log.market('spot close attribution unavailable — reflection skipped', { symbol: prev.symbol });
          continue;
        }
        const rec = await fetchRecentClosedPnl({ apiKey, apiSecret }, prev.symbol);
        if (rec === null) {
          log.market('close attribution unavailable — reflection skipped', { symbol: prev.symbol });
        } else {
          const holdMinutes = prev.firstSeenAt
            ? Math.round((Date.now() - new Date(prev.firstSeenAt).getTime()) / 60000)
            : null;
          const exitCause = inferExitCause({
            side: prev.side,
            exitPrice: rec.exitPrice,
            stopLoss: prev.stopLoss ?? null,
            takeProfit: prev.takeProfit ?? null,
          });
          await reflectClosedTrade({
            symbol: prev.symbol,
            side: prev.side,
            entry: rec.entryPrice ?? prev.avgPrice,
            exit: rec.exitPrice ?? prev.markPrice,
            pnlUsd: rec.realizedPnlUsd ?? 0,
            reason: `closed on exchange (cause: ${exitCause})`,
            closedId: rec.recordId,
            holdMinutes,
            exitCause,
          });
        }
      }
    }
    prevPositions.clear();
    const nowIso = new Date().toISOString();
    for (const p of positions) {
      const key = `${p.kind}:${p.symbol}`;
      const existing = state.prevPositions?.[key];
      prevPositions.set(key, {
        kind: p.kind,
        symbol: p.symbol,
        side: p.side,
        avgPrice: p.avgPrice,
        markPrice: p.markPrice,
        stopLoss: p.stopLoss ?? null,
        takeProfit: p.takeProfit ?? null,
        unrealisedPnl: p.unrealisedPnl,
        firstSeenAt: existing?.firstSeenAt ?? nowIso,
      });
      // T-1: update peak PnL tracker
      if (p.kind === 'linear') {
        const currentPeak = positionsPeak.get(key) ?? 0;
        const pnl = Number(p.unrealisedPnl) || 0;
        if (pnl > currentPeak) {
          positionsPeak.set(key, pnl);
        }
      }
    }
    await persistState();

    if (positions.length === 0) {
      if (notify && !background) {
        await notifyUser('⚪ Нет открытых позиций и холдов — ИИ не запускался (токены не тратились).');
      }
      return;
    }

    const { text: newsText } = await gatherNews();

    // Precompute BTC trend block once for the whole pass.
    let btcCandles = [];
    try {
      btcCandles = await fetchKlines('BTCUSDT', { interval: '60', limit: 30 });
    } catch { /* advisory */ }
    const btc = computeBtcBlock(btcCandles.map((k) => ({ o: k[0], h: k[1], l: k[2], c: k[3], v: k[4] ?? 0 })));

    for (const pos of positions) {
      try {
        // For spot, avgPrice == markPrice (derived from usdValue). Keep it simple:
        // treat spot avgPrice as its cost proxy and mark as the live price.
        const live = await getCurrentPrice(pos.symbol);
        const markPrice = live.lastPrice;
        const avgPrice = pos.avgPrice ?? markPrice;

        // --- Deterministic trailing (auto) ---
        // Spot: the current stop is read from the resting conditional SL order.
        let currentStop = pos.stopLoss;
        if (pos.kind === 'spot') {
          currentStop = null;
          const spotOrders = await fetchOpenOrders({ apiKey, apiSecret }, 'spot');
          const slOrder = spotOrders.find(
            (o) => o.symbol === pos.symbol && o.side === 'Sell' && o.status === 'Untriggered' && Number(o.triggerPrice) < markPrice,
          );
          if (slOrder && slOrder.triggerPrice !== null) {
            currentStop = Number(slOrder.triggerPrice);
            pos._slOrderId = slOrder.orderId;
          }
        }

        // Volatility-adaptive trail distance: multiplier × ATR(14) of 1h candles,
        // so volatile coins get a wider stop and quiet coins a tighter one.
        const atrMult = Number(process.env.TRAIL_ATR_MULT ?? 2.0);
        const trailActivationPct = Number(process.env.TRAIL_ACTIVATION_PCT ?? 0.8);
        const candles = await fetchKlines(pos.symbol, { interval: '60', limit: 30 });
        const compact = candles.map((k) => ({ o: k[0], h: k[1], l: k[2], c: k[3], v: k[4] ?? 0 }));
        const atr = computeATR(candles, 14) ?? (avgPrice * trailActivationPct / 100);
        const trailDistance = trailDistanceFromATR(atr, atrMult) || (avgPrice * 0.01);
        // The correct price grid for this symbol's category (BTC spot = 0.1, ETH = 0.01).
        const tickSize = (await fetchTickSize(pos.symbol, pos.kind === 'spot' ? 'spot' : 'linear')) ?? 0.01;
        // Correct quantity precision for spot protective orders (BTC = 6 decimals).
        let spotQtyStr = String(pos.size);
        if (pos.kind === 'spot') {
          const qtyPrec = await fetchSpotQtyPrecision(pos.symbol);
          if (qtyPrec !== null) spotQtyStr = snapSpotQty(pos.size, qtyPrec);
        }
        const trail = computeTrailingStop({
          side: pos.side,
          entryPrice: avgPrice,
          currentStop: currentStop ?? (pos.side === 'LONG' ? 0 : Infinity),
          markPrice,
          trailDistance,
          activationPct: trailActivationPct,
        });

        if (trail.moved && trail.stop > 0) {
          const snapped = snapTrailingPrice(trail.stop, pos.side, tickSize);
          if (pos.kind === 'linear' && currentStop !== null) {
            await setTradingStopBySymbol({ apiKey, apiSecret }, { symbol: pos.symbol, stopLoss: snapped });
          } else if (pos.kind === 'spot' && pos._slOrderId) {
            // Cancel old spot SL and re-place at the trailed level.
            await cancelSpotOrder({ apiKey, apiSecret }, { symbol: pos.symbol, orderId: pos._slOrderId });
            await placeSpotConditionalOrder(
              { apiKey, apiSecret },
              {
                symbol: pos.symbol,
                side: 'Sell',
                qty: spotQtyStr,
                triggerPrice: snapped,
                triggerDirection: '2',
                orderLinkId: `sl-trail-${Date.now()}`,
              },
            );
          } else if (pos.kind === 'spot' && !pos._slOrderId) {
            // No SL yet on this spot holding — place one (protection was missing).
            await placeSpotConditionalOrder(
              { apiKey, apiSecret },
              {
                symbol: pos.symbol,
                side: 'Sell',
                qty: spotQtyStr,
                triggerPrice: snapped,
                triggerDirection: '2',
                orderLinkId: `sl-new-${Date.now()}`,
              },
            );
          }
          log.execute('trailing stop applied', { symbol: pos.symbol, kind: pos.kind, side: pos.side, oldStop: currentStop, newStop: snapped });
          if (notify) {
            await notifyUser(
              `📌 <b>Сдвинул стоп</b> по <code>${escapeHtml(pos.symbol)}</code> (${pos.kind === 'spot' ? 'спот' : 'фьючерс'}, ${pos.side}):\n${currentStop ?? 'нет стопа'} → <code>${escapeHtml(snapped)}</code>`,
            );
          }
        }

        // --- Take-profit also trails up in a strong trend (variant 3) ---
        // Mirror the stop's ATR distance above/below price so the exit chases a
        // running trend instead of capping it at a stale fixed TP.
        // T-3: freeze TP once travel >= activationPct so it does not run away forever.
        const travel = pos.side === 'LONG'
          ? (markPrice - avgPrice) / avgPrice * 100
          : (avgPrice - markPrice) / avgPrice * 100;
        const currentTP = pos.takeProfit ?? 0;
        if (travel < trailActivationPct) {
          const tpTrail = computeTrailingTakeProfit({
            side: pos.side,
            markPrice,
            currentTakeProfit: currentTP,
            distance: trailDistance,
          });
          if (tpTrail.moved) {
            const tpSnapped = snapTrailingPrice(tpTrail.takeProfit, pos.side === 'LONG' ? 'SHORT' : 'LONG', tickSize);
            if (pos.kind === 'linear') {
              await setTradingStopBySymbol({ apiKey, apiSecret }, { symbol: pos.symbol, takeProfit: tpSnapped });
            } else if (pos.kind === 'spot') {
              // Spot cannot hold a separate TP conditional sell while the SL already
              // locks the full balance (one coin cannot back two sell orders) —
              // this would fail with 170131 "insufficient balance" every pass.
              // The trailed SL is already the exit; skip a second TP leg.
              log.execute('spot TP skipped (SL is the exit)', { symbol: pos.symbol, tpSnapped });
            }
            log.execute('trailing take-profit applied', { symbol: pos.symbol, kind: pos.kind, side: pos.side, oldTP: currentTP || null, newTP: tpSnapped });
            if (notify && pos.kind === 'linear') {
              await notifyUser(
                `🎯 <b>Поднял тейк</b> по <code>${escapeHtml(pos.symbol)}</code> (${pos.kind === 'spot' ? 'спот' : 'фьючерс'}):\n${currentTP || 'нет тейка'} → <code>${escapeHtml(tpSnapped)}</code>`,
              );
            }
          }
        }

        // --- LLM review (guard) for HOLD/EXIT ---
        const trend = computeBtcBlock(compact);
        const market = {
          symbol: pos.symbol,
          markPrice,
          bid: live.bid,
          ask: live.ask,
          kind: pos.kind,
          atr14h: Number.isFinite(atr) ? atr : null,
          trend,
          btc,
          candles: compact,
        };
        const prompt = buildMonitorPrompt({ position: { ...pos, markPrice, avgPrice }, market, newsText });
        const review = await monitorComplete(prompt);
        if (!review.parsed.ok) {
          log.guard('monitor parse error', { symbol: pos.symbol, issues: review.parsed.issues });
          continue;
        }
        const decision = review.parsed.value;
        log.guard('monitor verdict', { symbol: pos.symbol, kind: pos.kind, side: pos.side, action: decision.action, reason: decision.reason });

        if (decision.action === 'EXIT' && notifyChatId) {
          const pid = `exit-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
          exitProposals.set(pid, { symbol: pos.symbol, side: pos.side, kind: pos.kind, reason: decision.reason });
          const keyboard = new InlineKeyboard()
            .text('✅ Закрыть', `doexit:${pid}`)
            .text('❌ Оставить', `keepexit:${pid}`);
          await bot.api.sendMessage(
            notifyChatId,
            [
              `⚠️ <b>Предлагаю закрыть</b> <code>${escapeHtml(pos.symbol)}</code> ${pos.side} (${pos.kind === 'spot' ? 'спот' : 'фьючерс'})`,
              `Причина: ${escapeHtml(decision.reason)}`,
              `Цена сейчас: <code>${markPrice}</code>`,
              '',
              'Закрыть позицию?',
            ].join('\n'),
            { parse_mode: 'HTML', reply_markup: keyboard },
          );
        }
      } catch (error) {
        log.market('monitor pass error', { symbol: pos.symbol, error: error instanceof Error ? error.message : String(error) });
      }
    }

    if (notify && !background) {
      const dur = ((Date.now() - startedAt) / 1000).toFixed(1);
      await notifyUser(`✅ <b>Мониторинг окончен</b> — проверено позиций: ${positions.length}, заняло ${dur} сек.`);
    }
  }

  // ---- Auto-trader (unattended entry) ----
  //
  // When enabled, a background scan runs scout → guard, and if it finds a setup
  // with high quality (confidence ≥ 0.75) plus supportive sentiment, it enters
  // AUTOMATICALLY (with SL/TP) and notifies you. Bounded by: max 2 concurrent
  // auto-positions, 1% risk per trade, and a $10 daily realized-loss cap.
  const AUTO_CONFIDENCE = 0.75;
  const AUTO_MAX_POSITIONS = 4;
  const AUTO_RISK_PCT = 1.0;
  const AUTO_DAILY_LOSS_CAP_USD = 10;

  async function runAutoScan({ report = false } = {}) {
    const apiKey = process.env.BYBIT_API_KEY;
    const apiSecret = process.env.BYBIT_API_SECRET;
    if (!apiKey || !apiSecret) {
      if (report) await notifyUser('❌ Нет Bybit-ключей.');
      return;
    }
    if (!autoTradeEnabled) {
      if (report) await notifyUser('🔕 Авто-торговля выключена — включи через /autotrade on.');
      return;
    }

    // Respect the daily loss cap — stop entering once realized loss exceeds it.
    if (autoDailyLossUsd <= -AUTO_DAILY_LOSS_CAP_USD) {
      log.guard('autotrade paused', { reason: 'daily loss cap reached', autoDailyLossUsd });
      if (report) await notifyUser(`🛑 Авто-торговля на паузе: дневной убыток ${autoDailyLossUsd.toFixed(2)} USD достиг лимита −$${AUTO_DAILY_LOSS_CAP_USD}.`);
      return;
    }

    // Respect the concurrent-position cap — count ONLY the auto-trader's own
    // positions (the human's manual entries do not block auto-trading).
    const open = await fetchOpenPositions({ apiKey, apiSecret }, WATCH_SYMBOLS);
    const spots = await fetchSpotHoldings({ apiKey, apiSecret });
    const autoOpenCount = open.filter((p) => autoOpenedSymbols.has(p.symbol)).length;
    if (autoOpenCount >= AUTO_MAX_POSITIONS) {
      console.error(`[autotrade] at auto-position cap (${autoOpenCount}/${AUTO_MAX_POSITIONS})`);
      if (report) await notifyUser(`⏸ Авто-вход пропущен: уже открыто ${autoOpenCount} авто-позиций (лимит ${AUTO_MAX_POSITIONS}). Твои ручные позиции не считаются.`);
      return;
    }

    // 1. market + news context.
    const context = await buildMarketContext(marketData);
    let fng = null;
    try {
      const { text: newsText, fng: fngValue } = await gatherNews();
      if (newsText) context.news = newsText;
      fng = fngValue ?? null;
    } catch { /* advisory */ }

    // 1b. Open positions so the scout avoids duplicates and correlated reversals.
    context.openPositions = [
      ...open.map((p) => ({ symbol: p.symbol, side: p.side })),
      ...spots.map((s) => ({ symbol: s.symbol, side: 'LONG' })),
    ];

    // 2. scout ideas.
    const api = getChat();
    const scout = await api.generateIdeas(context);
    const ideaCount = scout.parsed.ok && Array.isArray(scout.parsed.ideas) ? scout.parsed.ideas.length : 0;
    if (!scout.parsed.ok || ideaCount === 0) {
      if (report) await notifyUser(`🔍 Авто-скан: проверено монет ${context.symbols.length}, скаут дал 0 идей — входа нет.`);
      return;
    }

    // 3. precheck + guard each idea (with sentiment) in parallel; pick the best survivors.
    const survivors = [];
    const rejectedCount = [];
    await Promise.all(
      scout.parsed.ideas.map(async (idea) => {
        const pre = precheckIdea(idea, context);
        if (!pre.pass) {
          log.guard('autotrade precheck rejected', { symbol: idea.symbol, side: idea.side, reasons: pre.reasons });
          rejectedCount.push(`${idea.symbol} ${idea.side} (precheck: ${pre.reasons[0]})`);
          return;
        }
        let sentimentText = null;
        try {
          const sent = await fetchMarketSentiment(idea.symbol);
          if (fng && Number.isFinite(fng.value)) {
            sent.fearGreed = fng.value;
            sent.fearGreedClass = fng.classification ?? null;
          }
          sentimentText = formatSentiment(sent);
        } catch { }
        const guard = await api.filterIdea(idea, contextForIdea(context, idea.symbol), { sentiment: sentimentText, news: context.news ?? null });
        if (guard.parsed.ok && guard.parsed.value.verdict === 'APPROVED') {
          const conf = guard.parsed.value.confidence;
          if (conf >= AUTO_CONFIDENCE) {
            survivors.push({ idea, verdict: guard.parsed.value, confidence: conf });
          } else {
            rejectedCount.push(`${idea.symbol} ${idea.side} (качество ${Math.round(conf * 100)}% < 75%)`);
          }
        } else {
          rejectedCount.push(`${idea.symbol} ${idea.side} (гвард отклонил)`);
        }
      }),
    );
    if (survivors.length === 0) {
      console.error(`[autotrade] no setup ≥ ${AUTO_CONFIDENCE}`);
      if (report) {
        const rejTxt = rejectedCount.length ? '\n\nОтклонено: ' + rejectedCount.slice(0, 6).map((s) => escapeHtml(s)).join(', ') + (rejectedCount.length > 6 ? ` +${rejectedCount.length - 6}` : '') : '';
        await notifyUser(`🔍 Авто-скан: проверено монет ${context.symbols.length}, идей ${ideaCount}.\nНет сетапа с качеством ≥ ${Math.round(AUTO_CONFIDENCE * 100)}% — входа нет.${rejTxt}`);
      }
      return;
    }
    // Best by confidence.
    survivors.sort((a, b) => b.confidence - a.confidence);
    const pick = survivors[0];

    // 4. size with 1% risk.
    const snapForIdea = context.symbols.find((s) => s.symbol === pick.idea.symbol);
    const instrument = snapForIdea?.instrument ?? null;
    if (!instrument || !Number.isFinite(instrument.qtyStep)) {
      if (report) await notifyUser('⚠️ Нет грида инструмента для выбранного сетапа — пропуск.');
      return;
    }
    const wallet = await fetchWalletBalance(apiKey, apiSecret);
    if (!Number.isFinite(wallet.equityUsd) || wallet.equityUsd <= 0) {
      if (report) await notifyUser('⚠️ Не удалось прочитать баланс — пропуск.');
      return;
    }
    const sizing = sizePosition({ idea: pick.idea, instrument, wallet, riskPct: AUTO_RISK_PCT });
    if (!sizing.approved) {
      log.guard('autotrade size rejected', { symbol: pick.idea.symbol, reason: sizing.reason });
      if (report) await notifyUser(`⚠️ Размер отклонён риск-движком: ${sizing.reason}`);
      return;
    }

    // 5. Re-check live price drift before unattended entry.
    const liveNow = await getCurrentPrice(pick.idea.symbol);
    const { slippagePct, refreshPct } = loadApproveThresholds();
    const gate = shouldSkipAutoEntry({ idea: pick.idea, live: liveNow.lastPrice, slippagePct, refreshPct });
    if (gate.skip) {
      log.guard('autotrade entry skipped', { symbol: pick.idea.symbol, reason: gate.reason });
      if (report) await notifyUser(`⏸ Авто-вход пропущен: ${gate.reason} (${escapeHtml(pick.idea.symbol)}).`);
      return;
    }

    // 6. place futures market order with SL/TP (futures: set leverage skipped in PM).
    const side = pick.idea.side === 'LONG' ? 'Buy' : 'Sell';
    const order = await placeMarketOrder(
      { apiKey, apiSecret },
      {
        symbol: pick.idea.symbol,
        side,
        qty: sizing.quantityStr,
        orderLinkId: `auto-${Date.now()}`,
        stopLoss: snapPrice(pick.idea.stopLoss, instrument.tickSize),
        takeProfit: snapPrice(pick.idea.takeProfit, instrument.tickSize),
        slTriggerBy: 'LastPrice',
        tpTriggerBy: 'LastPrice',
      },
    );
    log.execute('autotrade entered', { symbol: pick.idea.symbol, side: pick.idea.side, confidence: pick.confidence, qty: sizing.quantityStr, riskUsd: sizing.riskAmountUsd, orderId: order.orderId });
    // Record that the auto-trader opened this symbol so its cap counts only
    // auto-entries, not the human's manual positions.
    autoOpenedSymbols.add(pick.idea.symbol);
    await persistState();
    const reportMsg = report
      ? `Проверено монет: ${context.symbols.length} · Идей: ${ideaCount} · Выжило сетапов ≥ ${Math.round(AUTO_CONFIDENCE * 100)}%: ${survivors.length}\n\n`
      : '';
    await notifyUser(
      `${reportMsg}🔔 <b>Авто-вход</b>: <code>${escapeHtml(pick.idea.symbol)}</code> ${pick.idea.side} (качество ${Math.round(pick.confidence * 100)}%)\nПочему: ${escapeHtml(String(pick.idea.rationale || 'сильный сетап'))}\nВход: ${pick.idea.entry}, Стоп: ${pick.idea.stopLoss}, Тейк: ${pick.idea.takeProfit}\nРиск: $${sizing.riskAmountUsd.toFixed(2)}\nOrder ID: <code>${order.orderId}</code>`,
    );
  }

  // /autotrade on|off|status
  bot.command('autotrade', async (ctx) => {
    setNotifyChatId(ctx.chat?.id);
    const arg = String(ctx.match ?? '').trim().toLowerCase();
    if (arg === 'on') {
      autoTradeEnabled = true;
      await ctx.reply('🔔 Авто-торговля ВКЛЮЧЕНА (качество ≥ 75%, ≤4 авто-позиций, риск 1%, лимит −$10/день). Твои ручные позиции не учитываются в лимите.\n\nЗапускаю первый скан…');
      try {
        await runAutoScan({ report: true });
      } catch (error) {
        console.error('[autotrade] on-scan error:', error instanceof Error ? `${error.name}: ${error.message}` : String(error));
        await ctx.reply(`❌ Ошибка скана: ${error instanceof Error ? error.message : String(error)}`).catch(() => {});
      }
    } else if (arg === 'off') {
      autoTradeEnabled = false;
      await ctx.reply('🔕 Авто-торговля ВЫКЛЮЧЕНА.');
    } else {
      await ctx.reply(`Авто-торговля сейчас: ${autoTradeEnabled ? '🔔 ВКЛЮЧЕНА' : '🔕 выключена'}\n\nПараметры: качество ≥ 75%, ≤4 авто-позиций (ручные не считаются), риск 1%, дневной лимит −$10.\n\nКоманды: /autotrade on — включить + запустить скан | /autotrade off`);
    }
  });

  // /status — show futures + spot holdings.
  bot.command('status', async (ctx) => {
    setNotifyChatId(ctx.chat?.id);
    try {
      const apiKey = process.env.BYBIT_API_KEY;
      const apiSecret = process.env.BYBIT_API_SECRET;
      if (!apiKey || !apiSecret) { await ctx.reply('Нет Bybit-ключей.'); return; }
      const [futures, spot] = await Promise.all([
        fetchOpenPositions({ apiKey, apiSecret }, WATCH_SYMBOLS),
        fetchSpotHoldings({ apiKey, apiSecret }),
      ]);
      const lines = [];
      for (const p of futures) {
        const arrow = (Number(p.unrealisedPnl) || 0) >= 0 ? '🟢' : '🔴';
        lines.push(`${arrow} <b>${escapeHtml(p.symbol)}</b> [фьюч] ${p.side} | вход ${p.avgPrice} → ${p.markPrice} | PnL $${(Number(p.unrealisedPnl) || 0).toFixed(2)} | SL ${p.stopLoss ?? '-'} | TP ${p.takeProfit ?? '-'} | ${p.leverage}x`);
      }
      for (const s of spot) {
        lines.push(`💠 <b>${escapeHtml(s.symbol)}</b> [спот] | кол-во ${s.size} | ≈$${(s.size * (Number(s.avgPrice) || 0)).toFixed(2)}`);
      }
      if (lines.length === 0) { await ctx.reply('Нет открытых позиций и спот-холдов.'); return; }
      await ctx.reply('📊 <b>Портфель:</b>\n\n' + lines.join('\n'), { parse_mode: 'HTML' });
    } catch (error) {
      console.error('[status] error:', error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      await ctx.reply(`❌ Ошибка статуса: ${error instanceof Error ? error.message : String(error)}`).catch(() => {});
    }
  });

  // /orders — one card per open position, each with a Close button. Tapping
  // Close routes through the existing doexit handler (proposal → confirm/close).
  bot.command('orders', async (ctx) => {
    setNotifyChatId(ctx.chat?.id);
    try {
      const apiKey = process.env.BYBIT_API_KEY;
      const apiSecret = process.env.BYBIT_API_SECRET;
      if (!apiKey || !apiSecret) { await ctx.reply('Нет Bybit-ключей.'); return; }
      const [futures, spot] = await Promise.all([
        fetchOpenPositions({ apiKey, apiSecret }, WATCH_SYMBOLS),
        fetchSpotHoldings({ apiKey, apiSecret }),
      ]);

      const all = [
        ...futures.map((p) => ({ ...p, kind: 'linear' })),
        ...spot.map((s) => ({ ...s, kind: 'spot' })),
      ];
      if (all.length === 0) { await ctx.reply('Нет открытых позиций и спот-холдов.'); return; }

      for (const pos of all) {
        const pid = `ord-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        exitProposals.set(pid, { symbol: pos.symbol, side: pos.side, kind: pos.kind, reason: 'manual /orders close' });

        let card;
        if (pos.kind === 'linear') {
          const pnl = Number(pos.unrealisedPnl) || 0;
          const arrow = pnl >= 0 ? '🟢' : '🔴';
          const sideTxt = pos.side === 'LONG' ? '📈 LONG' : '📉 SHORT';
          card = [
            `${arrow} <b>${escapeHtml(pos.symbol)}</b> — ${sideTxt} [фьюч]`,
            `Размер: <code>${escapeHtml(String(pos.size))}</code>`,
            `Вход: <code>${pos.avgPrice}</code> → Сейчас: <code>${pos.markPrice}</code>`,
            `PnL: <code>${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}</code>`,
            `Стоп: <code>${pos.stopLoss ?? '-'}</code> | Тейк: <code>${pos.takeProfit ?? '-'}</code>`,
          ].join('\n');
        } else {
          const usd = pos.size * (Number(pos.avgPrice) || 0);
          card = [
            `💠 <b>${escapeHtml(pos.symbol)}</b> — спот-холд`,
            `Кол-во: <code>${escapeHtml(String(pos.size))}</code>`,
            `≈$${usd.toFixed(2)}`,
          ].join('\n');
        }

        const keyboard = new InlineKeyboard().text('❌ Закрыть', `doexit:${pid}`);
        await ctx.reply(card, { parse_mode: 'HTML', reply_markup: keyboard });
      }
    } catch (error) {
      console.error('[orders] error:', error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      await ctx.reply(`❌ Ошибка: ${error instanceof Error ? error.message : String(error)}`).catch(() => {});
    }
  });

  /**
   * Fast stop-check pass: code-first gating. The LLM is consulted only when a
   * position is in meaningful loss; auto-close requires agreement of code AND
   * model. Everything else is proposed via buttons.
   *
   * @param {boolean} notify
   * @param {{ forceSummary?: boolean, background?: boolean }} [opts]
   */
  async function runStopcheckPass(notify = true, { forceSummary = false, background = false } = {}) {
    const apiKey = process.env.BYBIT_API_KEY;
    const apiSecret = process.env.BYBIT_API_SECRET;
    if (!apiKey || !apiSecret) return;

    const [futures, spot] = await Promise.all([
      fetchOpenPositions({ apiKey, apiSecret }, WATCH_SYMBOLS),
      fetchSpotHoldings({ apiKey, apiSecret }),
    ]);
    const positions = [
      ...futures.map((p) => ({ ...p, kind: 'linear' })),
      ...spot.map((s) => ({ ...s, kind: 'spot' })),
    ];
    if (positions.length === 0) {
      if (forceSummary) await notifyUser('🛑 Stop-check: нет открытых позиций.');
      else if (notify && !background) console.error('[stopcheck] no open positions');
      return;
    }

    const results = [];
    /** @type {Array<{pos: any, lossMeaningful: boolean, trendAgainst: boolean, compact: Array<{o,h,l,c,v}>}>} */
    const gated = [];

    const HARVEST_ARM_USD = Number(process.env.HARVEST_ARM_USD ?? 1.5);
    const HARVEST_RETRACE_PCT = Number(process.env.HARVEST_RETRACE_PCT ?? 50);
    const TIME_STOP_HOURS = Number(process.env.TIME_STOP_HOURS ?? 24);

    // Phase 1: deterministic locks (harvest + time-stop) BEFORE LLM gate.
    for (const pos of positions) {
      try {
        const live = await getCurrentPrice(pos.symbol);
        const markPrice = live.lastPrice;
        const pnlUsd = Number(pos.unrealisedPnl) || 0;
        const key = `${pos.kind}:${pos.symbol}`;

        // T-1: harvest retrace lock
        if (pos.kind === 'linear') {
          const peakPnlUsd = positionsPeak.get(key) ?? 0;
          const harvest = harvestDecision({ pnlUsd, peakPnlUsd, armUsd: HARVEST_ARM_USD, retracePct: HARVEST_RETRACE_PCT });
          if (harvest.peak > (positionsPeak.get(key) ?? 0)) {
            positionsPeak.set(key, harvest.peak);
          }
          if (harvest.close) {
            try {
              const order = await closePosition({ symbol: pos.symbol, side: pos.side, kind: pos.kind, size: pos.size });
              log.execute('harvest closed', { symbol: pos.symbol, pnlUsd, peakPnlUsd: harvest.peak, orderId: order.orderId });
              results.push({ pos, action: 'HARVEST_CLOSED', reason: `harvest retrace lock (peak $${harvest.peak.toFixed(2)})` });
              if (notifyChatId) {
                await notifyUser(`🔒 <b>Зафиксировал</b> <code>${escapeHtml(pos.symbol)}</code> ${pos.side}: +$${pnlUsd.toFixed(2)} с пика +$${harvest.peak.toFixed(2)}`);
              }
              positionsPeak.delete(key);
              await persistState();
            } catch (closeErr) {
              log.execute('harvest close failed', { symbol: pos.symbol, error: closeErr instanceof Error ? closeErr.message : String(closeErr) });
              results.push({ pos, action: 'HARVEST_CLOSE_FAILED', reason: closeErr instanceof Error ? closeErr.message : String(closeErr) });
            }
            continue;
          }
        }

        // T-4: time-stop
        if (pos.kind === 'linear' && TIME_STOP_HOURS > 0) {
          const prev = prevPositions.get(key);
          const firstSeenAt = prev?.firstSeenAt ? new Date(prev.firstSeenAt).getTime() : null;
          const ageHours = firstSeenAt ? (Date.now() - firstSeenAt) / 3600000 : 0;
          const peakPnlUsd = positionsPeak.get(key) ?? 0;
          if (ageHours > TIME_STOP_HOURS && pnlUsd < HARVEST_ARM_USD && peakPnlUsd < HARVEST_ARM_USD) {
            try {
              const order = await closePosition({ symbol: pos.symbol, side: pos.side, kind: pos.kind, size: pos.size });
              log.execute('time-stop closed', { symbol: pos.symbol, pnlUsd, ageHours, orderId: order.orderId });
              results.push({ pos, action: 'TIME_STOP_CLOSED', reason: `time-stop after ${Math.round(ageHours)}h, no profit` });
              if (notifyChatId) {
                await notifyUser(`⏰ <b>Time-stop</b> <code>${escapeHtml(pos.symbol)}</code> ${pos.side}: позиции ${Math.round(ageHours)}ч, плюс не состоялся.`);
              }
              positionsPeak.delete(key);
              await persistState();
            } catch (closeErr) {
              log.execute('time-stop close failed', { symbol: pos.symbol, error: closeErr instanceof Error ? closeErr.message : String(closeErr) });
              results.push({ pos, action: 'TIME_STOP_CLOSE_FAILED', reason: closeErr instanceof Error ? closeErr.message : String(closeErr) });
            }
            continue;
          }
        }

        const lossBig = pnlUsd <= -2;
        const lossPct = pos.avgPrice > 0 ? Math.abs(pnlUsd) / (pos.avgPrice * pos.size) * 100 : 0;
        const lossMeaningful = lossBig || lossPct >= 1;
        if (!shouldConsultStopcheck({ lossMeaningful })) {
          results.push({ pos, action: 'HOLD', reason: 'loss not meaningful — LLM not consulted' });
          continue;
        }
        const candles = await fetchKlines(pos.symbol, { interval: '60', limit: 30 });
        const compact = candles.map((k) => ({ o: k[0], h: k[1], l: k[2], c: k[3], v: k[4] ?? 0 }));
        const trend = computeBtcBlock(compact);
        const trendAgainst = isTrendAgainst(pos.side, trend?.bias);
        gated.push({ pos: { ...pos, markPrice }, lossMeaningful, trendAgainst, compact });
      } catch (error) {
        log.market('stopcheck pass error', { symbol: pos.symbol, error: error instanceof Error ? error.message : String(error) });
        results.push({ pos, action: 'ERROR', reason: error instanceof Error ? error.message : String(error) });
      }
    }

    if (gated.length === 0) {
      if (notifyChatId && forceSummary) {
        const lines = results.map((r) => `${r.action === 'HOLD' ? '🟢' : '⚠️'} <b>${escapeHtml(r.pos.symbol)}</b> ${r.pos.side} — ${r.action}\n  <i>${escapeHtml(r.reason)}</i>`);
        await notifyUser('🛑 <b>Stop-check результат:</b>\n\n' + lines.join('\n') + '\n\nВсе позиции держим.');
      }
      return;
    }

    // Shared data: fetched once only when at least one position passed the gate.
    let newsText = '';
    try {
      const news = await gatherNews();
      newsText = news.text ?? '';
    } catch { /* advisory */ }
    let btc = null;
    try {
      const btcCandles = await fetchKlines('BTCUSDT', { interval: '60', limit: 30 });
      btc = computeBtcBlock(btcCandles.map((k) => ({ o: k[0], h: k[1], l: k[2], c: k[3], v: k[4] ?? 0 })));
    } catch { /* advisory */ }

    // Phase 2: LLM for gated positions.
    let closeCount = 0;
    for (const item of gated) {
      const pos = item.pos;
      try {
        const atr = computeATR(item.compact, 14);
        const market = {
          symbol: pos.symbol,
          markPrice: pos.markPrice,
          bid: null,
          ask: null,
          kind: pos.kind,
          atr14h: Number.isFinite(atr) ? atr : null,
          trend: computeBtcBlock(item.compact),
          btc,
          candles: item.compact,
        };
        const prompt = buildStopcheckPrompt({ position: pos, market, newsText });
        const content = await getChat()._completeGuard(prompt);
        const parsed = parseStopcheckResponse(content);
        if (!parsed.ok) {
          log.guard('stopcheck parse error', { symbol: pos.symbol, issues: parsed.issues });
          results.push({ pos, action: 'PARSE_ERROR', reason: parsed.issues.join('; ') });
          continue;
        }
        const decision = parsed.value;
        log.guard('stopcheck verdict', { symbol: pos.symbol, kind: pos.kind, side: pos.side, action: decision.action, reason: decision.reason });

        const action = decideStopcheckAction({ llmAction: decision.action, lossMeaningful: item.lossMeaningful, trendAgainst: item.trendAgainst });
        if (action === 'AUTO_CLOSE') {
          closeCount++;
          try {
            const order = await closePosition({ symbol: pos.symbol, side: pos.side, kind: pos.kind, size: pos.size });
            log.execute('stopcheck auto-closed', { symbol: pos.symbol, side: pos.side, kind: pos.kind, reason: decision.reason, confidence: decision.confidence, lossMeaningful: item.lossMeaningful, trendBias: item.trendAgainst ? 'against' : 'neutral', orderId: order.orderId });
            results.push({ pos, action: 'AUTO_CLOSED', reason: decision.reason });
            if (notifyChatId) {
              await notifyUser(`🛑 <b>Авто-закрыл</b> <code>${escapeHtml(pos.symbol)}</code> ${pos.side}:\nКод: убыток + тренд против, модель: CLOSE\n${escapeHtml(decision.reason)}`);
            }
          } catch (closeErr) {
            log.execute('stopcheck auto-close failed', { symbol: pos.symbol, error: closeErr instanceof Error ? closeErr.message : String(closeErr) });
            results.push({ pos, action: 'CLOSE', reason: `авто-закрытие не удалось: ${closeErr instanceof Error ? closeErr.message : String(closeErr)}` });
          }
        } else if (action === 'PROPOSE_CLOSE') {
          closeCount++;
          results.push({ pos, action: 'CLOSE', reason: decision.reason });
          if (notifyChatId) {
            const pid = `exit-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
            exitProposals.set(pid, { symbol: pos.symbol, side: pos.side, kind: pos.kind, reason: decision.reason });
            const keyboard = new InlineKeyboard()
              .text('✅ Закрыть', `doexit:${pid}`)
              .text('❌ Оставить', `keepexit:${pid}`);
            await bot.api.sendMessage(
              notifyChatId,
              [
                `🛑 <b>Stop-check: предлагаю закрыть</b> <code>${escapeHtml(pos.symbol)}</code> ${pos.side} (${pos.kind === 'spot' ? 'спот' : 'фьючерс'})`,
                `Причина: ${escapeHtml(decision.reason)}`,
                `Цена: <code>${pos.markPrice}</code>`,
                '',
                'Закрыть?',
              ].join('\n'),
              { parse_mode: 'HTML', reply_markup: keyboard },
            );
          }
        } else {
          results.push({ pos, action: 'HOLD', reason: decision.reason });
        }
      } catch (error) {
        log.market('stopcheck pass error', { symbol: pos.symbol, error: error instanceof Error ? error.message : String(error) });
        results.push({ pos, action: 'ERROR', reason: error instanceof Error ? error.message : String(error) });
      }
    }

    // Always send a summary on manual /stopcheck; on the background tick only
    // send when something is actionable (CLOSE) to avoid notification spam.
    if (notifyChatId && (forceSummary || closeCount > 0)) {
      const icon = (a) => a === 'CLOSE' || a === 'AUTO_CLOSED' ? '🛑' : a === 'HOLD' ? '🟢' : '⚠️';
      const lines = results.map((r) => {
        const pnl = (Number(r.pos.unrealisedPnl) || 0);
        const pnlTxt = Number.isFinite(pnl) && r.pos.kind === 'linear' ? ` (PnL $${pnl.toFixed(2)})` : '';
        return `${icon(r.action)} <b>${escapeHtml(r.pos.symbol)}</b> ${r.pos.side} — ${r.action}${pnlTxt}\n  <i>${escapeHtml(r.reason)}</i>`;
      });
      await notifyUser(
        '🛑 <b>Stop-check результат:</b>\n\n' + lines.join('\n') + '\n\n' + (closeCount > 0 ? 'Нажми «Закрыть» выше для исполнения.' : 'Все позиции держим.'),
      );
    }
  }

  // /stopcheck — run the fast loss/trend check immediately (always replies).
  bot.command('stopcheck', async (ctx) => {
    setNotifyChatId(ctx.chat?.id);
    await notifyUser('🛑 <b>Stop-check</b> запущен — проверяю позиции на убыточность/тенденцию…');
    try {
      await runStopcheckPass(true, { forceSummary: true });
    } catch (error) {
      console.error('[stopcheck] command error:', error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      await ctx.reply(`❌ Ошибка stop-check: ${error instanceof Error ? error.message : String(error)}`).catch(() => {});
    }
  });

  // /monitor — run one monitor pass immediately.
  bot.command('monitor', async (ctx) => {
    setNotifyChatId(ctx.chat?.id);
    try {
      await runMonitorPass(true, { forceSummary: true });
    } catch (error) {
      console.error('[monitor] command error:', error instanceof Error ? `${error.name}: ${error.message}` : String(error));
      await ctx.reply(`❌ Ошибка мониторинга: ${error instanceof Error ? error.message : String(error)}`).catch(() => {});
    }
  });

  // /rules — show pending rule proposals or archive them after human review.
  bot.command('rules', async (ctx) => {
    setNotifyChatId(ctx.chat?.id);
    const arg = String(ctx.match ?? '').trim().toLowerCase();
    const pendingFile = 'data/telegram/rules.pending.md';
    if (arg === 'applied') {
      try {
        const suffix = new Date().toISOString().slice(0, 10);
        await rename(pendingFile, `data/telegram/rules.applied-${suffix}.md`);
        await writeFile(pendingFile, '', 'utf8');
        await ctx.reply(`✅ Правила зафиксированы как rules.applied-${suffix}.md. Новый pending-файл начат.`);
      } catch (error) {
        await ctx.reply(`❌ Не удалось зафиксировать правила: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    try {
      const text = await readFile(pendingFile, 'utf8');
      const lines = text.split('\n').filter((l) => l.trim() !== '').slice(-20);
      if (lines.length === 0) { await ctx.reply('📭 Правил в pending-файле пока нет.'); return; }
      await ctx.reply('📝 <b>Последние pending-правила:</b>\n\n' + lines.join('\n'), { parse_mode: 'HTML' });
    } catch {
      await ctx.reply('📭 Правил в pending-файле пока нет.');
    }
  });

  bot.command('perf', async (ctx) => {
    setNotifyChatId(ctx.chat?.id);
    const apiKey = process.env.BYBIT_API_KEY;
    const apiSecret = process.env.BYBIT_API_SECRET;
    if (!apiKey || !apiSecret) {
      await ctx.reply('❌ Нет Bybit-ключей.');
      return;
    }
    const end = Date.now();
    const start = end - 7 * 24 * 60 * 60 * 1000;
    const rows = await fetchClosedPnlHistory({ apiKey, apiSecret }, { startTime: start, endTime: end, limit: 100 });
    if (rows.length === 0) {
      await ctx.reply('📊 Нет закрытых сделок за 7 дней.');
      return;
    }
    const realized = rows.reduce((s, r) => s + (r.realizedPnlUsd ?? 0), 0);
    const wins = rows.filter((r) => (r.realizedPnlUsd ?? 0) > 0);
    const losses = rows.filter((r) => (r.realizedPnlUsd ?? 0) < 0);
    const scratch = rows.filter((r) => Math.abs(r.realizedPnlUsd ?? 0) < 0.5);
    const winRate = rows.length ? ((wins.length / rows.length) * 100).toFixed(1) : '0';
    const scratchRate = rows.length ? ((scratch.length / rows.length) * 100).toFixed(1) : '0';
    const avgWin = wins.length ? (wins.reduce((s, r) => s + (r.realizedPnlUsd ?? 0), 0) / wins.length).toFixed(2) : '0';
    const avgLoss = losses.length ? (losses.reduce((s, r) => s + (r.realizedPnlUsd ?? 0), 0) / losses.length).toFixed(2) : '0';
    // T-5: give-back block from positionsPeak state
    const peaks = Object.values(state.positionsPeak ?? {});
    const totalMfe = peaks.reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
    const giveBackPct = totalMfe > 0 ? (((totalMfe - realized) / totalMfe) * 100).toFixed(1) : '0';
    const lines = [
      '📊 <b>Perf за 7д</b>',
      `Сделок: ${rows.length} · realized PnL $${realized.toFixed(2)} (win rate ${winRate}%)`,
      `Avg win $${avgWin} / avg loss $${avgLoss}`,
      ``,
      `🔒 <b>Give-back:</b> MFE $${totalMfe.toFixed(2)} vs realized $${realized.toFixed(2)} (${giveBackPct}% отдано)`,
      `Scratch-rate: ${scratchRate}% (|pnl| < $0.5)`,
    ];
    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  // Reusable close: close a position (futures or spot) by market. Returns the
  // order result, or throws. Used by both manual /doexit and auto-close.
  async function closePosition({ symbol, side, kind, size }) {
    const apiKey = process.env.BYBIT_API_KEY;
    const apiSecret = process.env.BYBIT_API_SECRET;
    const orderLinkId = `close-${Date.now()}`;
    if (kind === 'spot') {
      const qtyPrec = await fetchSpotQtyPrecision(symbol);
      const closeQty = qtyPrec !== null ? snapSpotQty(size, qtyPrec) : String(size);
      return placeSpotMarketOrder({ apiKey, apiSecret }, { symbol, side: 'Sell', qty: closeQty, orderLinkId });
    }
    const closeSide = side === 'LONG' ? 'Sell' : 'Buy';
    return placeMarketOrder({ apiKey, apiSecret }, { symbol, side: closeSide, qty: String(size), orderLinkId, stopLoss: undefined, takeProfit: undefined });
  }

  // Exit confirm callbacks
  bot.callbackQuery(/^doexit:(.+)$/, async (ctx) => {
    const pid = ctx.match[1];
    const prop = exitProposals.get(pid);
    if (!prop) { await ctx.answerCallbackQuery({ text: 'Устарело' }).catch(() => {}); return; }
    exitProposals.delete(pid);
    // Acknowledge the tap immediately: the close path below performs slow
    // exchange calls, and an answer that throws must never reach middleware.
    await ctx.answerCallbackQuery({ text: 'Закрываю…' }).catch(() => {});
    // Place a closing market order in the opposite direction (or spot sell).
    try {
      const apiKey = process.env.BYBIT_API_KEY;
      const apiSecret = process.env.BYBIT_API_SECRET;
      // Read size from the matching holding/position.
      const positions = await fetchOpenPositions({ apiKey, apiSecret }, WATCH_SYMBOLS);
      const spot = await fetchSpotHoldings({ apiKey, apiSecret });
      const pos = positions.find((p) => p.symbol === prop.symbol);
      const spotPos = spot.find((s) => s.symbol === prop.symbol);

      const orderLinkId = `close-${Date.now()}`;
      let order;
      if (prop.kind === 'spot' || (!pos && spotPos)) {
        // Spot close = market sell of the full base-coin balance.
        const target = spotPos ?? { size: prop.size ?? 0 };
        if (!target.size || Number(target.size) <= 0) { await ctx.reply('Спот-позиция уже закрыта (пустой баланс).'); return; }
        // Snap quantity to the spot basePrecision (avoids 170137).
        const qtyPrec = await fetchSpotQtyPrecision(prop.symbol);
        const closeQty = qtyPrec !== null ? snapSpotQty(target.size, qtyPrec) : String(target.size);
        order = await placeSpotMarketOrder(
          { apiKey, apiSecret },
          { symbol: prop.symbol, side: 'Sell', qty: closeQty, orderLinkId },
        );
      } else {
        if (!pos) { await ctx.reply('Позиция уже закрыта.'); return; }
        const closeSide = pos.side === 'LONG' ? 'Sell' : 'Buy';
        order = await placeMarketOrder(
          { apiKey, apiSecret },
          { symbol: pos.symbol, side: closeSide, qty: String(pos.size), orderLinkId, stopLoss: undefined, takeProfit: undefined },
        );
      }

      log.execute('exit executed', { symbol: prop.symbol, side: prop.side, kind: prop.kind, orderId: order.orderId });
      // Post-close reflection (fires once per closed symbol).
      const closed = pos ?? spotPos;
      if (closed) {
        const exitCause = inferExitCause({
          side: prop.side,
          exitPrice: closed.markPrice ?? closed.avgPrice ?? 0,
          stopLoss: closed.stopLoss ?? null,
          takeProfit: closed.takeProfit ?? null,
        });
        await reflectClosedTrade({
          symbol: prop.symbol,
          side: prop.side,
          entry: closed.avgPrice ?? 0,
          exit: closed.markPrice ?? closed.avgPrice ?? 0,
          pnlUsd: closed.unrealisedPnl ?? 0,
          reason: `manual exit on proposal: ${prop.reason} (cause: ${exitCause})`,
          closedId: order.orderId,
          exitCause,
        });
      }
      await ctx.answerCallbackQuery({ text: 'Закрываю' });
      await ctx.reply(`✅ Отправлен ордер на закрытие ${escapeHtml(prop.symbol)} (${prop.side}). Order ID: <code>${escapeHtml(order.orderId)}</code>`, { parse_mode: 'HTML' });
    } catch (error) {
      await ctx.answerCallbackQuery({ text: 'Ошибка' });
      await ctx.reply(`❌ Ошибка закрытия: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  bot.callbackQuery(/^keepexit:(.+)$/, async (ctx) => {
    exitProposals.delete(ctx.match[1]);
    await ctx.answerCallbackQuery({ text: 'Оставлено' });
  });

  // Fallback for unmatched text messages. Registered LAST so it never shadows
  // the real command/callback handlers above.
  bot.on('message', async (ctx) => {
    const text = ctx.message?.text ?? '';
    if (text.startsWith('/')) return;
    await ctx.reply('Неизвестная команда.\n/trade — анализ\n/status — портфель\n/orders — карточки позиций с закрытием\n/monitor — проверить позиции\n/stopcheck — проверка убыточности\n/autotrade on|off — авто-вход без апрува');
  });

  // MVP-2: background monitor loop (15 minutes). MUST be registered BEFORE
  // `bot.start()` — that call long-polls and never resolves, so anything after
  // it would never run.
  const intervalMs = Number(process.env.MONITOR_INTERVAL_MS ?? 15 * 60 * 1000);
  let monitoring = false;
  const monitorLoop = async () => {
    if (monitoring) { console.error('[monitor] skipping — previous pass still running'); return; }
    monitoring = true;
    console.error(`[monitor] tick at ${new Date().toISOString()}`);
    try {
      await runMonitorPass(true, { background: true });
    } catch (e) {
      console.error('[monitor] error:', e instanceof Error ? e.message : String(e));
    } finally {
      monitoring = false;
    }
  };
  const monitorTimer = setInterval(monitorLoop, intervalMs);
  console.error(`[monitor] started, interval ${Math.round(intervalMs / 60000)} min`);

  // Faster stop-check loop (default 5 min). Only looks at loss/trend and only
  // proposes closes; guarded against overlapping runs.
  const stopcheckMs = Number(process.env.STOPCHECK_INTERVAL_MS ?? 5 * 60 * 1000);
  let stopchecking = false;
  const stopcheckLoop = async () => {
    if (stopchecking) { console.error('[stopcheck] skipping — previous pass still running'); return; }
    stopchecking = true;
    console.error(`[stopcheck] tick at ${new Date().toISOString()}`);
    try {
      await runStopcheckPass(true, { background: true });
    } catch (e) {
      console.error('[stopcheck] error:', e instanceof Error ? e.message : String(e));
    } finally {
      stopchecking = false;
    }
  };
  const stopcheckTimer = setInterval(stopcheckLoop, stopcheckMs);
  console.error(`[stopcheck] started, interval ${Math.round(stopcheckMs / 60000)} min`);

  // Auto-trader scan loop (default 30 min). Only runs when autoTradeEnabled;
  // guarded against overlaps.
  const autotradeMs = Number(process.env.AUTOTRADE_INTERVAL_MS ?? 30 * 60 * 1000);
  let autotrading = false;
  const autotradeLoop = async () => {
    if (!autoTradeEnabled) return;
    if (autotrading) { console.error('[autotrade] skipping — previous scan still running'); return; }
    autotrading = true;
    console.error(`[autotrade] scan at ${new Date().toISOString()}`);
    try {
      await runAutoScan();
    } catch (e) {
      console.error('[autotrade] error:', e instanceof Error ? e.message : String(e));
    } finally {
      autotrading = false;
    }
  };
  const autotradeTimer = setInterval(autotradeLoop, autotradeMs);
  console.error(`[autotrade] scan loop started, interval ${Math.round(autotradeMs / 60000)} min (enabled: ${autoTradeEnabled ? 'yes' : 'no'})`);

  // A handler error must NEVER kill the process: one failed answerCallbackQuery
  // (e.g. an expired button) crashed the whole bot on 2026-10-14 and stopped
  // all position monitoring. Log and keep running.
  bot.catch((err) => {
    const e = (err && /** @type {any} */ (err).error) ?? err;
    console.error('[telegram] middleware error (swallowed):', e instanceof Error ? `${e.name}: ${e.message}` : String(e));
  });

  try {
    // dropPendingUpdates ensures a stale polling offset from a previous process
    // never blocks new messages after a restart.
    await bot.start({ drop_pending_updates: true });
    console.error('[telegram] bot started (long polling)');
  } catch (error) {
    console.error('[telegram] failed to start:', error instanceof Error ? `${error.name}: ${error.message}` : String(error));
    process.exit(1);
  }
}

// Only auto-start when this file is the entry point, so tests can import
// helpers (e.g. contextForIdea) without spawning the bot.
const isEntryPoint = resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1] ?? '');
if (isEntryPoint) {
  main();
}

