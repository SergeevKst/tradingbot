/**
 * Live safety layer tests (MASTER_SPEC Phase 10, §46).
 *
 * Everything here is offline and deterministic: injected environments, an
 * in-memory filesystem and a fixed clock. No test sets `LIVE_ENABLED` in the
 * real environment, touches `.env`, reads real credentials, or places an order.
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { ConfigError } from '../src/config/config-error.mjs';
import { DEFAULT_RISK_LIMITS } from '../src/config/risk.mjs';
import { LIVE_REST_BASE_URL, loadLiveConfig, loadLiveCredentials } from '../src/config/live.mjs';
import { REASON_CODE } from '../src/domain/reason-code.mjs';
import { createKillSwitch } from '../src/risk/kill-switch.mjs';
import { JOURNAL_EVENT, createJournal, createJournalEvent } from '../src/state/journal.mjs';
import {
  LIVE_CHECK,
  LIVE_CHECKLIST,
  LIVE_ATTESTATION_CHECKS,
  evaluateChecklist,
} from '../src/safety/checklist.mjs';
import {
  CREDENTIAL_SEPARATION,
  assertCredentialSeparation,
  checkCredentialSeparation,
} from '../src/safety/credential-separation.mjs';
import { assertLiveReady, evaluateLiveReadiness } from '../src/safety/live-gate.mjs';
import { createEmergencyControls } from '../src/safety/emergency-controls.mjs';
import { createLiveSession } from '../src/session/live-session.mjs';

const FIXED_NOW = '2026-10-01T00:00:00.000Z';
const now = () => FIXED_NOW;

/** Minimal in-memory fs so no test touches the disk. */
function memoryFs() {
  const files = new Map();
  return {
    files,
    async mkdir() {},
    async appendFile(path, data) {
      files.set(path, (files.get(path) ?? '') + data);
    },
    async readFile(path) {
      if (!files.has(path)) {
        const error = new Error('ENOENT');
        // @ts-ignore test fake
        error.code = 'ENOENT';
        throw error;
      }
      return files.get(path);
    },
    async open(path) {
      if (!files.has(path)) {
        const error = new Error('ENOENT');
        // @ts-ignore test fake
        error.code = 'ENOENT';
        throw error;
      }
      return { close: async () => {} };
    },
    async writeFile(path, data) {
      files.set(path, data);
    },
    async rename(from, to) {
      files.set(to, files.get(from));
      files.delete(from);
    },
    async unlink(path) {
      files.delete(path);
    },
  };
}

/** Parse the JSONL events a memory fs accumulated at `path`. */
function readEvents(fs, path) {
  const raw = fs.files.get(path) ?? '';
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line));
}

/** All thirteen §46 attestations, explicitly true. */
function fullEvidence() {
  /** @type {Record<string, boolean>} */
  const evidence = {};
  for (const check of LIVE_ATTESTATION_CHECKS) evidence[check.id] = true;
  return evidence;
}

/** A gate input with every condition satisfied. */
function readyInput(overrides = {}) {
  const fs = memoryFs();
  return {
    fs,
    input: {
      config: { enabled: true, mode: 'LIVE' },
      evidence: fullEvidence(),
      credentials: {
        live: { apiKey: 'live-key', apiSecret: 'live-secret' },
        testnet: { apiKey: 'testnet-key', apiSecret: 'testnet-secret' },
        testnetEnabled: false,
      },
      riskConfig: { ...DEFAULT_RISK_LIMITS },
      killSwitch: createKillSwitch({ now }),
      journal: createJournal({ filePath: 'memory/journal.jsonl', fs }),
      ...overrides,
    },
  };
}

// ---------------------------------------------------------------------------
// config/live.mjs
// ---------------------------------------------------------------------------
test('live-config: disabled by default and always mainnet', () => {
  const config = loadLiveConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.mode, 'PAPER');
  assert.equal(config.testnet, false);
  assert.equal(config.restBaseUrl, LIVE_REST_BASE_URL);
  assert.ok(Object.isFrozen(config));
});

