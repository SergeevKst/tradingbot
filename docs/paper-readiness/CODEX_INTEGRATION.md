# Codex model integration for AI PAPER trading

Status of this task: **adapter implemented and mock-tested; Codex connectivity
verified end-to-end; PAPER integration MOCK-READY; production AI dispatch still
disabled by default; zero exchange orders issued.**

This document records the verification evidence (P1), the implementation (P2),
and the residual risks a reviewer must weigh. Nothing here was inferred: every
claim below is backed by a command whose output is quoted.

---

## 1. Priority 1 — Codex access, verified

Environment at verification time: `codex-cli 0.163.0` (npm `@openai/codex`)
at `~/.nvm/versions/node/v22.23.2/bin/codex`, Node `v22.23.2`, macOS 15.4.1.
The desktop app reports `26.1013.40934`; an update to CLI `0.167.1` is available
but was **not** installed (a version change mid-task would invalidate the
evidence).

### 1.1 Non-interactive invocation: supported and documented

| Question | Answer | Evidence |
| --- | --- | --- |
| Non-interactive mode | **yes — `codex exec`** | `codex --help` lists `exec  Run Codex non-interactively [aliases: e]`; official docs: "Non-interactive mode … Use `codex exec` to run Codex in scripts and CI" (`learn.chatgpt.com/docs/non-interactive-mode`) |
| Prompt without argv limits | **yes** — prompt on stdin with the `-` sentinel | `codex exec --help`: "If not provided as an argument (or if `-` is used), instructions are read from stdin"; documented as "`codex exec -` when stdin is the prompt" |
| Structured output | **yes** — `--output-schema <file>` and `-o/--output-last-message <file>` | `codex exec --help`; docs section "Create structured outputs with a schema" |
| Machine-readable events | **yes** — `--json` emits JSONL (`thread.started`, `item.completed`, `turn.completed` with token usage) | observed live (below) and documented |
| Sandbox/approval control | **yes** — `--sandbox read-only` (the exec default), `--ephemeral`, `--skip-git-repo-check`, `--ignore-user-config`, `--ignore-rules` | `codex exec --help`; docs "Use `--ignore-user-config` when you need a run that doesn't load `$CODEX_HOME/config.toml`" |

### 1.2 Authentication: the owner's subscription, not an API key

```
$ codex login status
Logged in using ChatGPT
```

```
$ codex doctor            # redacted tail of the auth/connectivity section
✓ auth         auth is configured
    auth storage mode        File
    stored auth mode         chatgpt
    stored API key           false
    stored ChatGPT tokens    true
✓ websocket    connected (HTTP 101 Switching Protocols)
    auth mode                chatgpt
    endpoint                 wss://chatgpt.com/backend-api/<redacted>
✓ reachability reachability mode ChatGPT auth
    ChatGPT inference URL    https://chatgpt.com/backend-api/<redacted> reachable (HTTP 405)
```

So: ChatGPT-subscription auth, **no API key stored**, inference against the
ChatGPT backend (`chatgpt.com/backend-api`), not `api.openai.com`. No credential
was read, printed or copied; `~/.codex/auth.json` was never opened.

Official support for this automation shape: the docs' "Use ChatGPT-managed auth
in CI/CD (advanced)" section explicitly covers running `codex exec` as a ChatGPT
account (with subscription rate limits instead of API usage), and states
"`codex exec` reuses saved CLI authentication by default". This is an official
path, not an unsupported workaround.

### 1.3 Models available to this subscription

`codex debug models` (account-aware raw catalog) on this machine:

| slug | display name | visibility | notes |
| --- | --- | --- | --- |
| `gpt-6.1-sol` | GPT-6.1-Sol | list | "Latest workhorse model"; catalog note: "near-Astra performance at a lower cost" |
| `gpt-6-astra` | GPT-6-Astra | list | "Frontier intelligence for the most demanding work" — **Astra** |
| `gpt-6.1-terra` | GPT-6.1 Terra | list | |
| `gpt-6-sol` | GPT-6-Sol | list | previous workhorse |
| `gpt-reserve` | GPT-Reserve | hide | "Fast and affordable agentic coding model" |
| `gpt-6-luna` | GPT-6-Luna | list | "Fast and affordable model for easier tasks" |
| `gpt-5.6-sol` / `gpt-5.6-terra` / `gpt-5.6-luna` | — | list | older generation |
| `codex-auto-review` | Codex Auto Review | hide | approval reviewer, not a general model |

