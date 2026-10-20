# ТЗ: NEXT MVP — scout-v4 + guard-v2 + monitor-v2 + reflect-v2 + observability

**Статус:** черновик на утверждении у владельца системы. Ничего не применено.
**Исполнитель:** модель-разработчик (Kimi), работает строго по этому документу.
**Состав:** Часть 1 — Scout (S-1…S-6), Часть 2 — Guard (G-1…G-8), Часть 3 — Monitor (M-1…M-5), Часть 4 — Reflector (R-1…R-4), Часть 5 — Наблюдаемость и shadow-валидация порога (P-1…P-3), Часть 6 — Защита открытой прибыли (L-1…L-2), Часть 7 — Harvest-режим для малого депозита (T-1…T-5). Лимиты автотрейда и JSON-контракты идей/вердиктов **не меняются** (контракты monitor/stopcheck/reflection меняются — см. M-3/M-4/R-3).
**Корень репозитория:** `tradingbot/`. Все пути ниже — относительно него, чтобы исполнитель ничего не искал по проекту.
**Порядок применения:** сначала Часть 1 целиком, затем Часть 2 (G-8 дополняет S-1 и S-4 — применять после них), затем Часть 3 (использует `computeBtcBlock` из G-2 и свечной формат из S-2), затем Части 4–7 (независимы; Части 6–7 используют персистентность из R-2).

---

## 0. Контекст для исполнителя

### Файлы, которые разрешено менять
| Файл | Что там | Правки |
|---|---|---|
| `src/telegram/ideas.mjs` | Промпт Scout (`SCOUT_SYSTEM_PROMPT`), парсер `parseScoutResponse`, валидатор `ideaIssues`, `buildScoutPrompt` | S-1, S-3, S-4, G-8 |
| `src/telegram/deepseek-client.mjs` | `generateIdeas(context)` — точка вызова Scout | S-1 |
| `src/telegram/bot.mjs` | `buildMarketContext` (≈61–90), `contextForIdea` (≈173–175), поток `/trade` (≈320–435), `runAutoScan` (≈1185–1318), `runMonitorPass` (≈969–1183), `runStopcheckPass` (≈1425–1532), `decideEntryMode` (≈216–221), `loadApproveThresholds` (≈187–201), циклы monitor/stopcheck (≈1644–1683) | S-2, G-1, G-2, G-4, G-6, G-7, G-8, M-1, M-2, M-5 |
| `src/telegram/risk-filter.mjs` | Промпт гварда (`GUARD_SYSTEM_PROMPT`), `parseGuardResponse`, `buildGuardPrompt` | G-1, G-3, G-5, G-6, G-7 |
| `src/telegram/market-summary.mjs` | **Новый чистый модуль**: `avgRange14h`, `emaLast`, `computeBtcBlock` (выносится из bot.mjs ради тестируемости; computeBtcBlock универсален — используется и для тренда любого символа в Части 3) | S-2, G-2, M-2 |
| `src/telegram/monitor.mjs` | Промпт монитора, `parseMonitorResponse`, `buildMonitorPrompt`, `createMonitor` | M-3, M-4 |
| `src/telegram/stopcheck.mjs` | Промпт stopcheck, `parseStopcheckResponse`, `buildStopcheckPrompt` | M-1, M-4 |
| `src/telegram/reflect.mjs` | Промпт рефлектора, `createReflector`, `appendReflection` | R-1, R-3 |
| `src/telegram/execute.mjs` | `fetchOpenPositions` (≈394) и прочие Bybit-helpers — сюда добавляется `fetchRecentClosedPnl` | R-1 |
| `src/telegram/state.mjs` | **Новый модуль**: атомарная персистентность состояния процесса (`loadState`/`saveState`) | R-2 |
| `src/telegram/shadow.mjs` | **Новый модуль**: shadow-трекер гипотетических входов (`appendShadow`, `resolveShadowOutcomes`, `shadowBandReport`) | P-2 |
| `data/telegram/shadow.jsonl` | **Новый data-файл**: гипотетические входы и их исходы (создаётся модулем) | P-2 |
| `test/telegram-reflect.test.mjs` | **Новый файл** с unit-тестами Reflector | R-1…R-4 |
| `test/telegram-shadow.test.mjs` | **Новый файл** с unit-тестами shadow-трекера | P-2 |
| `src/telegram/trailing.mjs` | Чистый детерминированный трейлинг — сюда добавляется `applyProfitLock` (НОВЫЙ экспорт; существующие функции не меняются) | L-1 |
| `test/telegram-profitlock.test.mjs` | **Новый файл** с unit-тестами защиты прибыли | L-1, L-2 |
| `test/telegram-ideas.test.mjs` | **Новый файл** с unit-тестами Scout | S-1…S-4, G-8 |
| `test/telegram-guard.test.mjs` | **Новый файл** с unit-тестами Guard | G-1…G-8 |
| `test/telegram-monitor.test.mjs` | **Новый файл** с unit-тестами Monitor/stopcheck | M-1…M-5 |

`src/telegram/sentiment.mjs` НЕ меняется (G-4 правит только call-site в bot.mjs).

### Стиль и инварианты
- ESM `.mjs`, JSDoc-типы, без новых npm-зависимостей. Тесты: `node --test` (см. существующие `test/*.test.mjs`).
- **JSON-контракт идей не меняется**: `{"ideas":[{symbol,side,entry,stopLoss,takeProfit,rationale}]}`.
- Существующие экспорты не ломаются: `parseScoutResponse(raw)` сохраняет сигнатуру и семантику; новая логика — **новым экспортом**.
- Семантика fail-closed сохраняется: невалидное отбрасывается с объяснением причины (issues), валидное проходит.
- `npm test` должен быть зелёным до и после.
- Номера строк в этом ТЗ ориентировочные — искать по именам функций/констант.

### Definition of done
1. Все правки S-1…S-4, G-1…G-8, M-1…M-5, R-1…R-4, P-1…P-3 и L-1…L-2 применены (S-5/S-6 — только по отдельной команде владельца).
2. `test/telegram-ideas.test.mjs`, `test/telegram-guard.test.mjs`, `test/telegram-monitor.test.mjs`, `test/telegram-reflect.test.mjs`, `test/telegram-shadow.test.mjs` и `test/telegram-profitlock.test.mjs` созданы и покрывают случаи из разделов 7.1, G-9, M-6, R-5, P-4 и L-3.
3. `npm test` зелёный.
4. Отчёт исполнителя: список изменённых файлов + вывод `npm test`.

---

## S-1 (P1, критично): Рыночная валидация идей — whitelist символа, близость entry, ширина стопа

**Issue:** Парсер Scout принимает идею с ЛЮБЫМ непустым `symbol` и ЛЮБЫМ `entry`/`stopLoss`. Нигде ниже по коду нет проверки, что символ входит в наблюдаемый список (проверено grep: `WATCH_SYMBOLS.includes` / `includes(idea.symbol)` отсутствуют). Entry может отстоять от рынка на сколько угодно процентов.

**Evidence:** `ideas.mjs`, функция `ideaIssues` — проверяются только типы и LONG/SHORT-геометрия. В `bot.mjs` идея из парсера идёт напрямую в гвард (`api.filterIdea`) и в автотрейд (`pick.idea.symbol` → `placeMarketOrder`, ≈ строка 1298) без проверки принадлежности.

**Trading impact:** Галлюцинированный или искажённый тикер (напр. `PEPEUSDT` вместо `1000PEPEUSDT`) пройдёт парсер, получит вердикт гварда, вычисленный БЕЗ рыночных данных по этому символу, и при включённом автотрейде может привести к ордеру на mainnet по непредусмотренному инструменту. Entry далеко от рынка → SL/TP, привязанные к несуществующим уровням. Исторических случаев не было (0/290 в логе), но это fail-open на идентичности инструмента — один случай на реальных деньгах недопустим.

**Proposed change:**

1) В `ideas.mjs` добавить константы и новый экспорт:

```js
export const ENTRY_MAX_DEVIATION_PCT = 1.5;
export const STOP_MIN_RANGE_MULT = 1.5;

/**
 * Market-aware validation of parsed scout ideas.
 * Drops ideas that reference unknown symbols or violate numeric sanity
 * against the actual market snapshot. Fail-closed per idea.
 *
 * @param {ReadonlyArray<Record<string, any>>} ideas  valid ideas from parseScoutResponse
 * @param {{ symbols?: Array<Record<string, any>> }} market  the SAME context object sent to the model
 * @returns {{ ideas: ReadonlyArray<object>, issues: string[] }}
 */
export function validateIdeasWithMarket(ideas, market) {
  const symbols = Array.isArray(market?.symbols) ? market.symbols : [];
  const bySymbol = new Map();
  for (const s of symbols) {
    if (s && typeof s.symbol === 'string') bySymbol.set(s.symbol, s);
  }
  const kept = [];
  const issues = [];
  ideas.forEach((idea, index) => {
    const at = `ideas[${index}]`;
    const snap = bySymbol.get(idea.symbol);
    if (!snap) {
      issues.push(`${at}.symbol ${JSON.stringify(idea.symbol)} is not in the market context`);
      return;
    }
    const last = snap.lastPrice;
    if (typeof last === 'number' && Number.isFinite(last) && last > 0) {
      const devPct = (Math.abs(idea.entry - last) / last) * 100;
      if (devPct > ENTRY_MAX_DEVIATION_PCT) {
        issues.push(`${at}.entry deviates ${devPct.toFixed(2)}% from lastPrice (max ${ENTRY_MAX_DEVIATION_PCT}%)`);
        return;
      }
    }
    const ar = snap.avgRange14h; // появляется после правки S-2; отсутствует в старых контекстах
    if (typeof ar === 'number' && Number.isFinite(ar) && ar > 0) {
      const stopDist = Math.abs(idea.entry - idea.stopLoss);
      if (stopDist < STOP_MIN_RANGE_MULT * ar) {
        issues.push(`${at}.stopLoss distance ${stopDist} < ${STOP_MIN_RANGE_MULT}x avgRange14h (${ar})`);
        return;
      }
    }
    kept.push(idea);
  });
  return { ideas: Object.freeze(kept), issues };
}
```

2) В `deepseek-client.mjs`, в `generateIdeas(context)`, после `parseScoutResponse`:

```js
async generateIdeas(context) {
  const prompt = buildScoutPrompt(context);
  const content = await complete(model, prompt, temperature);
  const parsed = parseScoutResponse(content);
  if (parsed.ok) {
    const checked = validateIdeasWithMarket(parsed.ideas, context);
    return {
      prompt,
      parsed: { ...parsed, ideas: checked.ideas, issues: [...parsed.issues, ...checked.issues] },
      raw: content,
    };
  }
  return { prompt, parsed, raw: content };
}
```

Импорт `validateIdeasWithMarket` из `./ideas.mjs` добавить в существующий импорт. Контракт возврата `generateIdeas` (`{prompt, parsed, raw}`) не меняется; `bot.mjs` не трогаем — issues уже логируются и показываются пользователю существующим кодом.

**Why it is better:** Идентичность инструмента и числовая здравость идеи проверяются детерминированным кодом, а не добросовестностью LLM. Проверка идёт против ТОГО ЖЕ контекста, который видела модель (а не против константы `WATCH_SYMBOLS`): идея по символу, чей snapshot не удалось загрузить, тоже отбрасывается. Проверка ширины стопа пропускается, если `avgRange14h` отсутствует — обратная совместимость со старыми контекстами.

**Expected benefit:** Невозможность утечки «левого» символа в гвард/исполнение; отсев заведомо битых entry до оплаченного вызова гварда. Метрика: `issues` в логе SCOUT-стадии; в юнит-тестах — 100% отсев фиктивных символов.

**Potential downside:** Если `lastPrice` в снапшоте протух (редкий случай), валидная идея может быть отброшена. Порог 1.5% шире промптного «~1%», так что отсев касается только грубых отклонений. Ложные срабатывания видны в issues и обратимы настройкой константы.

**Validation plan:** юнит-тесты (раздел 7.1, кейсы 4–9). Ручной прогон `/trade` на тестовом ключе с логом issues.

**Approval required:** правка НЕ применена; требуется одобрение владельца.

---

## S-2 (P1): `buildMarketContext` — настоящие 24h high/low + новое поле `avgRange14h`

**Issue:** Поля `high24h`/`low24h` считаются как экстремумы по ВСЕМ загруженным свечам — а загружается до 100 ЧАСОВЫХ свечей (≈4.2 дня). Модель (и гвард) читают имя поля как «24 часа».

**Evidence:** `bot.mjs`, `buildMarketContext`: `getSnapshot(symbol, { interval: '60', candleLimit: 100 })` → `Math.max(...highs)` по всем `candles`. Адаптер `rest-market-data-adapter.mjs` подтверждает: limit=100 часовых свечей. Комментарий над функцией утверждает «24h high/low» — неверно.

**Trading impact:** Гвард использует `high24h`/`low24h` в жёстком правиле anti-chase: «reject, если entry более чем на 8% выше 24h low (LONG)». С 4-дневным «low24h» правило систематически ослаблено: цена может быть на 15%+ выше СУТОЧНОГО минимума и всё равно пройти. Это прямое ослабление риск-контроля.

**Proposed change** (`bot.mjs`, внутри `buildMarketContext`, заменить блок расчёта high/low и добавить поле):

```js
const candles = snap.candles ?? [];
// TRUE 24h extremes: the fetched series is 1h candles, so the last 24 bars.
const last24 = candles.slice(-24);
const highs = last24.map((c) => c.high).filter((v) => typeof v === 'number');
const lows = last24.map((c) => c.low).filter((v) => typeof v === 'number');
// Volatility unit for the scout's stop rule: mean (high - low) of last 14 hourly bars.
const last14 = candles.slice(-14);
const ranges = last14
  .map((c) => (typeof c.high === 'number' && typeof c.low === 'number' ? c.high - c.low : NaN))
  .filter((v) => Number.isFinite(v));
const avgRange14h = ranges.length > 0 ? ranges.reduce((a, b) => a + b, 0) / ranges.length : undefined;

snapshots.push({
  symbol,
  lastPrice: snap.lastPrice,
  bid: snap.bid,
  ask: snap.ask,
  high24h: highs.length ? Math.max(...highs) : undefined,
  low24h: lows.length ? Math.min(...lows) : undefined,
  avgRange14h, // undefined поля JSON.stringify опускает — валидатор S-1 тогда пропускает проверку
  instrument: { /* без изменений */ },
  candles: candles.slice(-30).map((c) => ({ o: c.open, h: c.high, l: c.low, c: c.close, v: c.volume })),
});
```

Комментарий над функцией поправить на соответствующий («24h high/low from the last 24 hourly bars + avgRange14h volatility unit»). Перед правкой исполнитель обязан выполнить `grep -rn "high24h\|low24h" src/ test/` и убедиться, что других потребителей старой семантики нет (на момент аудита поля используются только как контекст для LLM).

