/**
 * AI chat client for the Telegram phase.
 *
 * A small, self-contained OpenAI-compatible chat-completions caller that
 * supports DeepSeek and Moonshot AI (Kimi) — and, importantly, allows the two
 * roles to use DIFFERENT providers:
 *
 *   - SCOUT (idea generation)  — cheap, fast, non-thinking model
 *   - GUARD (adversarial check) — the role that benefits from deeper reasoning
 *
 * That split matters for cost: a premium reasoning model on both roles burns
 * tokens far faster than the edge per trade justifies, so the scout runs on a
 * cheap model while the guard can be a stronger one.
 *
 * Keys are only ever sent as Authorization headers and are never logged.
 */
import { buildScoutPrompt, parseScoutResponse, validateIdeasWithMarket } from './ideas.mjs';
import { buildGuardPrompt, parseGuardResponse } from './risk-filter.mjs';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const KIMI_BASE_URL = 'https://api.moonshot.cn';

const DEFAULTS = Object.freeze({
  deepseek: { baseUrl: DEEPSEEK_BASE_URL, scout: 'deepseek-chat', guard: 'deepseek-reasoner' },
  kimi: { baseUrl: KIMI_BASE_URL, scout: 'kimi-k2-7', guard: 'kimi-k3' },
});

/**
 * Resolve one role's transport config from env + explicit options.
 *
 * @param {'scout' | 'guard'} role
 * @param {object} opts
 * @returns {{ provider: 'deepseek' | 'kimi', baseUrl: string, apiKey: string, model: string, reasoningEffort: string | null }}
 */
function resolveRole(role, opts) {
  const legacyUseKimi = opts.useKimi ?? false;

  // Provider precedence: an explicit per-role provider wins; otherwise the
  // legacy `useKimi` flag decides; otherwise DeepSeek.
  const explicitProvider = role === 'scout' ? opts.scoutProvider : opts.guardProvider;
  const requestedProvider = explicitProvider ?? (legacyUseKimi ? 'kimi' : 'deepseek');

  // Base URL precedence: role-specific URL → provider preset (when the provider
  // was set explicitly) → legacy single baseUrl → provider preset.
  const explicitBaseUrl = role === 'scout' ? opts.scoutBaseUrl : opts.guardBaseUrl;
  let baseUrl;
  if (explicitBaseUrl) baseUrl = explicitBaseUrl;
  else if (explicitProvider) baseUrl = (DEFAULTS[explicitProvider] ?? DEFAULTS.deepseek).baseUrl;
  else baseUrl = opts.baseUrl ?? (DEFAULTS[requestedProvider] ?? DEFAULTS.deepseek).baseUrl;
  baseUrl = String(baseUrl).replace(/\/+$/, '');

  // Moonshot hosts need the Moonshot key; DeepSeek hosts need the DeepSeek key.
  const isMoonshot = /moonshot/.test(baseUrl);
  const provider = isMoonshot ? 'kimi' : 'deepseek';
  const preset = DEFAULTS[provider];

  const explicitKey = role === 'scout' ? opts.scoutApiKey : opts.guardApiKey;
  const apiKey = explicitKey ?? (isMoonshot ? (opts.kimiApiKey ?? opts.apiKey) : (opts.deepseekApiKey ?? opts.apiKey));

  const explicitModel = role === 'scout' ? opts.model : opts.guardModel;
  const model = explicitModel ?? preset[role];

  // Reasoning effort: scout stays non-thinking (cheap); guard defaults to "low",
  // which cuts the billed chain-of-thought without losing adversarial rigour.
  const reasoningEffort = role === 'scout'
    ? (opts.scoutReasoningEffort ?? null)
    : (opts.guardReasoningEffort ?? 'low');

  return {
    provider,
    baseUrl,
    apiKey: typeof apiKey === 'string' ? apiKey : '',
    model,
    reasoningEffort,
  };
}

/**
 * @param {object} options
 * @param {string} [options.apiKey]         legacy single key (used for both roles)
 * @param {string} [options.baseUrl]        legacy single base URL
 * @param {string} [options.model]          scout model
 * @param {string} [options.guardModel]     guard model
 * @param {boolean} [options.useKimi]       legacy: route both roles to Kimi
 * @param {'deepseek'|'kimi'} [options.scoutProvider]
 * @param {'deepseek'|'kimi'} [options.guardProvider]
 * @param {string} [options.scoutBaseUrl]
 * @param {string} [options.guardBaseUrl]
 * @param {string} [options.scoutApiKey]
 * @param {string} [options.guardApiKey]
 * @param {string} [options.deepseekApiKey]
 * @param {string} [options.kimiApiKey]
 * @param {string|null} [options.scoutReasoningEffort]
 * @param {string|null} [options.guardReasoningEffort]
 * @param {number} [options.temperature]
 * @param {number} [options.timeoutMs]
 */