Caveat, stated plainly: the catalog differs between the owner's `CODEX_HOME` and
an empty one (an empty home also lists `gpt-5.5` and the `daybreak` variants), so
it is account/config aware but it is **not** an entitlement probe. Availability
was therefore proven by inference, not by the catalog alone: `gpt-6.1-sol`
answered a live prompt (§1.4). `gpt-6-astra` is listed and is the owner's CLI
default (`model = "gpt-6-astra"` in `~/.codex/config.toml`), but this task did
**not** spend a call on it — see the residual-risk section.

### 1.4 Live connectivity check (single minimal call)

```
$ codex exec --ephemeral --skip-git-repo-check -s read-only -m gpt-6.1-sol \
    -c model_reasoning_effort="low" --json \
    --output-schema probe-out/schema.json -o probe-out/last-message.json \
    "Return JSON with status set to the literal string ok. Nothing else."

{"type":"thread.started","thread_id":"01a1cbef-…"}
{"type":"turn.started"}
{"type":"item.completed","item":{"type":"agent_message","text":"{\"status\":\"ok\"}"}}
{"type":"turn.completed","usage":{"input_tokens":15859,"cached_input_tokens":0,
                                 "cache_write_input_tokens":0,"output_tokens":15,
                                 "reasoning_output_tokens":0}}
real 0m10.742s
$ cat probe-out/last-message.json
{"status":"ok"}
```