**Тестируемость:** расчёт `avgRange14h` (а также экстремумов 24h) вынести чистыми функциями в новый модуль `src/telegram/market-summary.mjs` (напр. `export function summarizeCandles(candles)` → `{ high24h, low24h, avgRange14h }`), который `bot.mjs` импортирует. Это позволит тестировать кейс 10 без сети и app-entry.

**Why it is better:** Имя поля перестаёт лгать; anti-chase правило гварда снова работает на заявленном горизонте. `avgRange14h` даёт и скауту (промпт v4), и валидатору (S-1), и в перспективе гварду единую, предвычисленную единицу волатильности вместо «посчитай ATR в уме».

**Expected benefit:** Восстановление заявленной семантики данных; согласованность правил между компонентами. Проверяется юнит-тестом на синтетических свечах (кейс 10).

**Potential downside:** Если биржа вернёт <24 свечей (редко), high24h/low24h будут по меньшему окну — приемлемо, поля и раньше были best-effort. Никаких downstream-контрактов не ломается: поля остаются числами/undefined.

**Validation plan:** юнит-тест с 30 синтетическими свечами: `high24h` == max high последних 24, `avgRange14h` == среднее range последних 14. Прогон `/trade`, сверка значений в логе с графиком.

**Approval required:** правка НЕ применена.

---

## S-3 (P2): Детерминированная проверка R/R ≥ 1.5 в `ideaIssues`

**Issue:** Промпт требует «takeProfit at least 1.5x further than stopLoss», но парсер это не проверяет. Реальный прогон по логу `data/telegram/pipeline.jsonl`: **30 из 290 идей (10.3%) нарушают R/R ≥ 1.5**, минимум 0.55. Сегодня такие идеи ловит только LLM-гвард (правило 5), считающий арифметику в уме. При этом сообщение `/trade` при пустом списке утверждает «нет сетапа с широким стопом + R/R ≥ 1.5» — то есть система декларирует enforcement, которого нет.

**Evidence:** `ideas.mjs`, `ideaIssues` — есть геометрия (SL<entry<TP), нет R/R. Replay-статистика по 31 прогону: R/R p25=1.69, медиана 1.90, но 10.3% ниже 1.5.

**Trading impact:** Каждая десятая идея несёт профиль «риск больше прибыли» и расходует вызов гварда; часть может пройти, если гвард арифметически ошибётся.

**Proposed change** (`ideas.mjs`, в `ideaIssues`, сразу ПОСЛЕ существующей проверки LONG/SHORT-геометрии, внутри того же `if` с числовыми полями):

```js
const risk = Math.abs(entry - stopLoss);
const reward = Math.abs(takeProfit - entry);
if (risk > 0 && reward < 1.5 * risk) {
  issues.push(`${at}: reward/risk must be >= 1.5 (got ${(reward / risk).toFixed(2)})`);
}
```

**Why it is better:** Правило есть в промпте — теперь оно enforced кодом на самом дешёвом слое. Граница 1.5 ровно проходит (`reward < 1.5 * risk` — строгое неравенство). Гвард-правило 5 остаётся вторым эшелоном (defense in depth). Сообщение `/trade` становится правдивым без правок текста.

**Expected benefit:** −10% мусорных идей до гварда. Метрика: доля идей с R/R < 1.5 в SCOUT-issues.

**Potential downside:** Минимальный: модель иногда сдаёт R/R 1.45 ради качественного уровня — такие идеи будут отброшены. Это осознанное ужесточение, оно уже заявлено в промпте.

**Validation plan:** юнит-тесты (кейсы 2–3: граница 1.50 проходит, 1.49 отбрасывается).

**Approval required:** правка НЕ применена.

---

## S-4 (P2): Новый системный промпт `scout-ideas-v4` (полная замена `SCOUT_SYSTEM_PROMPT`)

**Issue:** (а) Правило стопа «~1.5x the recent 1-hour range» неопределённо и непроверяемо; (б) конструкция «propose every reasonable idea» эмпирически вырождается в blanket-генерацию: в 21 из 31 прогона (68%) скаут выдал идею на КАЖДЫЙ символ; (в) модель не знает ни интервала, ни порядка свечей, ни того, что числа будут проверены кодом.

**Evidence:** дистрибуция ideaCount в логе: `{0:2, 1:1, 4:2, 6:1, 7:10, 10:4, 15:11}`; 21/31 прогон — ideaCount == symbolsSeen. Гвард вынужден отклонять ~60% (169/283).

**Trading impact:** До 15 параллельных вызовов reasoner-гварда за скан (стоимость × задержка), портфельный риск коррелированных «одобренных» идей, размытие селективности.

**Proposed change:** в `ideas.mjs` заменить значение `SCOUT_SYSTEM_PROMPT` и поднять версию:

```js
export const IDEAS_PROMPT_VERSION = 'scout-ideas-v4';

export const SCOUT_SYSTEM_PROMPT = Object.freeze(
  [
    'You are a crypto trade scout inside a deterministic trading system. You propose short-horizon (1h–12h) trade ideas from the market data you are given. Code validates your numbers; a separate risk guard re-validates each idea.',
    'Respond with ONLY a JSON object of this exact shape (no prose, no fences):',
    '{"ideas":[{"symbol":"BTCUSDT","side":"LONG","entry":82800,"stopLoss":81000,"takeProfit":86200,"rationale":"short reason"}]}',
    '',
    'DATA YOU RECEIVE (one entry per symbol in "symbols"):',
    '- lastPrice, bid, ask: current top of book.',
    '- high24h / low24h: the TRUE 24-hour high/low.',
    '- avgRange14h: average (high - low) of the last 14 HOURLY candles. Use it as the volatility unit.',
    '- candles: the last 30 HOURLY candles, OLDEST FIRST, each {o,h,l,c,v}, without timestamps.',
    '- "news" (optional): Fear & Greed reading and recent headlines.',
    '- "openPositions" (optional): array of currently open positions, each {symbol, side}. (Appears after G-8.)',
    '',
    'Field rules:',
    '- symbol: exactly one of the symbols in the data — never any other ticker.',
    '- side: "LONG" or "SHORT".',
    '- entry: a limit entry within ~1% of lastPrice. Not a chase, not a deep pullback order.',
    '- stopLoss: at least 1.5 x avgRange14h away from entry, AND beyond the nearest 1h swing (below the swing low for LONG, above the swing high for SHORT).',
    '- takeProfit: at least 1.5x further from entry than stopLoss is (reward/risk >= 1.5). Code numerically discards ideas that fail this.',
    '- rationale: one short concrete sentence naming the level, volatility or trend you used.',
    '- Do NOT emit quantity, position size, leverage, dollars or risk percent.',
    '',
    'SELECTIVITY (important):',
    '- Propose AT MOST 5 ideas — the cleanest setups only, at most one per symbol.',
    '- Never propose an idea on a symbol that already has an open position, and do not pick a direction that fights your existing correlated exposure (see "openPositions").',
    '- 0 to 2 ideas is a normal, healthy output. An idea for every symbol means you are forcing setups; do not do that.',
    '- If you genuinely see no tradeable setup, return {"ideas":[]}.',
    '',
    'CORRELATION RULE: most altcoins move with BTC over this horizon. Do NOT propose simultaneous opposing trades on correlated assets unless their 1h paths have clearly diverged in the data you see. If BTC is trending up, the default bias for correlated alts is LONG; if down, SHORT. Only a coin with an independent, coin-specific driver (unique news, aggressive funding, clear divergence in the candles) may carry the opposite side.',
    '',
    'NEWS RULE: use "news" as a bias filter: do NOT propose SHORT into a coin with an active bullish catalyst (ETF inflows, adoption, upgrades, favorable regulation), and do NOT propose LONG into a coin with an active bearish catalyst (hacks, bans, delistings, lawsuits). If news and technicals conflict, skip the idea or state the conflict in the rationale.',
    '',
    'Use ONLY the numbers present in the data. Never invent prices, levels, funding rates or news.',
  ].join('\n'),
);
```

**Ключевые отличия v4 от v3:** словарь данных (интервал/порядок свечей, смысл avgRange14h); точные числовые правила вместо «~»; явная селективность (≤5 идей, «0–2 это норма», «идея на каждый символ = форсинг»); уведомление модели о кодовой валидации; правила корреляции и новостей сохранены без изменений; запрет выдумывать данные. **Схема JSON не изменилась** — downstream не ломается. `MAX_IDEAS = 15` в коде остаётся как страховочное усечение.

**Why it is better:** Убирает подтверждённый эмпирически failure mode (blanket-генерация), делает правила проверяемыми и совместимыми с валидатором S-1 (та же константа 1.5 × avgRange14h), не воскрешая старый failure mode «over-strict scout всегда возвращает []» — фраза «0 to 2 ideas is normal» легализует пустой ответ, а стоп-правило остаётся достижимым.

**Expected benefit:** Метрики для A/B: доля прогонов с ideaCount == symbolsSeen падает с ~68% до <20%; guard approval rate растёт; число вызовов гварда за скан падает с ~9 до ~3–5 (стоимость скана). Одобренных сетапов за день не должно упасть до нуля — иначе откат.

**Potential downside:** Потеря recall: редкий хороший сетап может не попасть в топ-5. Смягчение: гвард исторически одобряет ~40%, а лимит позиций всё равно 4 — избыток идей не monetizируется. Поведенческий риск «слишком мало идей» контролируется A/B-метриками и откатом (git revert; версия промпта зафиксирована константой).

**Validation plan:** юнит-тест, что `buildScoutPrompt` возвращает version `scout-ideas-v4` и неизменный user-payload; A/B paper-прогон v3 vs v4 по метрикам выше минимум 2 недели перед выводом в основной контур.

**Approval required:** правка НЕ применена.

---

## S-5 (P3, ОПЦИОНАЛЬНО — только по отдельной команде владельца): slim-контекст Scout без `instrument`

Модель по инструкции не сайзит позиции, поэтому 5 числовых полей `instrument` × 15 символов — мёрвый токенный груз в payload скаута. Реализация: в `buildScoutPrompt(context)` сериализовать `JSON.stringify({ ...context, symbols: context.symbols.map(({ instrument, ...rest }) => rest) })`. Объект `context` сам не трогать — `instrument` нужен автотрейду (`bot.mjs`, `sizePosition`) и гварду. Экономия ~10–15% входных токенов скаута. Риск: нулевой для контракта, проверяется снапшот-тестом user-payload.

## S-6 (P3, ЭКСПЕРИМЕНТ — требуется решение владельца): старший таймфрейм

Для горизонта 1–12ч скаут видит только 30 часов истории; «тренд BTC» для correlation rule выводится из тех же 30 часовок. Вариант: добавить на символ компактную 4h-сводку (напр., `bias4h`, ближайшие swing high/low по 4h) — предвычисленную кодом, не свечами. Отдельным ТЗ после A/B пакета scout-v4.

---

## 7. План валидации пакета

### 7.1. Юнит-тесты — новый файл `test/telegram-ideas.test.mjs`

Кейсы (`node:test`, `assert/strict`, стиль как в существующих тестах):

1. `parseScoutResponse`: валидная идея проходит (регрессия).
2. S-3: идея с R/R = 1.49 отбрасывается с issue `reward/risk`.
3. S-3: идея с R/R = 1.50 проходит (граница включительно).
4. S-1: идея с символом `PEPEUSDT` при контексте, содержащем только `1000PEPEUSDT`, отбрасывается с issue `not in the market context`.
5. S-1: идея с символом из контекста проходит.
6. S-1: entry на +3% от `lastPrice` отбрасывается; entry на +1% проходит.
7. S-1: stopDist < 1.5 × avgRange14h отбрасывается; == 1.5 × avgRange14h проходит.
8. S-1: контекст БЕЗ `avgRange14h` (старый формат) — проверка ширины стопа пропускается, идея не отбрасывается по этому основанию (обратная совместимость).
9. S-1: `generateIdeas`-уровень — `validateIdeasWithMarket` вызывается только при `parsed.ok === true`; issues конкатенируются. (Допустимо тестировать чистую композицию без HTTP — вынести в тест вызов `validateIdeasWithMarket` напрямую.)
10. S-2: на 30 синтетических часовых свечах `high24h`/`low24h` == экстремумы последних 24 свечей; `avgRange14h` == среднее (h−l) последних 14. (Если `buildMarketContext` недоступна без сети — вынести чистую функцию `summarizeCandles(candles)` в `ideas.mjs` или локальный helper и тестировать её; выбор за исполнителем, предпочтение чистой функции.)
11. S-4: `buildScoutPrompt({})` возвращает `version === 'scout-ideas-v4'`.

Прогон: `npm test`.

### 7.2. Offline-replay по логу (уже выполнено аудитором, повторить после правок)

По `data/telegram/pipeline.jsonl` (31 прогон, 290 идей): неизвестных символов — 0, нарушений геометрии — 0, R/R < 1.5 — 30 (10.3%), min R/R 0.55. После S-3 эти 30 идей должны отсекаться парсером. Рыночные проверки S-1 (entry/lastPrice, stop/avgRange14h) по логу не воспроизводимы — контексты не логируются; проверяются юнит-тестами и paper-прогоном.

### 7.3. Paper A/B (перед основным контуром)

1–2 недели, v3 vs v4 на одном рынке. Метрики: ideas/прогон; доля прогонов с полным покрытием списка; guard approval rate; вызовов гварда/скан (стоимость); одобренных сетапов/день (не должен обвалиться); R/R-распределение идей. Критерий принятия: full-coverage < 20%, approval rate ↑, стоимость скана ↓, одобренные сетапы > 0.

### 7.4. Rollback

`git revert` коммита пакета; версия промпта зафиксирована (`scout-ideas-v3` → `scout-ideas-v4`), логи различимы по `version`.

---

## 8. Явно вне области Части 1

- `monitor.mjs`, `reflect.mjs`, `stopcheck.mjs` — отдельные ТЗ после intake соответствующих компонентов.
- Лимиты автотрейда (`AUTO_CONFIDENCE`, `AUTO_MAX_POSITIONS`, `AUTO_RISK_PCT`, `AUTO_DAILY_LOSS_CAP_USD`), `MAX_IDEAS`, пороги `decideEntryMode`.
- Любые изменения исполнения ордеров.

---
---

# Часть 2 — Guard (пакет risk-guard-v2)