test('live-config: activation requires LIVE_ENABLED and TRADING_MODE together', () => {
  assert.throws(() => loadLiveConfig({ LIVE_ENABLED: 'true' }), ConfigError);
  assert.throws(() => loadLiveConfig({ LIVE_ENABLED: 'true', TRADING_MODE: 'PAPER' }), ConfigError);

  const config = loadLiveConfig({ LIVE_ENABLED: 'true', TRADING_MODE: 'LIVE' });
  assert.equal(config.enabled, true);
  assert.equal(config.mode, 'LIVE');
});

test('live-config: a live configuration refuses testnet in any form', () => {
  assert.throws(
    () => loadLiveConfig({ LIVE_ENABLED: 'true', TRADING_MODE: 'LIVE', BYBIT_TESTNET: 'true' }),
    ConfigError,
  );
  assert.throws(
    () => loadLiveConfig({ LIVE_ENABLED: 'true', TRADING_MODE: 'LIVE', TESTNET_ENABLED: 'true' }),
    ConfigError,
  );
});

test('live-config: a malformed flag is an error, never a default', () => {
  assert.throws(() => loadLiveConfig({ LIVE_ENABLED: 'maybe' }), ConfigError);
});

test('live-config: live credentials come only from the dedicated live variables', () => {
  // Testnet and operational keys present, live keys absent: must fail closed.
  assert.throws(
    () =>
      loadLiveCredentials({
        BYBIT_TESTNET_API_KEY: 't',
        BYBIT_TESTNET_API_SECRET: 't',
        BYBIT_API_KEY: 'generic',
        BYBIT_API_SECRET: 'generic',
      }),
    ConfigError,
  );

  const credentials = loadLiveCredentials({ BYBIT_LIVE_API_KEY: 'lk', BYBIT_LIVE_API_SECRET: 'ls' });
  assert.deepEqual(credentials, { apiKey: 'lk', apiSecret: 'ls' });
  assert.ok(Object.isFrozen(credentials));
});

// ---------------------------------------------------------------------------
// safety/checklist.mjs
// ---------------------------------------------------------------------------
test('checklist: §46 has fourteen lines, thirteen of them attestable', () => {
  assert.equal(LIVE_CHECKLIST.length, 14);
  assert.equal(LIVE_ATTESTATION_CHECKS.length, 13);
  assert.equal(LIVE_CHECKLIST[13].id, 'live_flag');
  assert.equal(LIVE_CHECKLIST[13].attestable, false);
});

test('checklist: all true passes; missing, false and non-boolean fail', () => {
  const passed = evaluateChecklist(fullEvidence());
  assert.equal(passed.passed, true);
  assert.equal(passed.satisfied.length, 13);
  assert.deepEqual(passed.failed, []);

  const missingEvidence = fullEvidence();
  delete missingEvidence[LIVE_CHECK.BACKTEST];
  const missing = evaluateChecklist(missingEvidence);
  assert.equal(missing.passed, false);
  assert.deepEqual(missing.missing, [LIVE_CHECK.BACKTEST]);
  assert.equal(missing.failed[0].id, LIVE_CHECK.BACKTEST);

  const falseEvidence = fullEvidence();
  falseEvidence[LIVE_CHECK.TESTNET] = false;
  const failed = evaluateChecklist(falseEvidence);
  assert.equal(failed.passed, false);
  assert.equal(failed.failed[0].code, 'LIVE_CHECKLIST_NOT_TRUE');
  assert.deepEqual(failed.missing, []);

  const coerced = fullEvidence();
  // @ts-ignore deliberately wrong type
  coerced[LIVE_CHECK.SECRETS] = 'yes';
  assert.equal(evaluateChecklist(coerced).passed, false);
});