export function createDeepSeekChat(options) {
  const scout = resolveRole('scout', options);
  const guard = resolveRole('guard', options);
  const temperature = options.temperature ?? 0.7;
  const timeoutMs = options.timeoutMs ?? 60000;
  const fetchImpl = globalThis.fetch;

  const missing = [];
  if (!scout.apiKey) missing.push(`scout (${scout.provider})`);
  if (!guard.apiKey) missing.push(`guard (${guard.provider})`);
  if (missing.length > 0) {
    throw new Error(`API key is not set for: ${missing.join(', ')} — analysis cannot run.`);
  }

  // Running tally of prompt-cache hit/miss input tokens, for proving that the
  // cache-friendly prompt layout actually earns hits (a hit is ~50x cheaper).
  const cacheStats = { hits: 0, misses: 0, zeroHitCalls: 0, calls: 0 };

  /**
   * One chat-completion call for a resolved role.
   * @param {{ provider: string, baseUrl: string, apiKey: string, model: string, reasoningEffort: string | null }} role
   * @param {{ system: string, user: string }} prompt
   * @param {number} temp
   */
  async function complete(role, prompt, temp) {
    const label = role.provider === 'kimi' ? 'Kimi' : 'DeepSeek';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // api.moonshot.ai (international endpoint) rejects any temperature other
    // than 1 on current Kimi models — override locally when that host is used.
    const forcedTemp = /moonshot\.ai/.test(role.baseUrl) ? 1 : null;
    let res;
    try {
      const body = {
        model: role.model,
        messages: [
          { role: 'system', content: prompt.system },
          { role: 'user', content: prompt.user },
        ],
        temperature: forcedTemp ?? temp,
        stream: false,
        response_format: { type: 'json_object' },
      };
      // Cap reasoning on thinking-capable models: the default ("high") bills long
      // chains-of-thought as output tokens.
      if (role.reasoningEffort) body.reasoning_effort = role.reasoningEffort;
      res = await fetchImpl(`${role.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${role.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      const err = /** @type {any} */ (error);
      const cause = err?.cause ? ` (cause: ${err.cause})` : '';
      const code = err?.code ? ` [${err.code}]` : '';
      const lbl = err?.name === 'AbortError' ? 'timeout' : String(error);
      throw new Error(`${label}(${role.model}) request failed: ${lbl}${code}${cause}`);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      throw new Error(`${label}(${role.model}) HTTP ${res.status}`);
    }
    const payload = await res.json();
    // Track real cache effectiveness — DeepSeek reports hit/miss input tokens on
    // every response, so we can prove the prompt layout actually earns hits
    // instead of assuming it.
    const usage = payload?.usage;
    if (usage && typeof usage === 'object') {
      const hit = Number(usage.prompt_cache_hit_tokens) || 0;
      const miss = Number(usage.prompt_cache_miss_tokens) || 0;
      if (hit + miss > 0) {
        cacheStats.hits += hit;
        cacheStats.misses += miss;
        cacheStats.calls += 1;
        if (hit === 0) cacheStats.zeroHitCalls += 1;
        console.error(`[cache] ${label}(${role.model}) input ${hit + miss}t: hit ${hit}, miss ${miss}`);
      }
    }
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.trim() === '') {
      throw new Error(`${label}(${role.model}) returned no content`);
    }
    return content;
  }

  return {
    baseUrl: scout.baseUrl,
    model: scout.model,
    guardModel: guard.model,
    provider: scout.provider,
    guardProvider: guard.provider,
    /** Snapshot of prompt-cache hit/miss counters. */
    getCacheStats() {
      const total = cacheStats.hits + cacheStats.misses;
      return {
        ...cacheStats,
        hitRatio: total > 0 ? cacheStats.hits / total : 0,
      };
    },
    /** Generate trade ideas for a market context (scout role). */
    async generateIdeas(context) {
      const prompt = buildScoutPrompt(context);
      const content = await complete(scout, prompt, temperature);
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
    },
    /** Validate ONE idea adversarially (guard role). */
    async filterIdea(idea, market, { sentiment = null, news = null } = {}) {
      const prompt = buildGuardPrompt({ idea, market, sentiment, news });
      const content = await complete(guard, prompt, 0);
      const parsed = parseGuardResponse(content);
      return { prompt, parsed, raw: content };
    },
    /**
     * Low-level completion on the GUARD role with an arbitrary prompt (used by
     * the monitor / stop-check / reflector). Returns raw string content.
     */
    async _completeGuard(prompt) {
      return complete(guard, prompt, 0);
    },
    /** Low-level completion on the SCOUT role (used by the reflector). */
    async _completeScout(prompt) {
      return complete(scout, prompt, 0);
    },
  };
}