**Контекст аудита (почему это нужно):**
1. Hard rules гварда сегодня исполняет LLM «в уме»: ATR(14) по 30 свечам (правило 1), EMA21 BTC (правило 4), R/R (правило 5). LLM арифметически ошибается — это подтверждённый класс отказов.
2. Правило 8 предписывает «widen the stop / take-profit distances» — но гвард по контракту модуля «never adjusts the order», и в схеме ответа нет полей для скорректированных цен. Мёртвая, противоречивая инструкция.
3. Anti-chase правило 3 опирается на `high24h/low24h`, которые до правки S-2 являются ~100-часовыми экстремумами — защита ослаблена.
4. Fear&Greed НЕ доходит до гварда через sentiment: `fetchMarketSentiment` (`src/telegram/sentiment.mjs`) никогда не возвращает `fearGreed`, а `formatSentiment` его ожидает — мёртвый путь. Правило 7 (sentiment-вето) при этом опирается на Extreme Greed/Fear.
5. Каждый вызов гварда получает ПОЛНЫЙ контекст всех 15 символов (`contextForIdea`, bot.mjs ≈173–175) — при 15 идеях это ~15× лишних токенов за скан.
6. Автотрейд (`runAutoScan`) входит market-ордером по SL/TP из идеи БЕЗ перепроверки дрейфа цены, хотя в ручном потоке `/trade` есть `decideEntryMode` (slippage/refresh/reject). Скан занимает 20–60 сек — рынок успевает уйти.
7. Наблюдение владельца: система предлагает LONG по BTC, а через 10 минут — SHORT по альтам. Причина верифицирована: прогоны Scout stateless (нет памяти между запусками, нет открытых позиций в контексте), correlation rule действует только внутри одного прогона, temperature 0.7. Правится в G-8 (+ селективность S-4).

**Архитектурное решение (одобрено владельцем):** hard rules уходят из промпта в детерминированный код (`precheckIdea`), LLM-гвард остаётся для того, что код судить не умеет: целостность сетапа, дискреционные вето (sentiment-экстремумы, чоп), конфликты новостей.

**Инвариант:** JSON-контракт вердикта `{verdict, confidence, reasons}` НЕ меняется. `filterIdea` в `src/telegram/deepseek-client.mjs` не меняется.

---

## G-1 (P1): `precheckIdea` — детерминированные hard rules перед LLM-гвардом

**Issue:** правила 1/3/4/5 (стоп vs ATR, anti-chase, BTC-кластер, R/R) исполняет LLM с мысленной арифметикой; нарушения доходят до платного вызова reasoner-модели.

**Evidence:** `GUARD_SYSTEM_PROMPT` (risk-filter.mjs ≈23–47), правила 1, 3, 4, 5; лог: 169 REJECTED из 283 — большая часть отсевов могла быть бесплатной.

**Trading impact:** ослабленные/ошибочные проверки на hard rules; стоимость скана (до 15 reasoner-вызовов); задержка скана 20–60 сек (дрейф цены до входа).

**Proposed change:** в `src/telegram/risk-filter.mjs` добавить:

```js
export const PRECHECK_STOP_RANGE_MULT = 1.5;
export const PRECHECK_MIN_REWARD_RISK = 1.5;
export const PRECHECK_CHASE_PCT = 8;

/**
 * Deterministic hard-rule precheck for one scout idea against the market
 * context. Runs BEFORE the LLM guard: a failed idea never reaches (or pays
 * for) the reasoner call. Fail-closed: missing market data = not pass.
 *
 * @param {Record<string, any>} idea  valid idea from the scout stage
 * @param {{ symbols?: Array<Record<string, any>>, btc?: Record<string, any> | null }} context
 * @returns {{ pass: boolean, reasons: string[] }}
 */
export function precheckIdea(idea, context) {
  const symbols = Array.isArray(context?.symbols) ? context.symbols : [];
  const snap = symbols.find((s) => s && s.symbol === idea.symbol) ?? null;
  if (!snap) {
    return { pass: false, reasons: [`precheck: no market data for ${idea.symbol}`] };
  }
  const reasons = [];

  // 1. Stop width vs the shared volatility unit (skipped when unit absent).
  const ar = snap.avgRange14h;
  if (typeof ar === 'number' && Number.isFinite(ar) && ar > 0) {
    const stopDist = Math.abs(idea.entry - idea.stopLoss);
    if (stopDist < PRECHECK_STOP_RANGE_MULT * ar) {
      reasons.push(`precheck: stop distance ${stopDist} < ${PRECHECK_STOP_RANGE_MULT}x avgRange14h (${ar})`);
    }
  }

  // 2. Reward/risk (second layer after scout S-3 — defense in depth).
  const risk = Math.abs(idea.entry - idea.stopLoss);
  const reward = Math.abs(idea.takeProfit - idea.entry);
  if (risk > 0 && reward < PRECHECK_MIN_REWARD_RISK * risk) {
    reasons.push(`precheck: reward/risk ${(reward / risk).toFixed(2)} < ${PRECHECK_MIN_REWARD_RISK}`);
  }

  // 3. Anti-chase vs the TRUE 24h range (meaningful only after S-2).
  if (idea.side === 'LONG' && typeof snap.low24h === 'number' && snap.low24h > 0) {
    const above = ((idea.entry - snap.low24h) / snap.low24h) * 100;
    if (above > PRECHECK_CHASE_PCT) {
      reasons.push(`precheck: LONG entry ${above.toFixed(1)}% above 24h low (max ${PRECHECK_CHASE_PCT}%)`);
    }
  }
  if (idea.side === 'SHORT' && typeof snap.high24h === 'number' && snap.high24h > 0) {
    const below = ((snap.high24h - idea.entry) / snap.high24h) * 100;
    if (below > PRECHECK_CHASE_PCT) {
      reasons.push(`precheck: SHORT entry ${below.toFixed(1)}% below 24h high (max ${PRECHECK_CHASE_PCT}%)`);
    }
  }

  // 4. BTC-cluster direction (precomputed in G-2; skip BTC itself and flat/unknown).
  const bias = context?.btc?.bias;
  if (idea.symbol !== 'BTCUSDT' && (bias === 'up' || bias === 'down')) {
    if (bias === 'down' && idea.side === 'LONG') reasons.push('precheck: alt LONG against BTC bias=down');
    if (bias === 'up' && idea.side === 'SHORT') reasons.push('precheck: alt SHORT against BTC bias=up');
  }

  return { pass: reasons.length === 0, reasons };
}
```

**Интеграция, поток `/trade` (`src/telegram/bot.mjs`, внутри `ideas.map(...)` ≈371–386, ПЕРЕД `fetchMarketSentiment`):**

```js
const pre = precheckIdea(idea, context);
if (!pre.pass) {
  log.guard('precheck rejected', { symbol: idea.symbol, side: idea.side, reasons: pre.reasons });
  return { idea, guard: null, precheckReasons: pre.reasons };
}
```

Цикл сбора результатов (≈388–394) дополнить веткой: `if (guard === null) { rejected.push({ idea, reasons: precheckReasons }); continue; }` — деструктуризацию расширить до `{ idea, guard, precheckReasons }`.

**Интеграция, `runAutoScan` (≈1245–1261, в начале `scout.parsed.ideas.map(...)`):**

```js
const pre = precheckIdea(idea, context);
if (!pre.pass) {
  rejectedCount.push(`${idea.symbol} ${idea.side} (precheck: ${pre.reasons[0]})`);
  return;
}
```

**Why it is better:** числовые правила исполняет код — без арифметических галлюцинаций и бесплатно; LLM-гвард получает только прошедшие идеи (меньше вызовов, быстрее скан → меньше дрейф к входу). Пороги взяты из существующего промпта гварда (1.5×, R/R 1.5, 8%) — семантика правил сохранена, меняется только исполнитель.

**Expected benefit:** LLM-вызовов гварда за скан: с ~9 до ~3–5 (оценка по логу: 60% отсевов); rejection reasons становятся точными (числа, а не проза). Метрика: `precheck rejected` vs `guard verdict` в pipeline.jsonl.

**Potential downside:** ошибка в precheck режет хорошие идеи без апелляции — смягчается юнит-тестами G-9 и тем, что пороги идентичны промптным. BTC bias='flat' не ограничивает — направленные вето срабатывают только при явном тренде.

**Validation plan:** юнит-тесты G-9 (кейсы 1–6); прогон `/trade` — сверить, что precheck-отказы соответствуют числам.

**Approval required:** не применено.

---

## G-2 (P1): Прекомпьют BTC-блока в `buildMarketContext`

**Issue:** правило 4 гварда («alt LONG, когда BTC ниже EMA21 1h / падает >1% за 4ч») требует от LLM вычислить EMA21 по свечам в уме.

**Proposed change:** в новый модуль `src/telegram/market-summary.mjs` (создан в S-2):

```js
/** Exponential moving average, last value. Returns null when data < period. */
export function emaLast(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) ema = values[i] * k + ema * (1 - k);
  return Number.isFinite(ema) ? ema : null;
}

/**
 * Precomputed BTC trend block. bias mirrors the old guard rule 4:
 *   'down' when last < EMA21(1h) OR 4h change <= -1%;
 *   'up'   when last > EMA21(1h) AND 4h change >= +1%;
 *   'flat' otherwise. Returns null when BTC data is insufficient (<22 closes).
 */
export function computeBtcBlock(btcCandles) {
  const closes = (Array.isArray(btcCandles) ? btcCandles : [])
    .map((c) => c?.c)
    .filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (closes.length < 22) return null;
  const ema21h = emaLast(closes, 21);
  const last = closes[closes.length - 1];
  const back4 = closes[closes.length - 5];
  if (ema21h === null || typeof back4 !== 'number' || back4 <= 0) return null;
  const change4hPct = ((last - back4) / back4) * 100;
  let bias = 'flat';
  if (last < ema21h || change4hPct <= -1) bias = 'down';
  else if (last > ema21h && change4hPct >= 1) bias = 'up';
  return { lastPrice: last, ema21h, change4hPct, bias };
}
```

В `bot.mjs` / `buildMarketContext`, после цикла по символам, перед `return`:

```js
const btcSnap = snapshots.find((s) => s.symbol === 'BTCUSDT');
const btc = btcSnap ? computeBtcBlock(btcSnap.candles) : null;
return { symbols: snapshots, btc, generatedAt: new Date().toISOString() };
```

Дополнительных API-вызовов нет — используются уже загруженные свечи BTC. Если снапшот BTC не загрузился, `btc = null` → проверка кластера в G-1 пропускается, а промпт v2 (G-5) трактует направление BTC как unknown.

**Why it is better:** одно число, один источник истины; формула bias сохраняет семантику старого правила 4 («below EMA21 / falling >1% in 4h» → OR для down).

**Expected benefit / downside / validation:** как в G-1; кейсы G-9 (7–8).

**Approval required:** не применено.

---

## G-3 (P1): Убрать из правила 8 невозможную инструкцию «widen the stop»

**Issue:** правило 8 предлагает «widen the stop / take-profit distances» как альтернативу reject — гвард не имеет ни полей в схеме, ни полномочий для этого (шапка модуля: «never adjusts the order»).

**Proposed change:** реализуется текстом промпта v2 (G-5, правило 3): в явном чопе — ТОЛЬКО REJECT с причиной «no tradable trend». Отдельного кода нет.

**Approval required:** не применено.

---

## G-4 (P2): Починить путь Fear&Greed в sentiment гварда

**Issue:** `fetchMarketSentiment` возвращает только `{fundingRate, volume24h, turnover24h, openInterestValue}`; `formatSentiment` ждёт также `fearGreed`/`fearGreedClass` — они всегда undefined, F&G в sentiment-строке отсутствует. При этом `gatherNews()` возвращает `{ fng, headlines, text }`, но оба call-site используют только `text`.

**Evidence:** `src/telegram/sentiment.mjs` (37–83); `src/telegram/news.mjs` (`gatherNews`, ≈163–181); `bot.mjs` ≈332–338 и ≈1228–1231.

**Proposed change** (два call-site в `bot.mjs`):

```js
// было: const { text: newsText } = await gatherNews();
const { text: newsText, fng } = await gatherNews();
```

и в обоих местах, где собирается sentiment идеи (≈376–382 и ≈1247–1248):

```js
const sent = await fetchMarketSentiment(idea.symbol);
if (fng && Number.isFinite(fng.value)) {
  sent.fearGreed = fng.value;
  sent.fearGreedClass = fng.classification ?? null;
}
sentimentText = formatSentiment(sent);
```

**Why it is better:** правило sentiment-вето получает свой ключевой вход (F&G — макро-показатель, одинаков для всех символов, поэтому корректно брать из общего gatherNews). `sentiment.mjs` не меняется.

**Expected benefit:** вето правила 7 перестаёт работать вслепую. Метрика: sentiment-строка в логе гварда содержит «Fear&Greed: …».

**Potential downside:** нулевой (поле advisory; отсутствие F&G по-прежнему не повод для reject).

**Validation plan:** кейс G-9 (9); ручной прогон `/trade` с логом.

**Approval required:** не применено.

---

## G-5 (P2): Новый промпт гварда `risk-guard-v2` (полная замена `GUARD_SYSTEM_PROMPT`)

**Proposed change:** в `src/telegram/risk-filter.mjs`:

```js
export const RISK_FILTER_PROMPT_VERSION = 'risk-guard-v2';

export const GUARD_SYSTEM_PROMPT = Object.freeze(
  [
    'You are a risk guard inside a deterministic trading system. You are adversarial: your job is to REJECT bad trades, not to approve them.',
    'Hard numeric rules (stop width vs volatility, reward/risk >= 1.5, entry near market, anti-chase vs the true 24h range, BTC-cluster direction) are ALREADY enforced by code before you see an idea. Do NOT recompute them. Your job is what code cannot judge: coherence, liquidity and sentiment extremes, chop, and news conflicts.',
    'You receive ONE trade idea {symbol, side, entry, stopLoss, takeProfit}, a market snapshot for THAT symbol (lastPrice, bid, ask, true high24h/low24h, avgRange14h, the last 30 HOURLY candles oldest-first as {o,h,l,c,v}), a precomputed BTC block {lastPrice, ema21h, change4hPct, bias: up|down|flat} and, when available, SENTIMENT (Fear&Greed, funding, 24h turnover, open interest) and NEWS headlines.',
    'Respond with a single JSON object and nothing else:',
    '- verdict: "APPROVED" or "REJECTED"',
    '- confidence: a number in [0, 1]',
    '- reasons: an array of 1..5 short strings (each max ~120 chars)',
    '',
    'REJECT when ANY of these hold:',
    '1. The idea is incoherent with the data: levels named in the rationale do not exist in the candles, or the stop is not beyond the nearest 1h swing (below the swing low for LONG, above the swing high for SHORT).',
    '2. SENTIMENT clearly contradicts the trade: a LONG into extremely crowded-long funding plus Extreme Greed (blow-off top), or a SHORT into extremely crowded-short funding plus Extreme Fear (snap-back squeeze). Discretionary veto — only when unambiguous and extreme; name the numbers.',
    '3. RANGE/CHOP veto: the market oscillates in a narrow band relative to avgRange14h with no trend, so any stop will be whipsawed before the take-profit. You CANNOT adjust prices — in clear chop, REJECT with reason "no tradable trend".',
    '4. NEWS clearly fights the trade: an active bearish catalyst against a LONG or an active bullish one against a SHORT. Name the headline.',
    '',
    'CONFIDENCE = a COMPOSITE score, NOT a price prediction. Start at 0.5. Add up to +0.2 when the setup is clean with margin. Add up to +0.2 when sentiment ALIGNS with the trade (funding not crowded against you, Fear&Greed not extreme, turnover healthy — the move looks LIQUID, not a fake-out). Add up to +0.1 when the news supports the direction. Subtract up to -0.3 when sentiment is ambiguous, the move looks illiquid/overheated, or the market is choppy. Clamp to [0,1]. Never report above 0.85 — reserve headroom for genuine uncertainty. Confidence describes HOW WELL THE SETUP HOLDS UP, not the probability of profit.',
    'Never invent missing data. If a datum is absent, say "unknown" in reasons; do NOT reject for missing sentiment alone. Use the precomputed BTC block as-is — do not compute your own indicators.',
  ].join('\n'),
);
```