test('checklist: evaluation is deterministic and reports unexpected keys', () => {
  const evidence = { ...fullEvidence(), extra_claim: true };
  assert.deepEqual(evaluateChecklist(evidence), evaluateChecklist(evidence));
  assert.deepEqual(evaluateChecklist(evidence).unexpected, ['extra_claim']);
  assert.equal(evaluateChecklist(null).satisfied.length, 0);
});

// ---------------------------------------------------------------------------
// safety/credential-separation.mjs
// ---------------------------------------------------------------------------
test('credentials: dedicated live credentials are separated', () => {
  const decision = checkCredentialSeparation({
    live: { apiKey: 'lk', apiSecret: 'ls' },
    testnet: { apiKey: 'tk', apiSecret: 'ts' },
    testnetEnabled: false,
  });
  assert.equal(decision.separated, true);
  assert.equal(decision.code, CREDENTIAL_SEPARATION.SEPARATED);
});

test('credentials: missing live credentials fail closed', () => {
  assert.equal(checkCredentialSeparation({}).code, CREDENTIAL_SEPARATION.MISSING_LIVE_CREDENTIALS);
  assert.throws(() => assertCredentialSeparation({}), ConfigError);
});

test('credentials: testnet mode in a live configuration is refused', () => {
  const decision = checkCredentialSeparation({
    live: { apiKey: 'lk', apiSecret: 'ls' },
    testnetEnabled: true,
  });
  assert.equal(decision.separated, false);
  assert.equal(decision.code, CREDENTIAL_SEPARATION.TESTNET_ENABLED_IN_LIVE);
});

test('credentials: a key shared between live and testnet is refused', () => {
  const decision = checkCredentialSeparation({
    live: { apiKey: 'shared', apiSecret: 'ls' },
    testnet: { apiKey: 'shared', apiSecret: 'ts' },
  });
  assert.equal(decision.separated, false);
  assert.equal(decision.code, CREDENTIAL_SEPARATION.SHARED_CREDENTIALS);
});

// ---------------------------------------------------------------------------
// safety/live-gate.mjs
// ---------------------------------------------------------------------------
test('live-gate: a fully satisfied input grants readiness', () => {
  const { input } = readyInput();
  const decision = evaluateLiveReadiness(input);
  assert.equal(decision.allowed, true);
  assert.equal(decision.reasonCode, REASON_CODE.APPROVED);
  assert.deepEqual(decision.failures, []);
  assert.equal(decision.checklist.length, 14);
  assert.ok(decision.checklist.every((item) => item.satisfied));
});

test('live-gate: empty input is refused', () => {
  const decision = evaluateLiveReadiness({});
  assert.equal(decision.allowed, false);
  assert.equal(decision.reasonCode, REASON_CODE.LIVE_GATE_REFUSED);
  assert.ok(decision.failures.length >= 3);
});

test('live-gate: the explicit flag is read from config, not evidence', () => {
  const { input } = readyInput({ config: { enabled: false, mode: 'LIVE' } });
  const decision = evaluateLiveReadiness(input);
  assert.equal(decision.allowed, false);
  assert.ok(decision.failures.some((item) => item.code === REASON_CODE.LIVE_FLAG_NOT_ENABLED && item.id === 'live_flag'));

  // An evidence claim of live_flag=true cannot override the config.
  const spoofed = readyInput({ config: { enabled: false, mode: 'LIVE' }, evidence: { ...fullEvidence(), live_flag: true } });
  assert.equal(evaluateLiveReadiness(spoofed.input).allowed, false);
});

test('live-gate: an unattested checklist item blocks readiness', () => {
  const evidence = fullEvidence();
  delete evidence[LIVE_CHECK.DUPLICATE_ORDER_PROTECTION];
  const { input } = readyInput({ evidence });
  const decision = evaluateLiveReadiness(input);
  assert.equal(decision.allowed, false);
  assert.ok(
    decision.failures.some(
      (item) => item.id === LIVE_CHECK.DUPLICATE_ORDER_PROTECTION && item.code === REASON_CODE.LIVE_CHECKLIST_INCOMPLETE,
    ),
  );
});