Two facts worth carrying into the cost model: even a trivial prompt bills
**≈ 15.9 k input tokens** (the CLI's own base instructions dominate), and a round
trip costs **≈ 10–11 s**.

The same run also emitted a non-fatal `rmcp` transport error (HTTP 403 from
CloudFront) caused by an MCP server in the owner's `config.toml`. It did not
affect the answer, and the adapter avoids it by not loading that config at all
(`--ignore-user-config`).

### 1.5 Repeatability, concurrency, session lifetime

- Each `codex exec --ephemeral` run is a **fresh session**; nothing is persisted
  (`--ephemeral`) and there is no session to keep alive or re-authenticate. The
  CLI refreshes its own ChatGPT tokens in `~/.codex/auth.json`.
- Re-authentication only becomes an operator action if the CLI's stored session
  expires; a failed run is visible as a non-zero exit / error event, which the
  adapter reports as `PROVIDER_ERROR` (fail-closed), never as a trade.
- Concurrency is bounded by the adapter itself: **one in-flight call** per
  transport, and a sliding-window budget (`AI_CODEX_MAX_CALLS_PER_HOUR`, default
  30). Parallel calls are refused (`BUSY`), not queued.

### 1.6 Usage limits and cost exposure

Subscription allowance, **not** per-token API billing:

- "Usage limits vary by plan" and, for Plus/Pro/Business, the allowance is
  **measured in tokens** and shared across ChatGPT/Codex; `/status` inside a
  Codex session shows the remaining allowance and reset time
  (`help.openai.com/en/articles/11369540`, `…/20001625`).
- No API credits are purchased or consumed by this integration. The transport
  **removes `OPENAI_API_KEY`, `CODEX_API_KEY` and `CODEX_ACCESS_TOKEN` from the
  child environment**, so a stray key in the bot's environment cannot silently
  turn this into metered API usage.
- Measured exposure per call: ≈ 15.9 k input + ≈ 15 output tokens, ≈ 10 s wall
  time. At the default budget of 30 calls/hour that is ≈ 477 k input tokens/hour
  — a large fraction of a personal plan's allowance for one process. The
  recommendation for any future loop is 6–12 calls/hour per operation, which the
  sink's `maxDecisionsPerHour` and the transport budget both enforce
  independently.

---

## 2. Priority 2 — implementation

### 2.1 What was added

| File | Role |
| --- | --- |
| `src/config/codex.mjs` | config layer: model catalog, `AI_CODEX_*` parsing, child-environment allowlist (`buildCodexChildEnv`) |
| `src/providers/codex/codex-cli-transport.mjs` | the only module that starts a process: fixed argv, prompt on stdin, schema file, JSONL parsing, hard timeout, single-flight, hourly budget, sanitized stderr |
| `src/providers/codex/codex-provider.mjs` | `AIProvider` adapter (`id: 'codex'`) + model policy (routine model vs Astra) |
| `src/providers/codex/index.mjs` | provider surface |
| `src/ai/paper-decision-sink.mjs` | the AI → PAPER bridge (B3) with the staleness gate (B5) |
| `scripts/codex_connectivity_check.mjs` | opt-in, `--yes`-gated single real call (`npm run codex:check`) |

Routing integration (UAI v1.2, per-operation model resolution):

- `VALID_PROVIDERS` / capability profiles accept `codex` (`codex-unified-v1`);
- the registry validates a `codex` model entry and refuses an HTTP endpoint for
  it, and refuses a provider outside the allowlist;
- the manifest accepts `providerId: "codex"` with the fixed local sentinel
  `cli://codex` (and refuses that sentinel for HTTP providers, and any HTTP URL
  for `codex`);
- `createDefaultCoreProviderFactory` dispatches `codex` → `createCodexProvider`,
  **requires `AI_CODEX_ENABLED=true`**, and — uniquely for this provider — does
  not demand an API key;
- `deriveChatCompletionsUrl` refuses a local-CLI provider, so no code path can
  synthesise an HTTP call to a non-existent endpoint.

### 2.2 Safety properties, and how they are enforced

| Property | Mechanism |
| --- | --- |
| No credential in this process | no API key parameter anywhere in the provider/transport; the child env is rebuilt from an allowlist that drops `OPENAI_*`, `CODEX_API_KEY`, `CODEX_ACCESS_TOKEN`, `BYBIT_*`, `TELEGRAM_*`, `DEEPSEEK_*`, `KIMI_*`, `OPENROUTER_*` |
| No shell, fixed argv | `spawn(command, argvArray, { shell: false })`; only model id, reasoning effort and prompt content are caller-controlled (prompt on stdin) |
| Least privilege | `--sandbox read-only`, `--ephemeral`, `--ignore-user-config`, `--skip-git-repo-check`, cwd = throwaway temp dir |
| Structured output | `--output-schema` with a schema whose `required` covers every property, **and** local re-validation (`validateAnalysisOutput`) as the authority |
| Fail closed | every transport failure maps to `PROVIDER_ERROR` / `INVALID_OUTPUT`; a model answer can never become an approval, a size or an order |
| Bounded usage | single in-flight call, sliding-window hourly budget, hard timeout (`AI_CODEX_TIMEOUT_MS`, default 120 s) |
| Astra only where configured | `assertCodexModelPolicy` refuses `gpt-6-astra` unless the operation is listed in `AI_CODEX_ASTRA_OPERATIONS`; routine operations use `gpt-6.1-sol` |
| No duplicate decisions | provider is stateless; the sink dedupes by `symbol:side:time-bucket` and by hourly budget |
| Audit | transport logs duration/token counts only (never prompt or answer text); the sink emits frozen audit events (`AI_PAPER_PROPOSAL`, `AI_PAPER_DECISION`, `AI_PAPER_DECISION_REFUSED`, `AI_PAPER_SUBMIT_FAILED`) |
| No exchange path | the transport imports no trading module; the sink imports no exchange/execution module and calls `PaperSession.submit()` only |

One deliberate architectural exception: `test/security.test.mjs` bans process
spawning outside the storage layer. The Codex transport is added to that
allowlist with a rationale **and** compensating assertions (it may not import
`risk/execution/session/reconciliation/state/telegram/adapters-bybit/testnet/domain`,
may not open HTTP/HTTPS, may not call `fetch`, may not hold a credential, and must
spawn with `shell: false`). A reviewer should treat that exception as the single
most security-sensitive line in this diff.

### 2.3 The AI → PAPER bridge (B3) and the staleness gate (B5)

`createPaperDecisionSink` is the missing link from an AI decision to a PAPER
session:

```
AIAnalysisOutcome ──► admission rules ──► deterministic price geometry
                                              │  (ATR×1.5 clamped to 0.2–2 % of price)
                                              ▼
                          PaperSession.submit()  ──►  Risk Engine  ──►  virtual fill
```

Admission rules, each with its own refusal code: sink disabled (default),
outcome not `ok`, `symbol` mismatch, `NEUTRAL` bias, confidence below the floor
(default 0.55), stale snapshot (`stalenessMs`, default 60 s — B5), missing price,
hourly decision budget, duplicate decision.

The model still cannot size: the proposal carries `symbol, side, entryPrice,
stopLossPrice, takeProfitPrice, strategyId, confidence, timestamp` and nothing
else; `calculatePositionSize` never sees the model's confidence.

### 2.4 Tests

`npm test` on this branch: **988 tests, 984 pass, 3 fail, 1 skipped**. The three
failures are the pre-existing B4 prompt-contract tests on `main`
(`telegram-guard` G-5, `telegram-ideas` S-5, `telegram-monitor` prompt versions)
— unchanged, not weakened. Baseline at `613b2a17` with dependencies installed:
938 tests, 934 pass, the same three failures.

New tests (+50):

| File | Tests | Focus |
| --- | --- | --- |
| `test/codex-cli-transport.test.mjs` | 12 | fixed argv/no shell/stdin prompt, schema file, env allowlist, timeout+SIGKILL, single-flight, budget window, malformed requests, sanitized failures, CLI error events, JSONL parsing |
| `test/codex-provider.test.mjs` | 14 | valid answer → `AIAnalysis`, non-JSON, schema violation, out-of-range confidence, transport failure, throwing transport, Astra policy, unknown model/operation, wiring errors, config defaults, env filtering |
| `test/codex-routing.test.mjs` | 11 | closed provider enums, profile/manifest/registry acceptance and refusals, `cli://codex` sentinel rules, resolver, factory (disabled/enabled/Astra/profile-mismatch), HTTP provider still needs a key |
| `test/paper-decision-sink.test.mjs` | 13 | disabled by default, LONG/SHORT geometry, ATR clamping, neutral/low-confidence/unusable refusals, stale market (B5), duplicate suppression, budget, throwing session, end-to-end PAPER fill, Risk Engine still rejects |

Plus `test/security.test.mjs` gained the compensating assertions above (24/24
pass).

### 2.5 Real end-to-end adapter check

```
$ AI_CODEX_ENABLED=true node scripts/codex_connectivity_check.mjs --yes
{
  "provider": "codex",
  "modelId": "gpt-6.1-sol",
  "status": "OK",
  "ok": true,
  "bias": "NEUTRAL",
  "confidence": 0.15,
  "issues": [],
  "promptVersion": "market-analysis-v1",
  "durationMs": 10317,
  "transport": { "calls": 1, "inFlight": false, "remainingBudget": 29, "maxCallsPerHour": 30 }
}
```

The trace shows the whole path working, including two instructive failures found
on the way (both fixed, both now covered by tests):

1. **`invalid_json_schema`** — the Codex structured-output endpoint requires
   `required` to list *every* property; the reviewed analysis schema marks
   `evidence` optional. The adapter now sends a derived schema
   (`CODEX_ANALYSIS_OUTPUT_SCHEMA`) that keeps the identical property
   definitions and adds `evidence` to `required` (an empty array is valid). Local
   validation is unchanged and remains authoritative.
2. **`INVALID_OUTPUT` on a synthetic symbol** — the first script run used
   `CONNECTIVITY-USDT`, which violates the `AIAnalysis` symbol pattern. The
   provider correctly refused to trade it. That is the fail-closed path proving
   itself against real model output.

---

## 3. PAPER integration status

**MOCK-READY.** The bridge exists, is exercised against the real PAPER session in
tests, and cannot reach an exchange — but no AI-driven decision has been produced
by a continuous loop, because no loop exists (B7) and production dispatch is off.

Separately, **Codex connectivity is CODEX-CONNECTED**: the real adapter produced
a schema-valid `AIAnalysis` through the owner's subscription (§2.5). The real call
was a connectivity probe against a synthetic context; it was **not** routed into
the PAPER sink.

Production AI dispatch remains **disabled by default**: `AI_CODEX_ENABLED` is
false, the factory refuses a codex route with `ACTIVATION_PAUSED` in that state,
and `src/index.mjs` still performs no inference. **Zero exchange orders** were
issued by this work; no live/testnet client was constructed and no order endpoint
was reached.

## 4. Blocker status after this task

| ID | Before | After |
| --- | --- | --- |
| B3 — no AI → PAPER bridge | blocking | **implemented**: `PaperDecisionSink` (PAPER-only, Risk Engine still the gate) — not yet called by any loop |
| B4 — prompt-contract failures | blocking | unchanged: the same 3 pre-existing failures; the Codex path does not use those prompts |
| B5 — no staleness gate on PAPER | blocking | **closed for this path**: the sink refuses a snapshot older than `stalenessMs` (test-pinned); the PAPER session itself still has no gate, by design |
| B6 — kill switch is memory-only | blocking | unchanged (bounded, not closed): the sink has no durable stop of its own; restarting still clears the runtime switch |
| B7 — no continuous loop | blocking | unchanged: no scheduler was added |
| B8 — cost control unproven | blocking | **bounded**: measured per-call tokens/latency, hourly call budget, single-flight; no spend ceiling in money because the path is a subscription allowance, not metered billing |
| B9 — Skill v2 dispatch refused | blocking | unchanged |

Telegram live execution was not touched: the five Telegram operations (`SCOUT`,
`GUARD`, `MONITOR`, `STOPCHECK`, `REFLECT`) still use the legacy deepseek client
and the mainnet executor. The routing layer can name a `codex` model for any of
the six operations, but only the core `ANALYZE` consumer has an adapter in this
build — wiring the other five would mean rewriting the mainnet-gated Telegram
path, which this task was explicitly not allowed to do.

## 5. Residual risks and what a reviewer must decide

1. **Astra is not live-probed.** `gpt-6-astra` is in the account-aware catalog and
   is the owner's CLI default, but no call was spent on it (quota discipline). The
   adapter gates it behind `AI_CODEX_ASTRA_OPERATIONS`, and an unavailable model
   fails closed. If Astra must be relied on, run
   `AI_CODEX_ENABLED=true AI_CODEX_MODEL=gpt-6-astra AI_CODEX_ASTRA_OPERATIONS=ANALYZE npm run codex:check -- --yes` once.
2. **Per-call cost is ~16 k input tokens** because the CLI's base instructions are
   sent every time. A chat-completion API would be cheaper per token; this path is
   cheaper *in money* because the allowance is already paid for. Any future loop
   must budget calls, not tokens.
3. **`--ignore-user-config`** is what makes runs deterministic and avoids the
   owner's MCP servers; the docs state it skips `$CODEX_HOME/config.toml` while
   auth (a separate `auth.json`) is retained. The live adapter run (§2.5) used
   exactly those flags and completed successfully, so this is validated on this
   machine for CLI 0.163.0. A CLI upgrade can change flag behaviour — re-run
   `npm run codex:check` after an upgrade.
4. **The security-test allowlist grows by one module.** Justification and
   compensating assertions are in §2.2 and in `test/security.test.mjs`.
5. **Prompt-injection surface.** The analysis prompt contains only the whitelisted
   `AIContext` (no repository content, no account, no credentials) and the agent
   runs `--sandbox read-only` with no project config loaded, so the model has
   nothing to hijack and no tools it can use to act.
6. **No durable kill switch (B6).** A future loop must persist the stop state
   before AI paper trading can run unattended.