**Соответствие старому промпту:** правила 1/3/4/5/6 (числовые) → код G-1/S-3/парсер; старое правило 2 (стоп за свингом) → v2 правило 1; старое 7 → v2 правило 2; старое 8 → v2 правило 3 (без «widen»); новости → v2 правило 4. Рубрика confidence и потолок 0.85 сохранены (окно автотрейда 0.75–0.85 не меняется).

**Why it is better:** промпт перестаёт требовать от LLM арифметики; каждое оставшееся правило — суждение, а не вычисление; противоречие «widen» устранено; модель знает, что BTC-блок прекомпьютнут.

**Expected benefit:** меньше рассогласований между precheck и LLM; reasons короче и по делу. Метрика: доля вердиктов со ссылкой на конкретные числа/уровни; PARSE_ERROR = 0.

**Potential downside:** если precheck ошибочно мягок (напр., нет avgRange14h), гвард v2 больше не страхует числовые правила — смягчение: G-1 тесты + отсутствие avgRange14h возможно только при деградированных данных, что само по себе редкость и логируется.

**Validation plan:** кейсы G-9 (10–11); A/B paper 1–2 недели: approval rate, доля REJECTED по v2-правилам, стоимость скана.

**Approval required:** не применено.

---

## G-6 (P2): Slim-контекст гварда + гигиена парсера

**Issue (а):** `contextForIdea` отдаёт гварду все 15 символов на каждую идею (≈15× лишних токенов за скан; на длине скана 20–60 сек это ещё и дрейф цены).
**Issue (б):** `MAX_REASON_LENGTH = 800` объявлен, но не enforced; лимита числа reasons нет.

**Proposed change (а)** — `bot.mjs`, `contextForIdea` (≈173–175):

```js
/** Slim market context for the guard: only the idea's symbol + the BTC block. */
function contextForIdea(context, symbol) {
  const snap = context.symbols.find((s) => s.symbol === symbol) ?? null;
  return { symbol: snap, btc: context.btc ?? null };
}
```

(После G-1 `snap` гарантированно не null; `?? null` — защита.)

**Proposed change (б)** — `risk-filter.mjs`, в `parseGuardResponse` заменить проверку reasons:

```js
if (
  !Array.isArray(obj.reasons)
  || obj.reasons.length === 0
  || obj.reasons.length > 5
  || obj.reasons.some((r) => typeof r !== 'string' || r.trim() === '' || r.trim().length > MAX_REASON_LENGTH)
) {
  issues.push('reasons must be 1..5 non-empty strings, each <= 800 chars');
}
```

**Why it is better:** гвард судит идею по нужным данным, а не по 15 графикам; корреляция теперь детерминированная (G-1/G-2), поэтому остальные символы ему не нужны. Пустой массив reasons больше не проходит — вердикт без обоснования бесполезен для аудита.

**Expected benefit:** входные токены гварда за скан −80–90%; fail-closed на раздутых reasons.

**Potential downside:** (а) если когда-нибудь понадобится cross-asset суждение гварда — вернуть поле; сейчас оно заменено прекомпьютом. (б) вердикты с 6+ reasons станут REJECT через fail-closed — приемлемо и видно в логе.

**Validation plan:** кейсы G-9 (12–13).

**Approval required:** не применено.

---

## G-7 (P1): Автотрейд — перепроверка дрейфа цены и здравости SL/TP перед входом

**Issue:** `runAutoScan` после скана (20–60 сек) ставит market-ордер со SL/TP из устаревшего снапшота. В ручном потоке есть `decideEntryMode`, в автотрейде — ничего. Цена может уйти за стоп (мгновенный стоп-аут) или за тейк (сделка бессмысленна) или на >1% от входа (R/R испорчен).

**Evidence:** `bot.mjs` ≈1293–1307 (`placeMarketOrder` сразу после sizing); `decideEntryMode` ≈216–221 используется только в approve-flow.

**Trading impact:** автономные входы на устаревших уровнях = систематически худшие цены и сломанный профиль риска; особенно критично для сценария владельца «автотрейд ночью без надзора».

**Proposed change:** в `risk-filter.mjs` добавить чистую функцию:

```js
/**
 * Decide whether an unattended auto-entry is still valid at the live price.
 * Mirrors the manual approve-flow thresholds (loadApproveThresholds).
 *
 * @param {{ idea: Record<string, any>, live: number, slippagePct: number, refreshPct: number }} input
 * @returns {{ skip: boolean, reason: string }}
 */
export function shouldSkipAutoEntry({ idea, live, slippagePct, refreshPct }) {
  if (!Number.isFinite(live) || live <= 0) return { skip: true, reason: 'no live price' };
  const diffPct = (Math.abs(live - idea.entry) / idea.entry) * 100;
  if (diffPct > refreshPct) return { skip: true, reason: `price drifted ${diffPct.toFixed(2)}% (> ${refreshPct}%)` };
  const sane = idea.side === 'LONG'
    ? live > idea.stopLoss && live < idea.takeProfit
    : live < idea.stopLoss && live > idea.takeProfit;
  if (!sane) return { skip: true, reason: 'live price already beyond SL/TP of the idea' };
  return { skip: false, reason: `drift ${diffPct.toFixed(2)}% ok` };
}
```

В `bot.mjs` / `runAutoScan`, ПЕРЕД `placeMarketOrder` (≈1293):

```js
const liveNow = await getCurrentPrice(pick.idea.symbol);
const { slippagePct, refreshPct } = loadApproveThresholds();
const gate = shouldSkipAutoEntry({ idea: pick.idea, live: liveNow.lastPrice, slippagePct, refreshPct });
if (gate.skip) {
  log.guard('autotrade entry skipped', { symbol: pick.idea.symbol, reason: gate.reason });
  if (report) await notifyUser(`⏸ Авто-вход пропущен: ${gate.reason} (${escapeHtml(pick.idea.symbol)}).`);
  return;
}
```

`getCurrentPrice` уже существует в bot.mjs (используется монитором, ≈1026).

**Why it is better:** автономный вход получает тот же класс защиты, что и ручной approve; проверка — чистая функция, покрывается тестами.

**Expected benefit:** ноль входов «вслед за ушедшим рынком»; в логе `autotrade entry skipped` видно каждый спасённый вход.

**Potential downside:** часть валидных входов будет пропущена на волатильном рынке (drift >1% за минуту скана) — осознанная цена защиты; пороги те же, что у ручного потока.

**Validation plan:** кейсы G-9 (14–16).

**Approval required:** не применено.

---

## G-8 (P2): Открытые позиции в контексте Scout (согласованность между прогонами)

**Issue:** Scout не знает об открытых позициях и прошлых идеях — отсюда наблюдение владельца «LONG BTC, через 10 минут SHORT по альтам». Correlation rule работает только внутри одного прогона.

**Proposed change (а)** — `bot.mjs`, в `/trade` (после `buildMarketContext`, ≈327) и в `runAutoScan` (≈1227; там позиции уже получены выше для лимита — переиспользовать `open` и `spots`):

```js
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
```

В `runAutoScan` НЕ делать повторный вызов — использовать уже полученные `open`/`spots` (≈1217–1218).

**Proposed change (б)** — промпт Scout v4 (S-4) уже содержит строки про `openPositions` (добавлены настоящим ТЗ); при применении убедиться, что они на месте.

**Proposed change (в)** — детерминированный слой: дополнить `validateIdeasWithMarket` (S-1, ideas.mjs) проверкой сразу после проверки символа:

```js
const open = Array.isArray(market?.openPositions) ? market.openPositions : [];
if (open.some((p) => p && p.symbol === idea.symbol)) {
  issues.push(`${at}.symbol ${JSON.stringify(idea.symbol)} already has an open position`);
  return;
}
```

**Why it is better:** память о направленной экспозиции возвращается в систему через данные, а не через надежду на модель; дубли и пирамидинг по уже открытым символам отсекаются кодом. Кросс-активная согласованность направления — на уровне промпта (advisory) + precheck BTC-кластера (G-1).

**Expected benefit:** ноль идей по открытым символам; меньше противоречивых направлений между соседними прогонами. Метрика: issues вида «already has an open position».

**Potential downside:** переворот позиции через Scout становится невозможен (нужно сначала закрыть) — соответствует текущей модели «monitor владеет открытыми позициями»; если владелец захочет reversal-логику — отдельное ТЗ.

**Validation plan:** кейс G-9 (17) + кейс 12 из 7.1 (обновлён: идея по символу с открытой позицией отбрасывается).

**Approval required:** не применено.

---

## G-9. План валидации Части 2 — `test/telegram-guard.test.mjs`

Кейсы (`node:test`, `assert/strict`):

1. `precheckIdea`: stopDist < 1.5×avgRange14h → `pass:false` с причиной про стоп.
2. `precheckIdea`: reward/risk 1.2 → fail; 1.5 → pass.
3. `precheckIdea`: LONG entry на +9% от low24h → fail; +7% → pass (граница 8%).
4. `precheckIdea`: alt LONG при `btc.bias='down'` → fail; при `'flat'` → pass; BTCUSDT LONG при `'down'` → pass (себя не проверяет).
5. `precheckIdea`: без `avgRange14h` в снапшоте проверка стопа пропускается.
6. `precheckIdea`: символ вне контекста → fail («no market data»).
7. `computeBtcBlock`: 30 синтетических растущих closes → `bias='up'`, `ema21h` число; падающих → `'down'`; пилы → `'flat'`; <22 closes → null.
8. `emaLast`: длина < period → null; на константном ряду == константе.
9. G-4: после мержа `sent.fearGreed` попадает в `formatSentiment` (чистый тест formatSentiment с fearGreed).
10. G-5: `buildGuardPrompt` возвращает version `risk-guard-v2` и user-payload с ключами idea/market/sentiment/news.
11. G-5: системный промпт НЕ содержит «widen the stop» (регрессия против возврата противоречия).
12. G-6: `parseGuardResponse` с 6 reasons → `ok:false`; с reasons[0] длиной 801 символ → `ok:false`; с пустым массивом → `ok:false`; валидный → `ok:true`.
13. G-6: `contextForIdea` возвращает только снапшот нужного символа + btc (формально: ключи `symbol`, `btc`; `symbol.symbol` совпадает с идеей).
14. `shouldSkipAutoEntry`: drift > refreshPct → skip.
15. `shouldSkipAutoEntry`: live за stopLoss (LONG) → skip; live за takeProfit → skip.
16. `shouldSkipAutoEntry`: drift в допуске и SL < live < TP → `skip:false`.
17. G-8: `validateIdeasWithMarket` отбрасывает идею по символу из `openPositions`.

Плюс paper A/B (1–2 недели) по метрикам: LLM-вызовов гварда/скан (ожидание −60%), входные токены/скан (−80–90%), approval rate, события `autotrade entry skipped`, `precheck rejected` reasons. Rollback — `git revert`, версии промптов зафиксированы (`scout-ideas-v4`, `risk-guard-v2`).

---

## G-10. Явно вне области Части 2

- `monitor.mjs`, `stopcheck.mjs`, `reflect.mjs`, `trailing.mjs` — следующее ТЗ (Monitor).
- Пороги `AUTO_CONFIDENCE`, `AUTO_MAX_POSITIONS`, `AUTO_RISK_PCT`, `AUTO_DAILY_LOSS_CAP_USD`, `APPROVE_SLIPPAGE_PCT`, `APPROVE_REFRESH_PCT` — только переиспользуются, не меняются.
- Дневной лимит убытка автотрейда существует (`AUTO_DAILY_LOSS_CAP_USD = 10`, bot.mjs ≈1194, ≈1208–1211), но хранится в памяти процесса и сбрасывается при рестарте — известное ограничение, фикс отдельным ТЗ.

---
---

# Часть 3 — Monitor (пакет monitor-v2)

**Контекст аудита (почему это нужно):**
1. **Stopcheck авто-закрывает реальные позиции по самооценке LLM.** В `runStopcheckPass` (bot.mjs ≈1464–1491): `shouldAutoClose = confidence ≥ 0.8 && (убыток ≥ $2/1% || ЛЮБОЙ профит)` → немедленный market-ордер, каждые 5 минут в фоне. Порог 0.8 — число, которое модель назначает сама, и промпт stopcheck **сообщает ей этот порог** («A confident CLOSE (≥0.8) may be auto-executed») — прямой стимул завышать. При этом шапка `stopcheck.mjs` утверждает «only PROPOSES a close (never executes)», а шапка `monitor.mjs` — «EXIT executed only after an explicit approve». Код противоречит задокументированной модели безопасности.
2. **LLM судит тренд, не видя данных.** И monitor, и stopcheck получают `market = {symbol, markPrice, bid, ask, kind}` — ни свечей, ни ATR, ни направления BTC. Stopcheck-правило 2 требует оценить «BTC is turning up» — BTC в инпуте отсутствует. Это структурное давление к галлюцинации разворотов; в связке с п.1 — к авто-закрытиям на выдуманном развороте. Парадокс: `runMonitorPass` уже качает свечи для ATR-трейлинга (bot.mjs ≈1057), но LLM их не получает.
3. **TRAIL в схеме monitor мёртв.** `parseMonitorResponse` принимает `TRAIL` + `newStop`, но `runMonitorPass` обрабатывает только `EXIT` — TRAIL молча выбрасывается. Движением стопа владеет детерминированный `trailing.mjs` (образцовый модуль: loss-only-narrowing, Wilder ATR, snap к тику) — и это правильно.
4. **Роли monitor и stopcheck пересекаются:** оба LLM-прохода (15 мин и 5 мин) могут предлагать закрытие одной позиции — дубли уведомлений, возможны противоречивые вердикты.