test('live-gate: shared or missing credentials block readiness', () => {
  const shared = readyInput({
    credentials: { live: { apiKey: 'same', apiSecret: 'ls' }, testnet: { apiKey: 'same', apiSecret: 'ts' } },
  });
  const decision = evaluateLiveReadiness(shared.input);
  assert.ok(decision.failures.some((item) => item.code === REASON_CODE.LIVE_CREDENTIAL_SEPARATION_FAILED));
});

test('live-gate: invalid risk limits block readiness', () => {
  const { input } = readyInput({ riskConfig: { ...DEFAULT_RISK_LIMITS, maxLeverage: 0 } });
  const decision = evaluateLiveReadiness(input);
  assert.ok(decision.failures.some((item) => item.code === REASON_CODE.LIVE_RISK_CONFIG_INVALID));
});

test('live-gate: an engaged or malformed emergency stop blocks readiness', () => {
  const engaged = readyInput({ killSwitch: createKillSwitch({ engaged: true, reason: 'TEST', now }) });
  assert.ok(
    evaluateLiveReadiness(engaged.input).failures.some((item) => item.code === REASON_CODE.LIVE_KILL_SWITCH_ENGAGED),
  );

  const malformed = readyInput({ killSwitch: { isEngaged: () => false } });
  assert.ok(
    evaluateLiveReadiness(malformed.input).failures.some((item) => item.code === REASON_CODE.LIVE_KILL_SWITCH_INVALID),
  );
});

test('live-gate: a missing audit journal blocks readiness', () => {
  const { input } = readyInput({ journal: null });
  assert.ok(evaluateLiveReadiness(input).failures.some((item) => item.code === REASON_CODE.LIVE_AUDIT_UNAVAILABLE));
});

test('live-gate: evaluation is deterministic', () => {
  const { input } = readyInput();
  assert.deepEqual(evaluateLiveReadiness(input), evaluateLiveReadiness(input));
});

test('live-gate: assertLiveReady returns a decision or throws', () => {
  const { input } = readyInput();
  assert.equal(assertLiveReady(input).allowed, true);
  assert.throws(() => assertLiveReady({}), ConfigError);
  try {
    assertLiveReady({});
    assert.fail('expected a refusal');
  } catch (error) {
    assert.equal(error.name, 'ConfigError');
    assert.equal(error.field, 'LIVE_ENABLED');
  }
});

// ---------------------------------------------------------------------------
// safety/emergency-controls.mjs
// ---------------------------------------------------------------------------
test('emergency controls: engage and release are audited', async () => {
  const fs = memoryFs();
  const journal = createJournal({ filePath: 'memory/journal.jsonl', fs });
  const controls = createEmergencyControls({ killSwitch: createKillSwitch({ now }), journal, now });

  assert.equal(controls.isEngaged(), false);
  const engaged = await controls.engage('MANUAL TEST');
  assert.equal(engaged.engaged, true);
  assert.equal(controls.state().reason, 'MANUAL TEST');

  const released = await controls.release();
  assert.equal(released.engaged, false);

  const events = readEvents(fs, 'memory/journal.jsonl');
  assert.deepEqual(
    events.map((event) => event.eventType),
    [JOURNAL_EVENT.LIVE_EMERGENCY_ENGAGED, JOURNAL_EVENT.LIVE_EMERGENCY_RELEASED],
  );
});

test('emergency controls: a missing journal or kill switch is refused at construction', () => {
  assert.throws(() => createEmergencyControls({ journal: { record: async () => {} } }), ConfigError);
  assert.throws(() => createEmergencyControls({ killSwitch: createKillSwitch({ now }) }), ConfigError);
});