**Архитектурные решения (приняты аудитором, одобрены владельцем):**
- **Авто-закрытие сохраняется, но только при согласии кода и модели:** позиция в значимом убытке (код) + тренд против позиции (код, прекомпьют) + LLM голосует CLOSE (советник). Это сохраняет защиту «пока владелец спит» и устраняет галлюцинированные выходы.
- **Прибыльными позициями распоряжается детерминированный трейлинг/тейк** (уже реализован), а не LLM: авто-закрытие по `pnlUsd > 0` отменяется; любой CLOSE советника по прибыльной позиции — только кнопки.
- **LLM вызывается, только когда убыток уже значим** (код-гейт) — здоровый портфель не тратит токены каждые 5 минут.
- **Разведение ролей:** stopcheck = быстрая защита от убытка (code-first), monitor = медленный EXIT-советник по тезису (всегда кнопки). TRAIL уходит из LLM-схемы.
- **Пороги и гейты никогда не сообщаются модели в промпте.**

**Инварианты:** `trailing.mjs` НЕ меняется. Исполнение закрытий переиспользует существующие `closePosition`, `exitProposals`, кнопки `doexit/keepexit`. Логирование `log.execute`/`log.guard` сохраняется.

---

## M-1 (P1): Stopcheck — code-first гейтинг, LLM как советник

**Issue / Evidence / Trading impact:** см. контекст п.1 — автономное закрытие по самооценке модели, порог раскрыт в промпте, документация модуля лжёт.

**Proposed change (а)** — в `src/telegram/stopcheck.mjs` добавить чистые экспорты:

```js
/**
 * Pure gate: the LLM is consulted ONLY when the loss is already meaningful.
 * Healthy positions cost zero LLM tokens per tick.
 *
 * @param {{ lossMeaningful: boolean }} input
 * @returns {boolean}
 */
export function shouldConsultStopcheck({ lossMeaningful }) {
  return lossMeaningful === true;
}

/**
 * True when the precomputed trend bias points against the position side.
 *
 * @param {'LONG' | 'SHORT'} side
 * @param {'up' | 'down' | 'flat' | null | undefined} bias
 * @returns {boolean}
 */
export function isTrendAgainst(side, bias) {
  return (side === 'LONG' && bias === 'down') || (side === 'SHORT' && bias === 'up');
}

/**
 * Final stop-check decision. AUTO_CLOSE requires agreement of code AND model:
 * meaningful loss (code) + trend against (code) + model votes CLOSE (advisory).
 * Any other CLOSE is only proposed to the human.
 *
 * @param {{ llmAction: 'CLOSE' | 'HOLD', lossMeaningful: boolean, trendAgainst: boolean }} input
 * @returns {'AUTO_CLOSE' | 'PROPOSE_CLOSE' | 'HOLD'}
 */
export function decideStopcheckAction({ llmAction, lossMeaningful, trendAgainst }) {
  if (llmAction === 'CLOSE') {
    if (lossMeaningful && trendAgainst) return 'AUTO_CLOSE';
    return 'PROPOSE_CLOSE';
  }
  return 'HOLD';
}
```

**Proposed change (б)** — переписать `runStopcheckPass` (bot.mjs ≈1425–1532) по двухфазной схеме:

Фаза 1 (на позицию, БЕЗ LLM): live-цена → `pnlUsd`; `lossMeaningful` по СУЩЕСТВУЮЩИМ формулам (`pnlUsd <= -2` ИЛИ `|pnl| / (avgPrice × size) × 100 ≥ 1`); свечи `fetchKlines(pos.symbol, { interval: '60', limit: 30 })` → `trend = computeBtcBlock(compactCandles)` (нормализацию свечей см. M-2). Если `!shouldConsultStopcheck({ lossMeaningful })` → `results.push({ pos, action: 'HOLD', reason: 'loss not meaningful — LLM not consulted' })` и `continue`.

Между фазами: `gatherNews()` и BTC-блок (`fetchKlines('BTCUSDT', …)` → `computeBtcBlock`) запрашивать ОДИН раз за проход и ТОЛЬКО если есть хотя бы одна позиция, прошедшая гейт.

Фаза 2 (на прошедшую гейт позицию): LLM с обогащённым market (M-2) → `decideStopcheckAction({ llmAction, lossMeaningful, trendAgainst: isTrendAgainst(pos.side, trend?.bias) })`:
- `AUTO_CLOSE` → существующий `closePosition(...)` + `log.execute('stopcheck auto-closed', …)` (добавить в лог `lossMeaningful`, `trendBias`) + `notifyUser` (текст: «Авто-закрыл … код: убыток + тренд против, модель: CLOSE»);
- `PROPOSE_CLOSE` → существующий код кнопок (≈1493–1511) без изменений;
- `HOLD` → только лог.

Удалить старые вычисления `confident`/`shouldAutoClose` и ветку авто-закрытия по ним (≈1464–1491). `confidence` из ответа модели только логируется.

**Proposed change (в)** — обновить шапку `stopcheck.mjs`: модель безопасности теперь «auto-close ONLY when code (meaningful loss + trend against) and the model (CLOSE) agree; everything else is proposed via buttons». Шапка должна соответствовать коду — это часть дефекта.

**Why it is better:** исполнение требует независимого подтверждения двух разных природ (детерминированные числа + суждение модели); модель не знает порогов и не может «пробить» гейт самооценкой; прибыль не трогается без человека; токены тратятся только на проблемные позиции.

**Expected benefit:** ноль авто-закрытий без объективного основания в логе (`stopcheck auto-closed` всегда сопровождается `trendBias` + суммой убытка); стоимость фонового stopcheck ≈ 0 при здоровом портфеле. Метрики: события AUTO_CLOSE/PROPOSE_CLOSE, токены/сутки stopcheck.

**Potential downside:** «новостной» крах без технического подтверждения (тренд ещё не перевернулся) не закроется автоматически — уйдёт на кнопки. Осознанный компромисс: цена ложного срабатывания на реальных деньгах выше цены задержки одного прохода; трейлинг-стоп при этом продолжает работать.

**Validation plan:** кейсы M-6 (3–5); paper-прогон: каждое AUTO_CLOSE имеет код-подтверждение в логе.

**Approval required:** не применено.

---

## M-2 (P1): Реальные рыночные данные для LLM monitor/stopcheck

**Issue:** LLM судит «тезис сломан» и «BTC разворачивается» по одному тикеру цены — без свечей, ATR, тренда символа и BTC (контекст п.2).

**Proposed change:** единый market-объект позиции для обоих проходов:

```js
market = {
  symbol: pos.symbol,
  markPrice,           // live
  bid, ask,
  kind: pos.kind,
  atr14h,              // число или null
  trend,               // computeBtcBlock(compact) этого символа: {lastPrice, ema21h, change4hPct, bias} или null
  btc,                 // computeBtcBlock(btcCandles) — один раз за проход
  candles: compact,    // последние 30 часовых {o,h,l,c,v}, oldest first
};
```

Детали реализации:
- `fetchKlines` возвращает строки-МАССИВЫ (computeATR обращается по индексам) — исполнитель обязан проверить форму и нормализовать: `const compact = rows.map((k) => ({ o: k[0], h: k[1], l: k[2], c: k[3], v: k[4] }))`. `computeBtcBlock` из G-2 принимает `{c}`-объекты и универсален (используется как тренд-блок любого символа).
- В `runMonitorPass` НЕ делать второй запрос свечей: переиспользовать `candles`, уже загружаемые для ATR (bot.mjs ≈1057).
- `atr14h` в runMonitorPass уже вычисляется (`computeATR`); в stopcheck вычислить тем же вызовом.
- Позиция в промпт уходит с полями `{symbol, side, avgPrice, markPrice, stopLoss, takeProfit, unrealisedPnl, leverage, kind}` (как сейчас, плюс markPrice — уже добавляется).

**Why it is better:** устраняется класс отказов «модель обязана судить о данных, которых нет» (мастер-промпт §5A); прекомпьют-блоки — те же, что у Scout/Guard, единый словарь системы.

**Expected benefit:** вердикты EXIT/CLOSE со ссылкой на конкретику (bias, уровни), а не общие фразы; меньше ложных предложений закрытия. Метрика: доля reason, содержащих числа/уровни; частота PROPOSE_CLOSE за неделю (ожидание: вниз).

**Potential downside:** +2 API-вызова свечей за stopcheck-проход (символ + BTC) и рост входных токенов LLM-проходов — окупается гейтом M-1 (LLM вызывается редко).

**Validation plan:** кейс M-6 (6); ручной `/stopcheck` и `/monitor` — проверить, что reason ссылается на bias/уровни.

**Approval required:** не применено.

---

## M-3 (P1): Monitor — только HOLD/EXIT советник (TRAIL удалён из схемы)

**Issue:** `TRAIL` + `newStop` парсятся, но нигде не применяются (контекст п.3); парсер не проверяет геометрию `newStop`.

**Proposed change (а)** — `src/telegram/monitor.mjs`, в `parseMonitorResponse`: допустимые действия — только `HOLD` и `EXIT`; поле `newStop` удалить из разбора и из результата; обновить JSDoc. Поведение fail-closed: старый ответ с `TRAIL` станет parse error → позиция останется на детерминированном трейлинге (безопасный дефолт) и запишется в лог.

**Proposed change (б)** — обновить шапку `monitor.mjs`: монитор рекомендует HOLD/EXIT; стопами и тейками владеет `trailing.mjs`.

**Proposed change (в)** — `runMonitorPass`: ветка обработки решения остаётся только для `EXIT` (существующий код кнопок ≈1156–1173); явный `HOLD` — ничего не делать (как сейчас).

**Why it is better:** схема перестаёт обещать действие, которое система не исполняет; единственный владелец стопа — детерминированный модуль, который никогда не расширяет стоп против позиции.

**Expected benefit / downside:** нулевая двусмысленность; минус — LLM больше не может предложить «подтянуть стоп под уровень» вне ATR-логики (осознанно: цена ошибки выше цены упущенной оптимизации).

**Validation plan:** кейсы M-6 (1–2).

**Approval required:** не применено.

---

## M-4 (P2): Новые промпты `monitor-v2` и `stopcheck-v2`

**Proposed change** — `src/telegram/monitor.mjs`:

```js
export const MONITOR_PROMPT_VERSION = 'monitor-v2';

const MONITOR_SYSTEM_PROMPT = [
  'You are a position guardian inside a deterministic trading system. Review ONE open trade and decide whether the original thesis still holds.',
  'Trailing stops and take-profits are managed by code — you NEVER touch prices. Your only question: HOLD or EXIT.',
  'Respond with ONLY a JSON object: {"action":"HOLD"|"EXIT","reason":"one short concrete sentence","confidence":0..1}',
  'You receive: the position {symbol, side, avgPrice, markPrice, stopLoss, takeProfit, unrealisedPnl, leverage, kind}, a market snapshot for that symbol (lastPrice, bid, ask, the last 30 HOURLY candles oldest-first as {o,h,l,c,v}, atr14h, a precomputed trend block {ema21h, change4hPct, bias}), a precomputed BTC block {bias}, and recent news headlines.',
  'Rules:',
  '- HOLD: the thesis is intact; normal open-PnL noise is NOT a reason to exit.',
  '- EXIT: the thesis is broken — the precomputed trend bias has flipped against the position AND the candles confirm (broken swing, failed retest), or adverse news with clear continuation risk. Name the evidence (bias, level, headline) in the reason.',
  '- A human reviews every EXIT before execution — recommend it only when you would defend it with numbers.',
  '- Use ONLY the data provided; never invent prices, indicators or news. If the data is insufficient, HOLD and say so.',
].join('\n');
```

**Proposed change** — `src/telegram/stopcheck.mjs`:

```js
export const STOPCHECK_PROMPT_VERSION = 'stopcheck-v2';

const STOPCHECK_SYSTEM_PROMPT = [
  'You are a fast loss-protection reviewer inside a deterministic trading system. Code has already detected a position in meaningful loss; you decide whether the loss is likely to grow (CLOSE) or is normal volatility inside the prevailing trend (HOLD). You never touch prices.',
  'Respond with ONLY a JSON object: {"action":"CLOSE"|"HOLD","reason":"one short concrete sentence","confidence":0..1}',
  'You receive: the position {symbol, side, avgPrice, markPrice, stopLoss, takeProfit, unrealisedPnl, leverage, kind}, the last 30 HOURLY candles of that symbol (oldest first, {o,h,l,c,v}), atr14h, a precomputed trend block {ema21h, change4hPct, bias}, a precomputed BTC block {bias}, and news headlines.',
  'Decide CLOSE when the evidence says the move AGAINST the position continues:',
  '- the precomputed trend bias is against the position AND the candles confirm (broken swing, momentum continuation), or',
  '- adverse news plausibly extends the move against the position — name the headline.',
  'For alt positions, weigh the BTC block explicitly: an alt LONG with BTC bias=down is at risk; an alt SHORT with BTC bias=up is at risk. Name the BTC bias in your reason.',
  'Decide HOLD when the loss looks like normal noise inside the prevailing trend: the trend block is not against the position, price still respects the key swing, no adverse news.',
  'confidence: how sure you are (0.5 = coin flip, 0.9 = unambiguous). It is logged for review only.',
  'Use ONLY the data provided. If data/news is insufficient, HOLD and say so.',
].join('\n');
```

Ключевые отличия v2: словарь данных (свечи/trend/BTC); никаких порогов авто-исполнения в тексте; stopcheck знает, что убыток уже подтверждён кодом, и решает только «растёт или шум»; monitor знает, что стопы — не его зона. Парсер stopcheck НЕ меняется (схема ответа прежняя).

**Validation plan:** кейсы M-6 (7–8).

**Approval required:** не применено.

---

## M-5 (P3): Гигиена уведомлений в фоновых проходах

**Issue:** фоновой monitor каждые 15 минут шлёт «Мониторинг начался/окончен», при пустом портфеле — «ИИ не запускался». Ночью это спам, размывающий важные сообщения (сдвиг стопа, предложение EXIT, авто-закрытие).

**Proposed change:** в `runMonitorPass` добавить параметр `{ background = false }`; цикл (bot.mjs ≈1654) вызывает `runMonitorPass(true, { background: true })`, команда `/monitor` — как раньше. В режиме background НЕ отправлять: «Мониторинг начался», «Мониторинг окончен», «Нет открытых позиций…»; отправлять ТОЛЬКО события: сдвиг стопа/тейка, предложение EXIT, ошибки прохода. Аналогично stopcheck: сводка в фоне уже условная (`closeCount > 0`) — оставить; в background при `results` без событий не слать ничего (текущее поведение сохранить).

**Expected benefit:** ночной поток сообщений = только actionable-события.

**Validation plan:** кейс M-6 (9) — юнит на формирование списка уведомлений вынести в чистую функцию `shouldNotifyBackground(event)` либо проверить ручным прогоном с эмуляцией.

**Approval required:** не применено.

---

## M-6. План валидации Части 3 — `test/telegram-monitor.test.mjs`

Кейсы (`node:test`, `assert/strict`):

1. `parseMonitorResponse`: `{"action":"HOLD",…}` и `{"action":"EXIT",…}` → `ok:true`, в результате нет `newStop`.
2. `parseMonitorResponse`: `{"action":"TRAIL","newStop":123,…}` → `ok:false` (регрессия: мёртвое действие удалено); пустой `reason` → `ok:false`.
3. `shouldConsultStopcheck`: `lossMeaningful:false` → `false` (LLM не вызывается).
4. `isTrendAgainst`: LONG/down → true; LONG/up → false; SHORT/up → true; SHORT/flat → false.
5. `decideStopcheckAction`: CLOSE+loss+trendAgainst → `AUTO_CLOSE`; CLOSE+loss+!trendAgainst → `PROPOSE_CLOSE`; CLOSE+!loss → `PROPOSE_CLOSE`; HOLD → `HOLD`.
6. `buildMonitorPrompt`/`buildStopcheckPrompt`: версии `monitor-v2`/`stopcheck-v2`; user-payload содержит position/market/news.
7. `MONITOR_SYSTEM_PROMPT` НЕ содержит «TRAIL» и «newStop».
8. `STOPCHECK_SYSTEM_PROMPT` НЕ содержит «0.8», «auto-execut» (регрессия против раскрытия порогов модели).
9. M-5: фоновая логика уведомлений — вынести чистую функцию и покрыть кейсами (событие → true, тишина → false).

Плюс paper-валидация (1–2 недели, параллельно с Частями 1–2): каждое AUTO_CLOSE сопровождается код-основанием в логе; число PROPOSE_CLOSE/неделю не растёт; токены stopcheck/сутки при здоровом портфеле ≈ 0; ночные уведомления — только событийные.

---

## M-7. Явно вне области Части 3

- `trailing.mjs` — не меняется (эталонный детерминированный модуль).
- Персистентность `prevPositions`/`reflected` (bot.mjs ≈988–1011, в памяти процесса: рестарт → повторный/пропущенный триггер рефлектора) — переносится в ТЗ Reflector.
- Пороги убытка stopcheck ($2 / 1% ношенала) — переиспользуются как есть; изменение — отдельной командой владельца.
- Reversal-логика (переворот позиции) — не вводится.

---
---

# Часть 4 — Reflector (пакет reflect-v2)

**Контекст аудита (почему это нужно):**
1. **6 из 6 реальных рефлексий — эхо одной фразы.** `data/telegram/rules.pending.md`: все записи повторяют «position disappeared between monitor passes, indicating a monitoring/state-tracking gap» с почти идентичным proposedRule. Механика дефекта верифицирована: (а) входное поле `reason` буквально содержит эту формулировку ('closed (holding disappeared between monitor passes)', bot.mjs ≈998) — модель попугайничает инпут; (б) рефлектор не получает ни причины закрытия (стоп/тейк/ручное), ни фактических чисел закрытия; (в) `matchedExistingRule` по построению не может работать — существующие правила модели не показываются, поле выдумывается.
2. **Устаревшие числа вместо факта закрытия.** Путь «исчезла между проходами» (bot.mjs ≈988–1001) передаёт в `reflectClosedTrade` `avgPrice/markPrice/unrealisedPnl` ПРОШЛОГО прохода монитора (до 15 минут давности) — нереализованные значения, а не цена/PnL фактического закрытия. Те же числа складываются в `autoDailyLossUsd` (≈943) — дневной лимит −$10 считается по неточным данным. Более того, туда складываются убытки ЛЮБЫХ закрытий, включая ручные сделки владельца (≈1614), — ручной убыток может остановить автотрейд.
3. **Дедуп слишком грубый и только в памяти.** `reflected` keyed `${symbol}:${side}` (≈937–939): после первой рефлексии по BTCUSDT:LONG все последующие сделки по нему НЕ рефлексируются до рестарта; рестарт — и всё рефлексируется повторно. `prevPositions`, `autoDailyLossUsd`, `autoOpenedSymbols` тоже в памяти: рестарт сбрасывает дневной лимит и счётчик авто-позиций.
4. **Потребления нет:** `rules.pending.md` только пишется; `severity` без рубрики (6/6 — medium, поле бесполезно).

**Архитектурные решения (приняты аудитором, одобрены владельцем):** атрибуция причины закрытия и фактических чисел через closed-pnl API биржи; отказ от рефлексии по догаданным числам (fail-closed); персистентное состояние процесса с дневным сбросом по ДАТЕ; grounded dedup (модель видит существующие правила); severity-рубрика. Файл правил остаётся markdown, применение — только человеком (автоприменение запрещено навсегда).

---

## R-1 (P1): Атрибуция закрытия и фактические числа вместо устаревшего снапшота

**Issue / Evidence:** контекст п.1–2: рефлексии анализируют «disappeared» вместо реального закрытия; числа — прошлого прохода.

**Proposed change (а)** — `src/telegram/execute.mjs` (рядом с `fetchOpenPositions`, ≈394) добавить:

```js
/**
 * Latest realized closed-PnL record for a linear symbol (Bybit
 * /v5/position/closed-pnl). Returns null on any failure — callers must treat
 * null as "do not reflect on guessed numbers".
 *
 * @param {{ apiKey: string, apiSecret: string }} credentials
 * @param {string} symbol
 * @returns {Promise<{ symbol: string, side: string, entryPrice: number|null, exitPrice: number|null, realizedPnlUsd: number|null, closedSize: number|null, closedAt: string, recordId: string } | null>}
 */
export async function fetchRecentClosedPnl(credentials, symbol) { /* GET /v5/position/closed-pnl?category=linear&symbol=<symbol>&limit=1, нормализовать поля avgEntryPrice/avgExitPrice/closedPnl/closedSize/updatedTime; recordId = orderId ?? `${symbol}:${updatedTime}` */ }
```

**Proposed change (б)** — `src/telegram/reflect.mjs`, чистый экспорт:

```js
/**
 * Infer the exit cause by comparing the actual exit price with the position's
 * last known SL/TP. 'unknown' whenever the inputs are insufficient — never guess.
 *
 * @param {{ side: 'LONG'|'SHORT', exitPrice: number, stopLoss?: number|null, takeProfit?: number|null, tolerancePct?: number }} input
 * @returns {'stop' | 'target' | 'external' | 'unknown'}
 */
export function inferExitCause({ side, exitPrice, stopLoss = null, takeProfit = null, tolerancePct = 0.15 }) {
  const near = (a, b) => typeof a === 'number' && typeof b === 'number' && b > 0
    && (Math.abs(a - b) / b) * 100 <= tolerancePct;
  if (!Number.isFinite(exitPrice) || exitPrice <= 0) return 'unknown';
  if (near(exitPrice, stopLoss)) return 'stop';
  if (near(exitPrice, takeProfit)) return 'target';
  if (stopLoss == null && takeProfit == null) return 'unknown';
  return 'external';
}
```

**Proposed change (в)** — переписать phantom-путь в `runMonitorPass` (bot.mjs ≈988–1001): при исчезновении позиции сначала `fetchRecentClosedPnl({ apiKey, apiSecret }, prev.symbol)`; при `null` → `log.market('close attribution unavailable — reflection skipped', …)` и НЕ рефлексировать; при успехе:

```js
await reflectClosedTrade({
  symbol: prev.symbol,
  side: prev.side,
  entry: rec.entryPrice ?? prev.avgPrice,
  exit: rec.exitPrice ?? prev.markPrice,
  pnlUsd: rec.realizedPnlUsd ?? 0,
  reason: `closed on exchange (cause: ${inferExitCause({ side: prev.side, exitPrice: rec.exitPrice, stopLoss: prev.stopLoss ?? null, takeProfit: prev.takeProfit ?? null })})`,
  closedId: rec.recordId,
});
```

`prevPositions` при этом должен сохранять также `stopLoss`/`takeProfit` позиции (добавить в snapshot ≈1003–1011). Для СПОТ-холдов closed-pnl API не существует → phantom-рефлексию по споту пропускать с логом (ручные выходы уже покрыты doexit-путём с живыми числами, ≈1614).

**Proposed change (г)** — починить учёт дневного убытка: в `reflectClosedTrade` (≈940–945) суммировать ТОЛЬКО реализованный убыток АВТО-позиций и ДО удаления символа из `autoOpenedSymbols`:

```js
const counted = autoOpenedSymbols.has(closed.symbol);
const pnl = Number(closed.pnlUsd) || 0;
if (pnl < 0 && counted) autoDailyLossUsd += pnl;
autoOpenedSymbols.delete(closed.symbol);
```

**Why it is better:** рефлектор анализирует факт (реализованный PnL после комиссий, фактическая цена выхода, причина), а не эхо собственного инпута; дневной лимит перестаёт считаться по стale/чужим числам.

**Expected benefit:** конец серии одинаковых «monitoring gap» рефлексий; корректный −$10/день. Метрика: доля рефлексий с `exitCause != 'unknown'`; разнообразие lesson.

**Potential downside:** при недоступности closed-pnl API рефлексии по phantom-закрытиям пропускаются — осознанно (fail-closed на качестве данных); ручной путь doexit продолжает писать рефлексии.

**Validation plan:** кейсы R-5 (1–3).

**Approval required:** не применено.

---

## R-2 (P1): Персистентное состояние процесса (дневной лимит, дедуп, снапшоты позиций)

**Issue:** `autoDailyLossUsd`, `autoOpenedSymbols`, `prevPositions`, `reflected` живут в памяти (bot.mjs ≈907–915, ≈939): рестарт сбрасывает дневной лимит и дедуп, теряет трекинг позиций.

**Proposed change (а)** — новый модуль `src/telegram/state.mjs`:

```js
// Атомарная персистентность: write tmp + rename. Never throws (fail-silent с логом).
// Shape:
// {
//   day: 'YYYY-MM-DD',                 // UTC-день; при смене — daily-счётчики обнуляются
//   autoDailyLossUsd: number,
//   autoOpenedSymbols: string[],
//   reflectedCloseIds: string[],       // последние ≤500 recordId закрытий
//   prevPositions: { 'kind:symbol': { symbol, side, avgPrice, markPrice, stopLoss, takeProfit, unrealisedPnl, firstSeenAt } },
// }
export async function loadState(file = 'data/telegram/state.json') { /* чтение + валидация shape; при отсутствии/битости — дефолт; при смене day — сброс autoDailyLossUsd */ }
export async function saveState(state, file = 'data/telegram/state.json') { /* mkdir -p → write tmp → rename */ }
```

**Proposed change (б)** — `bot.mjs`: в `main()` при старте `state = await loadState()` и гидратация in-memory переменных; `saveState` после каждой мутации (вход автотрейда, `reflectClosedTrade`, обновление `prevPositions` в конце monitor-прохода). Дедуп рефлексий перевести с `${symbol}:${side}` на `reflectedCloseIds` (recordId из R-1); для ручного doexit — recordId = orderId закрывающего ордера. Кольцевой буфер: хранить последние 500 id.

**Why it is better:** дневной лимит сбрасывается по дате, а не по рестарту; дедуп переживает рестарт и больше не блокирует рефлексии навсегда; потерянные между проходами закрытия атрибутируются корректно после рестарта.

**Expected benefit / downside:** +1 файл состояния и дисциплина save-on-mutate; при битом файле — безопасный дефолт (fail-silent). Метрика: после рестарта `autoDailyLossUsd` совпадает с до-рестартным.

**Validation plan:** кейсы R-5 (4–6).

**Approval required:** не применено.

---

## R-3 (P2): Обогащение входа рефлектора, grounded dedup, severity-рубрика, промпт `reflect-v2`

**Issue:** модель не видит существующих правил (matchedExistingRule выдуман), не имеет причины/длительности/фактических чисел; severity без рубрики; дедуп не работает (6 одинаковых правил подряд).

**Proposed change (а)** — `reflectClosedTrade` (bot.mjs ≈936) перед вызовом читает хвост `data/telegram/rules.pending.md` (последние 20 строк, fail-silent) и передаёт в reflect:

```js
const input = { ...closed, holdMinutes: <из prevPositions.firstSeenAt, иначе null>, existingRules: <tail text или null> };
```

**Proposed change (б)** — `src/telegram/reflect.mjs`, новый промпт (версия зафиксировать константой `REFLECT_PROMPT_VERSION = 'reflect-v2'`):

```js
const REFLECT_SYSTEM_PROMPT = [
  'You review ONE closed trade and propose a small, concrete rule improvement for a trading system.',
  'Respond with ONLY a JSON object: {"lesson":"one sentence","proposedRule":"short concrete rule or empty string","severity":"high"|"medium"|"low","matchedExistingRule":true|false}',
  'You receive: the trade {symbol, side, entry, exit, realized pnlUsd, exitCause ("stop"|"target"|"external"|"unknown"), holdMinutes when known} and the CURRENT pending rules.',
  'Rules:',
  '- Ground every number in the input. Never invent prices, durations or causes. If exitCause explains the close (a normal stop or target), say so — not every closed trade needs a rule; then proposedRule = "".',
  '- If the lesson repeats one of the CURRENT pending rules, set matchedExistingRule=true and proposedRule="".',
  '- severity: high = a concrete system rule was violated, with numbers; medium = an actionable, repeatable pattern; low = noise or a single observation.',
  '- Propose only rules that are checkable by code or by a prompt instruction. No strategy redesigns.',
].join('\n');
```

User-payload: `JSON.stringify({ trade: input, existingRules })`.

**Proposed change (в)** — дедуп при записи: в `reflect()`/`reflectClosedTrade`, если `matchedExistingRule === true && proposedRule === ''` → НЕ писать в файл, `log.guard('reflection skipped (duplicate)', …)`.

**Why it is better:** дедуп получает реальную опору (модель видит правила); файл наполняется разными, проверяемыми предложениями; severity становится сигналом для человека-ревьюера.

**Expected benefit / downside:** повторные записи исчезают (ожидание: rules.pending.md растёт медленнее и разнообразнее); риск — модель ошибочно пометит дубль как новый (не критично, человек ревьюит).

**Validation plan:** кейсы R-5 (7–9).

**Approval required:** не применено.

---

## R-4 (P3): Путь потребления правил человеком — `/rules`

**Issue:** `rules.pending.md` write-only; без чтения в Telegram файл бесполезен.

**Proposed change:** команда `/rules` — показать последние 20 строк pending-файла (или «пусто»); `/rules applied` — переименовать pending в `rules.applied-<date>.md` и начать новый (фиксация ревью). Автоприменение правил в код/промпты НЕ добавлять никогда.

**Expected benefit:** цикл «исход → урок → правило → ревью» замыкается человеком за 30 секунд.

**Validation plan:** ручной прогон команды; кейс R-5 (10) на форматирование вывода — по желанию.

**Approval required:** не применено.

---