// ---------------------------------------------------------------------------
// session/live-session.mjs
// ---------------------------------------------------------------------------
test('live-session: construction is refused unless the gate passes, and the refusal is audited', async () => {
  const fs = memoryFs();
  const options = {
    config: { enabled: false, mode: 'LIVE' },
    evidence: fullEvidence(),
    credentials: { live: { apiKey: 'lk', apiSecret: 'ls' }, testnetEnabled: false },
    riskConfig: { ...DEFAULT_RISK_LIMITS },
    killSwitch: createKillSwitch({ now }),
    paths: { journalFile: 'memory/live.jsonl' },
    fs,
    now,
  };

  await assert.rejects(() => createLiveSession(options), ConfigError);

  const events = readEvents(fs, 'memory/live.jsonl');
  assert.deepEqual(
    events.map((event) => event.eventType),
    [JOURNAL_EVENT.LIVE_ACTIVATION_ATTEMPTED, JOURNAL_EVENT.LIVE_GATE_EVALUATED, JOURNAL_EVENT.LIVE_ACTIVATION_REFUSED],
  );
});

test('live-session: a ready activation is granted and audited', async () => {
  const { input, fs } = readyInput();
  const session = await createLiveSession({
    ...input,
    paths: { journalFile: 'memory/live.jsonl' },
    fs,
  });

  assert.equal(session.mode, 'LIVE');
  assert.equal(session.activated, true);
  // The gate passing does not mean the build can trade.
  assert.equal(session.executionImplemented, false);

  const events = readEvents(fs, 'memory/live.jsonl');
  assert.deepEqual(
    events.map((event) => event.eventType),
    [JOURNAL_EVENT.LIVE_ACTIVATION_ATTEMPTED, JOURNAL_EVENT.LIVE_GATE_EVALUATED, JOURNAL_EVENT.LIVE_ACTIVATION_GRANTED],
  );
});

test('live-session: every submit is refused and audited, even when ready', async () => {
  const { input, fs } = readyInput();
  const session = await createLiveSession({ ...input, paths: { journalFile: 'memory/live.jsonl' }, fs });

  const result = await session.submit({ symbol: 'BTCUSDT' });
  assert.equal(result.executed, false);
  assert.equal(result.approved, false);
  assert.equal(result.reasonCode, REASON_CODE.LIVE_TRADING_DISABLED);

  const events = readEvents(fs, 'memory/live.jsonl');
  assert.equal(events.at(-1).eventType, JOURNAL_EVENT.LIVE_SUBMIT_REFUSED);
});

test('live-session: the emergency stop disables trading when engaged', async () => {
  const { input, fs } = readyInput();
  const session = await createLiveSession({ ...input, paths: { journalFile: 'memory/live.jsonl' }, fs });

  assert.doesNotThrow(() => session.assertCanTrade());

  await session.engageEmergency('KILL');
  assert.equal(session.isEmergencyEngaged(), true);
  assert.throws(() => session.assertCanTrade(), ConfigError);

  // An engaged stop also turns a submit into a gate refusal.
  const result = await session.submit({ symbol: 'BTCUSDT' });
  assert.equal(result.executed, false);
  assert.equal(result.reasonCode, REASON_CODE.LIVE_GATE_REFUSED);

  await session.releaseEmergency();
  assert.doesNotThrow(() => session.assertCanTrade());

  const events = readEvents(fs, 'memory/live.jsonl');
  assert.ok(events.some((event) => event.eventType === JOURNAL_EVENT.LIVE_EMERGENCY_ENGAGED));
  assert.ok(events.some((event) => event.eventType === JOURNAL_EVENT.LIVE_EMERGENCY_RELEASED));
});

test('live-journal: every LIVE_* event type is accepted by the journal', () => {
  for (const eventType of Object.values(JOURNAL_EVENT).filter((value) => value.startsWith('LIVE_'))) {
    assert.doesNotThrow(() => createJournalEvent({ eventType, timestamp: FIXED_NOW }));
  }
});