## R-5. План валидации Части 4 — `test/telegram-reflect.test.mjs`

1. `inferExitCause`: exit≈SL → 'stop'; exit≈TP → 'target'; далеко от обоих → 'external'; без SL/TP → 'unknown'; невалидная цена → 'unknown' (LONG и SHORT).
2. R-1в: ручной убыток (символ вне `autoOpenedSymbols`) НЕ меняет `autoDailyLossUsd`; авто-убыток — меняет (чистая функция-редьюсер, вынести для теста).
3. Phantom-путь: `fetchRecentClosedPnl` → null ⇒ рефлексия не вызывается (мок fetch).
4. `loadState`: отсутствующий файл → дефолт; битый JSON → дефолт; смена `day` → `autoDailyLossUsd` сброшен, остальное сохранено.
5. `saveState`→`loadState` round-trip на tmp-файле; буфер `reflectedCloseIds` обрезается до 500.
6. Дедуп: повторный `recordId` не пишется; новый — пишется.
7. R-3в: `matchedExistingRule=true` + пустой `proposedRule` → файл не пополняется (skip с логом).
8. Промпт: `REFLECT_SYSTEM_PROMPT` содержит severity-рубрику и «Never invent»; версия `reflect-v2`.
9. `reflect()`: severity вне enum → 'low' (регрессия существующего поведения).
10. `/rules`: форматирование вывода (если вынесено в чистую функцию).

Плюс paper-наблюдение (2 недели): rules.pending.md — доля дублей ≈ 0, разнообразие lesson, доля exitCause='unknown' < 20%; после рестарта бота дневной лимит и дедуп сохраняются.

---

## R-6. Явно вне области Части 4

- Автоприменение правил к промптам/коду — запрещено навсегда (человек-в-контуре).
- Изменение стратегических параметров по рефлексиям — только через полное ТЗ с бэктестом.
- MFE/MAE-аналитика (нет тиковой истории) — отдельный проект данных.
- Backtest-harness для правил — вне этого MVP.

---
---

# Часть 5 — Наблюдаемость и shadow-валидация порога автотрейда

**Контекст аудита (почему это нужно):**
1. **Пробел наблюдаемости (верифицирован):** `runAutoScan` НЕ пишет в pipeline.jsonl ни scout-ответ, ни per-idea вердикты гварда — ночные авто-сканы оставили только строку `no setup ≥ 0.75` в stderr. Вопрос владельца «почему автотрейд не вошёл» требовал ручного расследования вместо одной команды. В потоке `/trade` логирование полное — перенести тот же паттерн.
2. **Вопрос порога AUTO_CONFIDENCE=0.75 требует данных, а не догадки.** Ретроспективный what-if по логу СТАРОЙ системы (114 одобренных идей, исход через 24ч по свечам Bybit, комиссия 0.11%): бин ≥0.75 → expectancy −0.415R (n=50), бин 0.60–0.75 → +0.303R (n=51), бин <0.60 → +0.660R (n=13). Старая шкала анти-калибрована, но новая (risk-guard-v2) имеет n=3 — менять порог НЕЛЬЗЯ по этим данным (режим + чужая шкала). Нужен чистый замер новой шкалы — shadow-режим.

**Инварианты:** shadow-режим НЕ исполняет ордера и НЕ вызывает LLM — только записывает уже сделанные вердикты и дочитывает публичные свечи. Порог `AUTO_CONFIDENCE` НЕ меняется этой частью: пересмотр порога — отдельное решение владельца по отчёту shadow при n≥30 на бин.

---

## P-1 (P1): Логирование авто-сканов наравне с `/trade`

**Issue:** в `runAutoScan` нет `log.scout`/`log.guard` per idea — авто-путь слепой в pipeline.jsonl.

**Proposed change** (`src/telegram/bot.mjs`, `runAutoScan`):
- После `generateIdeas` — тот же `log.scout('scout response', { symbolsSeen, ok, ideaCount, issues, raw })`, что в `/trade` (≈343).
- В цикле гварда — `log.guard('guard verdict', { symbol, side, verdict, reasons, raw })` для КАЖДОЙ идеи (и для precheck-отказов — уже есть).
- Итог скана: `log.guard('autotrade scan summary', { ideas, survivors: n, topConfidence })`.

**Expected benefit:** любой вопрос «почему не вошёл» отвечается из лога без расследования; питает `/perf` (P-3).

**Validation plan:** кейс P-4 (1).

**Approval required:** не применено.

---

## P-2 (P1): Shadow-трекер — честный замер идей ниже порога, без ордеров и без LLM

**Issue:** порог 0.75 нечем калибровать: фактических входов мало, а исходы отклонённых по confidence идей нигде не записываются.

**Proposed change (а)** — новый модуль `src/telegram/shadow.mjs`:

```js
// Shadow tracker: записывает guard-APPROVED идеи НИЖЕ порога авто-входа как
// ГИПОТЕТИЧЕСКИЕ входы и через 24h выставляет исход по публичным 1h-свечам.
// Никаких ордеров, никаких LLM-вызовов. Методика идентична аудиторскому
// what-if (docs: раздел P-2): fill по цене entry; TP-первым = win (+R за вычетом
// комиссии), SL-первым = loss (−1R), одна свеча бьёт оба = пессимистично loss;
// ни одного за 24h = mark-to-close в R. Комиссия 0.11% round-trip от ношенала.

export const SHADOW_FILE = 'data/telegram/shadow.jsonl';
export const SHADOW_BAND = { min: 0.55, max: 0.75 }; // [min, max) — подпороговая полоса
export const SHADOW_HORIZON_MS = 24 * 60 * 60 * 1000;

/** Append a hypothetical entry. Dedup: same symbol+side within 4h is skipped. */
export async function appendShadow({ ts, symbol, side, conf, entry, stopLoss, takeProfit }, file = SHADOW_FILE) {}

/** Resolve open hypotheses older than 24h using public 1h klines (fetchKlines-подобный доступ передаётся параметром). Returns count resolved. */
export async function resolveShadowOutcomes({ fetchCandles, file = SHADOW_FILE, now = Date.now() }) {}

/** Band report: per confidence bin {n, winRate, expectancyR, readyN} over resolved rows. */
export function shadowBandReport(rows, bins = [[0.55, 0.65], [0.65, 0.75], [0.75, 1.01]]) {}
```

Формат строки shadow.jsonl: `{ts, symbol, side, conf, entry, stopLoss, takeProfit, status: 'open' | 'win' | 'loss' | 'flat24', outcomeR: number|null, resolvedAt: string|null}`.

**Proposed change (б)** — интеграция в `bot.mjs`:
- В `runAutoScan` (после сортировки survivors/отказов): для КАЖДОЙ guard-APPROVED идеи с `conf` в `SHADOW_BAND` → `appendShadow(...)` (не только для top-1!). Также в потоке `/trade` после цикла вердиктов (≈388–394) — те же appendShadow для одобренных в полосе.
- Разрешение гипотез: в конце `runMonitorPass` (уже есть 15-мин тик) вызывать `resolveShadowOutcomes({ fetchCandles: (s, startMs) => fetchKlines(s, { interval: '60', limit: 26, start: startMs }) })`. Fail-silent.
- В `/perf` (P-3) — раздел shadow: бины × (n, winRate, expectancyR); пометка `ready` когда n≥30.

**Why it is better:** решение о пороге через 3–6 недель будет опираться на n≥30 свежих исходов НОВОЙ системы в ТЕКУЩЕМ режиме рынка — вместо переноса анти-калиброванной старой шкалы. Ноль риска: денег не касается, LLM не вызывает.

**Expected benefit / downside:** +1 data-файл, +1 публичный kline-вызов на резолв (дешево); дедуп 4ч против дублей по одному символу.

**Validation plan:** кейсы P-4 (2–6).

**Approval required:** не применено.

---

## P-3 (P2): Команда `/perf` — дайджест производительности и отказов

**Proposed change** (`src/telegram/bot.mjs`): команда `/perf` — читает `data/telegram/pipeline.jsonl` + `data/telegram/shadow.jsonl` и отвечает компактным дайджестом:

```
📊 Perf за 7д
Сделки: входов X · закрыто Y · realized PnL $Z (win rate W%, avg win $a / avg loss $b)
Авто-сканы 24ч: N · no-setup: n1 · precheck-отказы по причинам: anti-chase x, BTC-cluster y, R/R z
Гвард 24ч: APPROVED a (conf медиана m) / REJECTED r
Shadow (всего): [0.55–0.65) n=.. win ..% exp ..R · [0.65–0.75) n=.. win ..% exp ..R (ready при n≥30)
```

Реализация: чистый парсер-агрегатор `buildPerfReport({ pipelineLines, shadowRows, now })` (в `shadow.mjs` или отдельном `perf.mjs` — выбор исполнителя, предпочтение чистой функции для тестов) + тонкий хендлер команды. Realized PnL — из записей `stopcheck auto-closed`/`exit executed`/`reflection written` (приоритет: realized из closed-pnl записей R-1; при отсутствии — пропустить блок с пометкой).

**Expected benefit:** видимость без аудитора; дисциплина «не судить по одной сделке» поддержана числами.

**Validation plan:** кейс P-4 (7).

**Approval required:** не применено.

---

## P-4. План валидации Части 5 — `test/telegram-shadow.test.mjs`

1. P-1: после авто-скана в pipeline.jsonl есть `scout response` и per-idea `guard verdict` (интеграционно, по мокам логгера).
2. `appendShadow`: запись строки; дедуп — повтор той же symbol+side внутри 4ч не пишется.
3. `resolveShadowOutcomes`: синтетические свечи — TP-первым → status 'win', outcomeR>0; SL-первым → 'loss', outcomeR≈−1R−комиссия; одна свеча бьёт оба уровня → 'loss' (пессимистично); нет касания за 24ч → 'flat24' со знаком mark-to-close; незрелая гипотеза (<24ч) не трогается.
4. Комиссия: outcomeR win'а меньше gross-R на величину fee-R (проверка формулы).
5. `shadowBandReport`: корректные бины, n, winRate, expectancyR; флаг ready при n≥30.
6. Fail-silent: битый shadow.jsonl / ошибка fetchCandles не роняют monitor-проход.
7. `buildPerfReport`: на фикстуре pipeline+shadow — корректные счётчики сделок, причин отказов и бинов.

Методологические инварианты (обязательны к сохранению в коде и тестах): fill по entry; ambiguous → loss; комиссия 0.11%; горизонт 24ч; исход считается ТОЛЬКО по свечам после ts гипотезы.

---

## P-5. Явно вне области Части 5

- Изменение `AUTO_CONFIDENCE` (0.75) — только отдельным решением владельца по shadow-отчёту при n≥30/бин.
- Реальные (не гипотетические) входы по подпороговым идеям — запрещены этой частью.
- Walk-forward/backtest полной стратегии — отдельный проект.

---
---

# Часть 6 — Защита открытой прибыли (profit lock)

**Контекст (наблюдение владельца, подтверждено логикой кода):** позиции неоднократно уходят из открытого плюса в стоп: «4 позиции по +$2 → потом разворот → все по стопу, суммарно −$20 за серию эпизодов; утром корзина была +$10, к вечеру ноль/минус». Корень верифицирован в коде: трейлинг активируется при ходе +0.8% (`TRAIL_ACTIVATION_PCT`), но кандидат стопа = `markPrice − 2×ATR` — при типичном ATR(1h) ≈ 0.5% стоп после активации остаётся **ниже входа** (entry + 0.8% − 1.0% = entry − 0.2%). Открытая прибыль не защищена, пока ход не станет большим. Для малого депозита (~$560, риск $5.6 = 1%) это систематическая утечка.

**Архитектурное решение (одобрено владельцем):** оба эшелона — чистый детерминированный код, БЕЗ LLM (LLM-закрытие прибыли убрано в M-1 и не возвращается). Известная цена: больше «нулевых» сделок и обрезанные победители в трендовые дни — осознанный профиль под цель владельца (малый депозит, защита от отдачи прибыли важнее упущенного хвоста). Контрольная метрика: give-back (пик open PnL vs закрытый PnL) через будущий `/perf` (P-3).

---

## L-1 (P1): Безубыток+комиссия на позицию — стоп не ниже entry после активации

**Issue / Evidence:** см. контекст: после хода ≥ +0.8% стоп остаётся под водой ≈ −0.2%…−1.8% от входа; прибыль испаряется до срабатывания трейлинга выше входа.

**Proposed change (а)** — в `src/telegram/trailing.mjs` добавить чистый экспорт (существующие функции НЕ меняются):

```js
export const LOCK_FEE_BUFFER_PCT = 0.15; // taker round-trip ~0.11% + буфер проскальзывания

/**
 * Breakeven-plus lock. Once price traveled >= activationPct in favor, the stop
 * must never sit below entry + fee buffer (LONG) / entry - fee buffer (SHORT).
 * Locking exactly at entry is forbidden: fees would make the "breakeven" a loss.
 * Only ever narrows the stop — never widens it.
 *
 * @param {{ side: 'LONG'|'SHORT', entryPrice: number, currentStop: number, markPrice: number, activationPct?: number, feeBufferPct?: number }} input
 * @returns {{ locked: boolean, stop: number, reason: string }}
 */
export function applyProfitLock({ side, entryPrice, currentStop, markPrice, activationPct = 0.8, feeBufferPct = LOCK_FEE_BUFFER_PCT }) {
  // travel% in favor (как в computeTrailingStop); если < activationPct → { locked:false, stop: currentStop }
  // floor = entryPrice * (1 + feeBufferPct/100) для LONG; entryPrice * (1 - feeBufferPct/100) для SHORT
  // LONG: stop = max(currentStop, floor); locked = stop > currentStop
  // SHORT: stop = min(currentStop, floor); locked = stop < currentStop
}
```

**Proposed change (б)** — интеграция в `runMonitorPass` (`src/telegram/bot.mjs`): ПОСЛЕ существующего `computeTrailingStop` и ПЕРЕД `snapTrailingPrice`: `stop = applyProfitLock({...}).stop` — то есть публикуемый стоп = лучший из (ATR-трейлинг, безубыток+комиссия). Публикация и уведомление — существующим кодом (ветка `trail.moved`, включить также случай `locked === true`).

**Expected benefit:** после хода ≥ +0.8% худший исход позиции ≈ +0.05–0.15% (вместо полного стопа −1.8%). Сценарий владельца «+$2 → −$5» становится «+$2 → +$0.4».

**Potential downside:** рост доли scratch-выходов на шуме сразу после активации; смягчение — активация 0.8% ≈ 1.6×ATR(1h) уже фильтрует мелкий шум, буфер 0.15% покрывает комиссии. Метрика контроля: доля scratch-закрытий и give-back в `/perf`.

**Validation plan:** кейсы L-3 (1–4).

**Approval required:** не применено.

---

## L-2 (P1): Страж корзины — трейлинг пика суммарного PnL

**Issue:** портфель из коррелированных позиций — одна большая ставка: общий плюс +$8–10 разворачивается в общий минус, а per-position правила этого не видят.

**Proposed change (а)** — параметры (env, с дефолтами; расчёт подтвержден числами владельца: депозит ≈ $560):

```js
const BASKET_ARM_PCT = Number(process.env.BASKET_ARM_PCT ?? 1.5);   // % депозита: вооружение (~$8.5)
const BASKET_RETRACE_PCT = Number(process.env.BASKET_RETRACE_PCT ?? 50); // % отката от пика → закрыть всё
const BASKET_TAKE_PCT = Number(process.env.BASKET_TAKE_PCT ?? 3.0);  // % депозита: большой выигрыш → закрыть всё сразу (~$17)
```

**Proposed change (б)** — состояние в `state.json` (модуль R-2), переживает рестарт: `{ basket: { armed: boolean, peakPnlUsd: number } }`.

**Proposed change (в)** — в `runStopcheckPass` (выполняется каждые 5 мин; ДО per-position цикла и ДО любых LLM-вызовов — при срабатывании LLM в этом тике не нужен):

```js
// чистая функция — в market-summary.mjs или shadow.mjs (выбор исполнителя):
export function basketDecision({ basketPnlUsd, equityUsd, armed, peakPnlUsd, armPct, retracePct, takePct }) {
  // возвращает { action: 'HOLD'|'ARM'|'CLOSE_ALL', newArmed, newPeak, reason }
  // 1) basketPnl >= takePct% equity → CLOSE_ALL ('big take')
  // 2) !armed && basketPnl >= armPct% equity → ARM (peak = basketPnl)
  // 3) armed: peak = max(peak, basketPnl); basketPnl <= peak * (1 - retracePct/100) → CLOSE_ALL ('retrace lock')
  // 4) armed && basketPnl <= 0 → CLOSE_ALL ('gave it all back') и сброс armed
  // иначе HOLD
}
```

При `CLOSE_ALL`: закрыть КАЖДУЮ фьючерсную позицию из списка существующим `closePosition(...)` (sequential, ошибка одной не мешает остальным), `log.execute('basket profit lock', { basketPnlUsd, peakPnlUsd, equityUsd, reason })`, `notifyUser` с суммой и причиной, сброс `basket` в state, пропуск per-position LLM в этом тике. Спот-холды НЕ трогаем (нет SL-механики; отдельное решение владельца).

**Пороги в абсолютах при депозите $560:** армирование ~$8.4 · откат 50% от пика (пик +$10 → закрытие ~+$5) · большой выигрыш ~$16.8. Сценарий владельца «утром +$10, вечером −$20» → исход ≈ **+$5**.

**Why it is better:** корзина получает тот же trailing-стоп, что и позиция, но на правильном уровне агрегации (коррелированная книга движется как одна ставка); вооружение по % депозита масштабируется при росте счёта; состояние переживает рестарт (R-2).

**Expected benefit:** серия «+8 → −20» превращается в «+8 → +4..5»; big-take забирает трендовые дни целиком.

**Potential downside:** закрытие корзины рубежом режет и прибыльные, и убыточные позиции разом — в смешанные моменты возможен выход из позиции, которая потом отработала бы; защита от частых ложных срабатываний — армирование только выше 1.5% и единый 5-мин тик (не чаще). LLM не участвует — галлюцинированных закрытий нет по построению.

**Validation plan:** кейсы L-3 (5–9).

**Approval required:** не применено.

---

## L-3. План валидации Части 6 — `test/telegram-profitlock.test.mjs`

1. `applyProfitLock` LONG: travel 0.7% (<0.8) → `locked:false`, стоп без изменений; travel 0.9% → стоп поднят до `entry×1.0015`, если был ниже.
2. `applyProfitLock` SHORT: зеркально (floor = `entry×0.9985`, стоп опускается к нему сверху).
3. Никогда не расширяет: стоп уже выше floor (LONG) → без изменений.
4. Невалидные входы (NaN/отрицательные) → `locked:false` (fail-closed как в trailing.mjs).
5. `basketDecision`: pnl 1.2% < arm → HOLD, не вооружён; pnl 1.6% → ARM, peak=pnl.
6. Откат: armed, peak 10, pnl 4.9 (откат >50%) → CLOSE_ALL 'retrace lock'; pnl 5.1 → HOLD с обновлённым peak.
7. Big take: pnl 3.1% → CLOSE_ALL независимо от armed.
8. Gave-back: armed, pnl ≤ 0 → CLOSE_ALL + сброс.
9. Интеграция: при CLOSE_ALL вызывается closePosition для каждой фьюч-позиции, LLM в тике не вызывается, state сброшен и сохранён (мок-фикстуры).

Плюс наблюдение в paper/boю 1–2 недели: метрики give-back (пик vs закрытый PnL), доля scratch-закрытий, частота срабатываний стража корзины в неделю (ожидание: редко, 0–3).

---

## L-4. Явно вне области Части 6

- Спот-холды стражем корзины не закрываются (нет SL-механики спота) — отдельное решение владельца.
- Частичное закрытие позиций (скейл-аут) — не вводится (поддержки в исполнении нет, сложность не окупается при текущих размерах).
- Изменение `TRAIL_ATR_MULT`, `TRAIL_ACTIVATION_PCT` — только по отдельной команде владельца.
- LLM-закрытие прибыли не возвращается (см. M-1).

---
---

# Часть 7 — Harvest-режим: сбор прибыли для малого депозита

**Контекст (данные с биржи 2026-10-15, собраны аудитором по closed-pnl + MFE-анализу):**

| Источник | MFE (максимум доступной прибыли) | Фактически взято | Отдано рынку |
|---|---|---|---|
| 5 закрытых шортов за день | +$17.78 | +$1.79 | ~$16 |
| 2 открытых старых лонга (ETH 5 дн., BTC 6 дн.) | +$23.45 | +$1.26 (текущий) | ~$22 |
| **Итого за день** | **~+$41** | **~+$3** | **~$38** |

Realized PnL по дням: −7.18 / −1.60 / −2.98 / −12.21 / +1.78 = **−$22.2 за 5 дней**. Наблюдение владельца «в моменте можно было закрыть всё в +15, закрыл в +1» — подтверждено с точностью до доллара.

**Корневые причины (верифицированы):**
1. **TP недостижим в пилообразном движении по конструкции:** trailing TP переустанавливается на `2.5×ATR` ВПЕРЁДИ лучшей цены (env `TRAIL_ATR_MULT=2.5`, при кодовом дефолте 2.0) — срабатывает только на ускорении; на развороте позиция отдаёт до 2.5×ATR от пика.
2. **Нет give-back блокировки ни на позицию, ни на корзину** (L-1/L-2 из Части 6 закрывают только часть: L-1 — лишь безубыток, L-2 — корзина от 1.5% депозита; ETH с MFE +$17 L-1 зафиксировал бы лишь ~+$0.3).
3. **Time-stop отсутствует:** система держит позиции 5–6 дней при собственном горизонте скаута 1–12ч — мёртвые деньги и накопленная отдача.
4. Стоп-трейл работает (зафиксировано 41 срабатывание), но 2.5×ATR — слишком широко для цели «собирать небольшой плюс».

**Профиль цели (одобрен владельцем):** пока депозит мал — приоритет высокого win-rate с мелкими победами над редкими большими; честная цена — меньший средний выигрыш и больше scratch-выходов; контролируется метриками give-back и expectancy в `/perf`. Всё детерминированное, LLM не участвует.

---

## T-1 (P1): Give-back замок на позицию (harvest stop)

**Issue:** нет механизма «пик прибыли был — половину забрать»: открытая прибыль $3–17 регулярно отдаётся почти полностью.

**Proposed change (а)** — трекер пика PnL на позицию в `state.json` (R-2): `positionsPeak: { 'kind:symbol': peakPnlUsd }` — обновляется каждый monitor/stopcheck тик по `unrealisedPnl` (peak = max).

**Proposed change (б)** — чистая функция решения (в `trailing.mjs` или `market-summary.mjs`):

```js
export const HARVEST_ARM_USD = Number(process.env.HARVEST_ARM_USD ?? 1.5);   // ≈0.5% ношенала $300, ≈0.27% депозита — из распределения MFE дня ($1.5–5.9)
export const HARVEST_RETRACE_PCT = Number(process.env.HARVEST_RETRACE_PCT ?? 50);

/**
 * Per-position give-back lock. Once peak open profit reached armUsd, a retrace
 * of retracePct from the peak closes the position at market. Deterministic;
 * no LLM. Returns { close: boolean, peak, reason }.
 */
export function harvestDecision({ pnlUsd, peakPnlUsd, armUsd = HARVEST_ARM_USD, retracePct = HARVEST_RETRACE_PCT }) {
  // peak = max(peak, pnl); peak < armUsd → { close:false, peak }
  // pnl <= peak * (1 - retracePct/100) → { close:true, peak, reason:'harvest retrace lock' }
  // иначе { close:false, peak }
}
```

**Proposed change (в)** — интеграция в `runStopcheckPass` (5-мин тик, ДО LLM-гейта): для каждой позиции `harvestDecision`; при `close` → существующий `closePosition(...)` + `log.execute('harvest closed', { symbol, pnlUsd, peakPnlUsd })` + `notifyUser` («🔒 Зафиксировал +$X с пика +$Y»), сброс пика по ключу. Применяется ко ВСЕМ фьюч-позициям (авто и ручные — по решению владельца, ручные тоже его деньги).

**Ожидаемый эффект на данных дня:** ETH open: MFE +17.08 → фиксация ≈ +$8.5; NEAR short: +5.93 → ≈ +$3.0; серия шортов: +$1.79 → ≈ +$8–9.

**Potential downside:** отсечка продолжающихся трендов (NEAR дошёл бы до TP после отката 50%?) — цена harvest-профиля, принята владельцем; смягчение: arm/retrace в env, трендовые дни добирает big-take корзины (L-2).

**Validation plan:** кейсы T-6 (1–4).

**Approval required:** не применено.

---

## T-2 (P1): `TRAIL_ATR_MULT` 2.5 → 2.0 (выровнять env с дизайном)

**Issue:** env переопределяет кодовый дефолт 2.0 на 2.5 — откат до срабатывания трейлинг-стопа ≈ 2.5×ATR от лучшей цены (для ETH ≈ $3.3 на позиции 0.11), что шире, чем arm harvest-замка ($1.5). Параметры противоречат друг другу и цели.

**Proposed change:** в `.env` `TRAIL_ATR_MULT=2.0` (или удалить строку — тогда дефолт 2.0). Без изменения кода.

**Validation plan:** наблюдение неделю: средняя отдача от пика по закрытиям (из `/perf` give-back) должна снизиться; scratch-rate не выше 40%.

**Approval required:** не применено.

---

## T-3 (P2): Заморозка TP после активации (TP не убегает в тренде-пиле)

**Issue:** trailing TP переустанавливается всё дальше вперёд при каждом продолжении хода (`computeTrailingTakeProfit`) — в пиле TP недостижим, при развороте всё отдаётся стопу.

**Proposed change:** после достижения travel ≥ `TRAIL_ACTIVATION_PCT` (0.8%) TP больше НЕ переустанавливать вверх/вниз по ходу цены (заморозить последний). Реализация: в `runMonitorPass` ветку `tpTrail.moved` выполнять только если `travel < activationPct` (вычисление travel уже есть для трейлинга). Дальше судьбу позиции решают: замороженный TP, harvest-замок (T-1), безубыток (L-1) или трейлинг-стоп.

**Expected benefit:** TP реально достигается при медленном движении к цели вместо вечного «ещё 2.5×ATR впереди».

**Potential downside:** в сильных трендах фиксированный TP обрезает хвост — принято профилем; big-take корзины (L-2) частично компенсирует.

**Validation plan:** кейс T-6 (5).

**Approval required:** не применено.

---

## T-4 (P2): Time-stop — enforcement собственного горизонта 1–12ч

**Issue:** позиции живут 5–6 дней при горизонте стратегии 1–12ч; за это время накапливается отдача и занимается слот риска.

**Proposed change:** в `runStopcheckPass`: возраст позиции (из `createdTime` или первого появления в `prevPositions`) > `TIME_STOP_HOURS` (env, дефолт 24; 0 = выкл) И `pnlUsd < HARVEST_ARM_USD` И нет активного harvest-пика → `closePosition` + лог + notify («⏰ Time-stop: позиции Nч, плюс не состоялся»). Спот не трогаем.

**Expected benefit:** ETH/BTC 5–6-дневные мертвецы освобождают маржу и перестают копить отдачу; капитал работает в горизонте, для которого спроектирован скаут.

**Validation plan:** кейс T-6 (6).

**Approval required:** не применено.

---

## T-5 (P2): Телеметрия give-back

- `positionsPeak` в `state.json` (см. T-1а) — источник данных.
- В `reflectClosedTrade` добавить `mfeUsd` (пик из трекера) в инпут рефлектора — уроки получают «отдано = mfe − realized».
- В `/perf` (P-3) добавить блок: «Give-back за 7д: MFE $X vs realized $Y (Z% отдано)», плюс scratch-rate (доля закрытий |pnl| < $0.5).

**Validation plan:** кейс T-6 (7).

**Approval required:** не применено.

---

## T-6. План валидации Части 7 — дополнить `test/telegram-profitlock.test.mjs`

1. `harvestDecision`: pnl 1.2 < arm → не вооружён; pnl 1.6 → peak обновлён; откат до 0.79 (peak 1.6, >50%) → `close:true`.
2. Пик не снижается при временной просадке без касания порога; сброс после закрытия.
3. Невалидные входы → `close:false` (fail-closed).
4. Интеграция: при `close` вызывается closePosition, LLM в тике пропускается, пик сброшен и персистирован (моки).
5. T-3: при travel ≥ activation TP не переустанавливается; при travel < activation — переустанавливается (регрессия).
6. T-4: возраст 25ч + pnl < arm → close; возраст 25ч + активный пик → не трогаем; TIME_STOP_HOURS=0 → выкл.
7. T-5: `mfeUsd` попадает в инпут рефлектора; give-блок `/perf` считается корректно на фикстуре.

Наблюдаемость приёмки (2 недели): give-back % (цель: с ~90% до <40%), win-rate закрытий, expectancy/день (цель: ≥ 0 при scratch-rate < 40%), доля time-stop срабатываний.

---

## T-7. Явно вне области Части 7

- Частичное закрытие (скейл-аут 50%) — следующая итерация, если harvest покажет систематическое отсечение трендов (по данным `/perf`).
- Изменение риска на сделку (1%) и лимитов автотрейда — только по команде владельца.
- Harvest-замок не применяется к спот-холдам.

*Каждая правка применяется только после одобрения владельца. Одобрение одной правки не распространяется на остальные.*
