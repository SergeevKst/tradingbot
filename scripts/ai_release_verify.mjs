#!/usr/bin/env node
/**
 * Release verification report compiler (UAI-09, architecture §4, C11).
 *
 * Turns *actual* run logs and the durable release evidence into the closed
 * machine-readable report. Nothing is asserted without a reference:
 *
 *   - every gate and XP row points at a dossier-relative file, and the digest of
 *     that file is recorded in `evidenceHashes`;
 *   - `--check` re-hashes every referenced file in a committed report and fails
 *     when one is missing or changed (absent evidence can never read as PASS);
 *   - `identityReady` is observed by spawning `scripts/ai_participant_probe.mjs`
 *     per committed participant, not copied from the roster;
 *   - G1 is computed from a *baseline* log at the pinned commit, never from the
 *     candidate log;
 *   - G5 is computed from the rehearsal report plus the rehearsal XP rows.
 *
 * It never activates, deploys or fabricates a participant inventory. `G7` (the
 * real post-activation verification) is always `NOT_RUN` here, because it
 * requires an authorized live operation.
 *
 * Usage (generate):
 *   node scripts/ai_release_verify.mjs --control-dir DIR --descriptor-sha SHA \
 *     --candidate-log CANDIDATE.log --baseline-log BASELINE.log \
 *     --xp-log XP.log --rehearsal-report FILE --out REPORT.json [...]
 *
 * Usage (validate a committed report against the dossier):
 *   node scripts/ai_release_verify.mjs --check REPORT.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { sha256Hex } from '../src/config/jcs.mjs';
import { createControlStore } from '../src/ai/coordination/control-store.mjs';
import {
  CONCLUSION,
  GATE,
  GATES,
  TEST_STATUS,
  XP_IDS,
  validateReleaseReport,
} from '../src/config/ai-release-report.mjs';
import { computeReleaseDescriptorDigest, validateReleaseDescriptor } from '../src/config/ai-release-schema.mjs';

const { values } = parseArgs({
  options: {
    check: { type: 'string' },
    'control-dir': { type: 'string' },
    'descriptor-sha': { type: 'string' },
    'previous-descriptor-sha': { type: 'string' },
    'candidate-log': { type: 'string' },
    'baseline-log': { type: 'string' },
    'xp-log': { type: 'string' },
    'parity-log': { type: 'string' },
    'rehearsal-report': { type: 'string' },
    'rehearsal-log': { type: 'string' },
    'baseline-commit': { type: 'string' },
    out: { type: 'string' },
    'source-task': { type: 'string', default: 't_c7d379c4' },
    'release-id': { type: 'string', default: 'uai-v1.1-local-1' },
    'topology-evidence': { type: 'string' },
    'operator-approval': { type: 'string' },
    'model-evaluation': { type: 'string' },
    'financial-risk': { type: 'string' },
    'probe-script': { type: 'string', default: 'scripts/ai_participant_probe.mjs' },
    verbose: { type: 'boolean', default: false },
  },
});

/**
 * Known, separately justified stale prompt-layout tests in the pinned baseline.
 * They are unrelated to the AI release protocol and are documented in the
 * dossier; any *other* failure fails G1.
 */
const STALE_BASELINE_FAILURES = Object.freeze([
  'G-5: buildGuardPrompt version is risk-guard-v2 with expected payload keys',
  'S-5: buildScoutPrompt strips instrument from symbols in user payload',
  'buildMonitorPrompt/buildStopcheckPrompt versions and payload keys',
]);

/**
 * @param {string} file
 * @returns {string}
 */
function readLog(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (values.verbose) process.stderr.write(`${file}: ${text.length} bytes\n`);
  return text;
}

/**
 * @param {string} text
 */
function parseTap(text) {
  /** @type {{ id: string, ok: boolean }[]} */
  const tests = [];
  const summary = { tests: 0, pass: 0, fail: 0, skipped: 0 };
  for (const line of text.split('\n')) {
    const notOk = /^not ok \d+ - (.*)$/.exec(line);
    const ok = /^ok \d+ - (.*)$/.exec(line);
    if (notOk) tests.push({ id: notOk[1].trim(), ok: false });
    else if (ok) tests.push({ id: ok[1].trim(), ok: true });
    const testsMatch = /^# tests (\d+)$/.exec(line);
    if (testsMatch) summary.tests = Number(testsMatch[1]);
    const passMatch = /^# pass (\d+)$/.exec(line);
    if (passMatch) summary.pass = Number(passMatch[1]);
    const failMatch = /^# fail (\d+)$/.exec(line);
    if (failMatch) summary.fail = Number(failMatch[1]);
    const skipMatch = /^# skipped (\d+)$/.exec(line);
    if (skipMatch) summary.skipped = Number(skipMatch[1]);
  }
  return { tests, summary };
}

/**
 * The dossier the report lives in. Every reference is relative to it, so the
 * report can be moved with its evidence and still check out.
 *
 * @param {string} reportPath
 */
function dossier(reportPath) {
  const root = path.dirname(path.resolve(reportPath));
  return {
    root,
    /**
     * @param {string} file absolute or dossier-relative path
     * @returns {string} dossier-relative POSIX ref
     */
    ref(file) {
      const absolute = path.resolve(file);
      return path.relative(root, absolute).split(path.sep).join('/');
    },
    /**
     * @param {string} ref
     * @returns {string} absolute path
     */
    resolve(ref) {
      return path.resolve(root, ref);
    },
    /**
     * Register a file in the evidence index and return its ref + digest.
     *
     * @param {Record<string, string>} index
     * @param {string} file
     */
    index(index, file) {
      const ref = this.ref(file);
      const absolute = this.resolve(ref);
      if (!fs.existsSync(absolute)) {
        throw new Error(`evidence file ${ref} does not exist`);
      }
      index[ref] = sha256Hex(fs.readFileSync(absolute));
      return { ref, sha256: index[ref] };
    },
  };
}

/**
 * Re-hash every referenced file of a committed report. Absent evidence is a
 * failure, never a PASS.
 *
 * @param {any} report
 * @param {{ root: string, resolve: (ref: string) => string }} scope
 */
function verifyEvidence(report, scope) {
  /** @type {{ ref: string, problem: string }[]} */
  const problems = [];
  /** @type {string[]} */
  const referenced = [];
  for (const key of ['topologyEvidenceRef', 'parityReportRef', 'rollbackReportRef', 'modelEvaluationRef', 'financialRiskDispositionRef', 'operatorApprovalRef']) {
    if (typeof report[key] === 'string') referenced.push(report[key]);
  }
  for (const row of report.tests) {
    if (row.evidenceRef !== null) referenced.push(row.evidenceRef);
  }
  for (const row of report.transitions) {
    if (row.evidenceRef !== null) referenced.push(row.evidenceRef);
  }
  const unique = [...new Set(referenced)];
  for (const ref of unique) {
    const absolute = scope.resolve(ref);
    if (!fs.existsSync(absolute)) {
      problems.push({ ref, problem: 'missing' });
      continue;
    }
    const expected = report.evidenceHashes?.[ref];
    if (typeof expected !== 'string') {
      problems.push({ ref, problem: 'not indexed in evidenceHashes' });
      continue;
    }
    const actual = sha256Hex(fs.readFileSync(absolute));
    if (actual !== expected) {
      problems.push({ ref, problem: `digest mismatch (report ${expected.slice(0, 12)}…, file ${actual.slice(0, 12)}…)` });
    }
  }
  // An entry that is indexed but never referenced is allowed (supporting logs
  // are part of the dossier manifest), but it must still exist and match: the
  // index is a hash manifest, not a wish list.
  for (const ref of Object.keys(report.evidenceHashes ?? {})) {
    if (unique.includes(ref)) continue;
    const absolute = scope.resolve(ref);
    if (!fs.existsSync(absolute)) {
      problems.push({ ref, problem: 'indexed but missing' });
      continue;
    }
    const actual = sha256Hex(fs.readFileSync(absolute));
    if (actual !== report.evidenceHashes[ref]) {
      problems.push({ ref, problem: 'indexed digest does not match the file' });
    }
  }
  return problems;
}

/**
 * G5 evaluation, kept pure so it can be tested without a dossier.
 *
 * A rehearsal only proves a *full* G5 when the control-plane half (forward
 * activation plus rollback at a strictly higher generation, with the
 * interrupted-transition/rollback XP rows) AND the financial half (journal
 * residual hashes equal before/after excluding exactly the fixture-declared
 * deterministic actions, and no duplicate entry) are all evidenced. The
 * financial half is proven on the rehearsal's synthetic fixture journal; live
 * financial-state equivalence remains a G7/operator obligation and the note says
 * so, so a PASS row can never be read as a live financial guarantee.
 *
 * @param {any} rehearsal
 * @param {{ id: string, status: string }[]} xp
 */
export function evaluateG5(rehearsal, xp) {
  const phases = Array.isArray(rehearsal?.phases) ? rehearsal.phases : [];
  const activations = phases.filter((entry) => entry?.phase === 'ACTIVE');
  const generations = activations
    .map((entry) => entry?.generation)
    .filter((value) => Number.isSafeInteger(value));
  const advanced = rehearsal?.ok === true
    && generations.length >= 2
    && Math.max(...generations) > Math.min(...generations)
    && typeof rehearsal?.forward?.transitionId === 'string'
    && typeof rehearsal?.rollback?.transitionId === 'string';
  const financial = rehearsal?.financialState;
  const residualEqual = financial?.residualEqual === true
    && typeof financial?.residualBeforeSha256 === 'string'
    && financial.residualBeforeSha256 === financial.residualAfterSha256;
  const noDuplicateEntry = financial?.noDuplicateEntry === true
    && Array.isArray(financial?.duplicateEntryIds)
    && financial.duplicateEntryIds.length === 0;
  const declaredApplied = financial?.declaredActionsApplied === true;
  const xpOk = ['XP-09', 'XP-10', 'XP-17']
    .every((id) => xp.find((row) => row.id === id)?.status === TEST_STATUS.PASS);

  /** @type {string[]} */
  const missing = [];
  if (!advanced) missing.push('forward activation and rollback at a higher generation');
  if (!residualEqual) missing.push('financial journal residual hash equal before/after');
  if (!noDuplicateEntry) missing.push('no duplicate journal entry');
  if (!declaredApplied) missing.push('declared deterministic actions applied exactly once');
  if (!xpOk) missing.push('XP-09/XP-10/XP-17 rows');
  const status = missing.length === 0 ? TEST_STATUS.PASS : TEST_STATUS.FAIL;

  const declaredKinds = (financial?.declaredActions ?? []).map((action) => action.kind).join('; ') || 'none';
  const note = [
    `rehearsal-report.json: activations at generations [${generations.join(', ')}]`,
    `forward ${rehearsal?.forward?.transitionId ?? 'none'}, rollback ${rehearsal?.rollback?.transitionId ?? 'none'} (via ${rehearsal?.rollback?.via ?? 'unspecified'})`,
    `fixture journal ${financial?.entryCountBefore ?? '?'}→${financial?.entryCountAfter ?? '?'} entries with declared deterministic actions [${declaredKinds}]`,
    `journal sha256 before ${String(financial?.journalBeforeSha256 ?? 'none').slice(0, 16)}…, after ${String(financial?.journalAfterSha256 ?? 'none').slice(0, 16)}…`,
    `residual equal after removing the declared actions: ${residualEqual ? 'yes' : 'no'}`,
    `duplicate entries: ${noDuplicateEntry ? 'none' : JSON.stringify(financial?.duplicateEntryIds)}`,
    'the financial-state criterion is proven on the synthetic fixture journal only; live financial state/journal equivalence and duplicate-entry absence remain G7/operator obligations',
    `${xpOk ? 'XP-09/XP-10/XP-17 pass' : 'XP-09/XP-10/XP-17 do not pass'}`,
  ].join('; ');
  return {
    status,
    note: missing.length === 0 ? note : `${note}; missing evidence: ${missing.join('; ')}`,
    advanced,
    residualEqual,
    noDuplicateEntry,
    declaredApplied,
    xpOk,
  };
}

function main() {
  // ---- validate-only mode -------------------------------------------------
  if (values.check) {
    const reportPath = path.resolve(values.check);
    const raw = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    const report = validateReleaseReport(raw);
    const problems = verifyEvidence(report, dossier(reportPath));
    const passRowsWithoutEvidence = report.tests.filter(
      (row) => row.status === TEST_STATUS.PASS && (row.evidenceRef === null || row.evidenceSha256 === null),
    );
    for (const row of passRowsWithoutEvidence) {
      problems.push({ ref: row.id, problem: 'PASS row without hashed evidence' });
    }
    process.stdout.write(`${JSON.stringify({
      ok: problems.length === 0,
      mode: 'check',
      report: reportPath,
      conclusion: report.conclusion,
      gates: Object.fromEntries(report.tests.filter((row) => GATES.includes(row.id)).map((row) => [row.id, row.status])),
      evidenceRefs: Object.keys(report.evidenceHashes),
      problems,
    })}\n`);
    if (problems.length > 0) process.exitCode = 1;
    return;
  }

  // ---- generate mode ------------------------------------------------------
  const requiredArgs = ['control-dir', 'descriptor-sha', 'candidate-log', 'baseline-log', 'xp-log', 'rehearsal-report', 'out'];
  for (const name of requiredArgs) {
    if (!values[name]) {
      process.stderr.write(`${JSON.stringify({ ok: false, error: { code: 'USAGE', message: `missing --${name}` } })}\n`);
      process.exitCode = 2;
      return;
    }
  }
  const scope = dossier(values.out);
  /** @type {Record<string, string>} */
  const index = {};

  const controlDir = path.resolve(values['control-dir']);
  const store = createControlStore({ controlDir });
  const record = store.readRecord();
  const { descriptor } = store.readReleaseDescriptor(values['descriptor-sha']);
  validateReleaseDescriptor(descriptor);
  const committed = record.phase === 'ACTIVE' ? record.active : record.target;

  const candidateLog = parseTap(readLog(values['candidate-log']));
  const baselineLog = parseTap(readLog(values['baseline-log']));
  const xpLog = parseTap(readLog(values['xp-log']));
  const rehearsal = JSON.parse(fs.readFileSync(values['rehearsal-report'], 'utf8'));

  if (path.resolve(values['baseline-log']) === path.resolve(values['candidate-log'])) {
    throw new Error('--baseline-log must be a run of the pinned baseline, not the candidate log');
  }
  const baselineFailures = baselineLog.tests.filter((row) => !row.ok).map((row) => row.id);
  const staleOnly = baselineFailures.length > 0
    && baselineFailures.length <= STALE_BASELINE_FAILURES.length
    && baselineFailures.every((id) => STALE_BASELINE_FAILURES.some((known) => id.startsWith(known)));
  const candidateFailures = candidateLog.tests.filter((row) => !row.ok).map((row) => row.id);

  const xp = XP_IDS.map((id) => {
    const match = xpLog.tests.find((row) => row.id.startsWith(id));
    return {
      id,
      status: match === undefined ? TEST_STATUS.NOT_RUN : (match.ok ? TEST_STATUS.PASS : TEST_STATUS.FAIL),
      file: values['xp-log'],
    };
  });

  // G1 — baseline compatibility. Two distinct facts, both recorded:
  //   the pinned baseline has exactly the documented stale failures, and the
  //   candidate has no failure outside that same documented set.
  const g1 = baselineLog.tests.length > 0
    && (baselineFailures.length === 0 || staleOnly)
    && candidateFailures.every((id) => STALE_BASELINE_FAILURES.some((known) => id.startsWith(known)))
    ? TEST_STATUS.PASS
    : TEST_STATUS.FAIL;
  const g1Note = `baseline ${values['baseline-commit'] ?? '(unspecified commit)'}: ${baselineLog.summary.pass}/${baselineLog.summary.tests} pass, failures = [${baselineFailures.join('; ') || 'none'}]; candidate: ${candidateLog.summary.pass}/${candidateLog.summary.tests} pass, failures = [${candidateFailures.join('; ') || 'none'}]; only the documented stale prompt-layout tests may fail on either side`;

  // G2 — cross-process conformance on the candidate.
  const xpFailures = xp.filter((row) => row.status !== TEST_STATUS.PASS).map((row) => row.id);
  const g2 = xpFailures.length === 0 ? TEST_STATUS.PASS : TEST_STATUS.FAIL;

  // G3 — artifact/config: descriptor, manifest and profile revalidate, and the
  // committed binding matches the descriptor.
  const bindingMatches = committed !== null
    && committed.manifestSha256 === descriptor.binding.manifestSha256
    && committed.capabilityProfileSha256 === descriptor.binding.capabilityProfileSha256
    && committed.inventorySha256 === descriptor.binding.inventorySha256;
  const g3 = bindingMatches ? TEST_STATUS.PASS : TEST_STATUS.FAIL;

  // G4 — topology/safety: only an operator can establish it.
  const topology = values['topology-evidence'] ? fs.readFileSync(values['topology-evidence'], 'utf8') : null;
  const topologyVerified = topology !== null && /verified:\s*true/i.test(topology);
  const g4 = topologyVerified ? TEST_STATUS.PASS : TEST_STATUS.NOT_RUN;

  // G5 — rehearsal with fake effects: forward activation to a higher generation
  // plus a rollback, the interrupted-transition/rollback XP rows, and the
  // fixture-journal properties (unchanged financial state except the declared
  // deterministic actions, no duplicate entry). A row that lacks any of those is
  // FAIL, so a PASS never overstates what the rehearsal proved.
  const g5Evaluation = evaluateG5(rehearsal, xp);
  const g5 = g5Evaluation.status;
  const g5Note = g5Evaluation.note;

  // G6/G7 — human authorization and live verification cannot be produced here.
  const g6 = values['operator-approval'] ? TEST_STATUS.PASS : TEST_STATUS.NOT_RUN;
  const g7 = TEST_STATUS.NOT_RUN;

  /**
   * @param {string} id
   * @param {string} status
   * @param {string[]} files
   */
  const row = (id, status, files) => {
    const refs = files.filter(Boolean).map((file) => scope.index(index, file));
    return {
      id,
      status,
      evidenceRef: refs[0]?.ref ?? null,
      evidenceSha256: refs[0]?.sha256 ?? null,
    };
  };

  const tests = [
    row(GATE.G1, g1, [values['baseline-log'], values['candidate-log']]),
    row(GATE.G2, g2, [values['xp-log']]),
    row(GATE.G3, g3, [path.join(controlDir, 'releases', `${values['descriptor-sha']}.json`)]),
    row(GATE.G4, g4, [values['topology-evidence']]),
    row(GATE.G5, g5, [values['rehearsal-report'], values['rehearsal-log']]),
    row(GATE.G6, g6, [values['operator-approval']]),
    row(GATE.G7, g7, []),
    ...xp.map((entry) => row(entry.id, entry.status, entry.status === TEST_STATUS.NOT_RUN ? [] : [entry.file])),
  ];

  // ---- observed participants ---------------------------------------------
  // Each enabled/committed member is validated by a separate process now; the
  // report never copies `identityReady` from the roster.
  const roster = record.phase === 'ACTIVE' ? record.members : (record.transition?.targetMembers ?? []);
  const observedParticipants = roster.map((member) => {
    const inventoryEntry = descriptor.inventory.find((entry) => entry.slot === member.slot);
    const probe = spawnSync(process.execPath, [
      path.resolve(values['probe-script']),
      '--control-dir', controlDir,
      '--deployment-id', record.deploymentId,
      '--slot', member.slot,
      '--instance-id', member.instanceId,
      '--expected-manifest-version', descriptor.binding.manifestVersion,
      '--expected-manifest-sha', descriptor.binding.manifestSha256,
      '--artifact-sha', member.artifactSha256,
    ], { encoding: 'utf8' });
    /** @type {any} */
    let result = null;
    try {
      result = JSON.parse(probe.stdout.trim());
    } catch {
      result = null;
    }
    const observed = result?.ok === true ? result : null;
    return {
      slot: member.slot,
      instanceId: member.instanceId,
      inferenceEnabled: Boolean(inventoryEntry?.enabled) && observed?.inferenceEnabled === true,
      artifactSha256: member.artifactSha256,
      manifestVersion: descriptor.binding.manifestVersion,
      manifestSha256: descriptor.binding.manifestSha256,
      generation: record.phase === 'ACTIVE' ? record.generation : record.nextGeneration ?? record.generation,
      identityReady: observed?.identityReady === true,
    };
  });

  // ---- transitions, read from the durable archives ------------------------
  const transitionsDir = path.join(controlDir, 'transitions');
  const transitions = [];
  if (fs.existsSync(transitionsDir)) {
    for (const name of fs.readdirSync(transitionsDir).filter((entry) => entry.endsWith('.json')).sort()) {
      const archive = JSON.parse(fs.readFileSync(path.join(transitionsDir, name), 'utf8'));
      const indexed = scope.index(index, path.join(transitionsDir, name));
      transitions.push({
        transitionId: archive.transitionId,
        fromGeneration: archive.fromGeneration,
        toGeneration: archive.toGeneration,
        phase: archive.phase,
        evidenceRef: indexed.ref,
      });
    }
  }

  const previousBinding = values['previous-descriptor-sha']
    ? store.readReleaseDescriptor(values['previous-descriptor-sha']).descriptor.binding
    : null;

  // The synthetic-artifact disclosure is part of the dossier manifest even
  // though no row cites it, so pin its bytes in `evidenceHashes` as well: the
  // index must not be editable without breaking the check pass.
  const evidenceIndexFile = path.join(scope.root, 'evidence', 'evidence-index.json');
  if (fs.existsSync(evidenceIndexFile)) {
    scope.index(index, evidenceIndexFile);
  }

  const notes = {
    G1_BASELINE_COMPATIBILITY: g1Note,
    G2_CROSS_PROCESS: `${xpLog.summary.pass}/${xpLog.summary.tests} pass in the candidate cross-process run (real child processes and the real release CLI)`,
    G5_REHEARSAL: g5Note,
    observation: 'identityReady comes from scripts/ai_participant_probe.mjs (one process per participant, side-effect free) reading the committed control record; process liveness and host topology remain G4/G7 and are not claimed',
  };

  const report = validateReleaseReport({
    schemaVersion: 1,
    releaseId: values['release-id'],
    deploymentId: record.deploymentId,
    sourceTask: values['source-task'],
    candidateBinding: descriptor.binding,
    previousBinding,
    artifactSet: descriptor.artifacts.map((artifact) => ({
      slot: artifact.slot,
      artifactSha256: artifact.artifactSha256,
      sourceCommit: null,
    })),
    inventory: descriptor.inventory,
    topologyEvidenceRef: values['topology-evidence'] ? scope.index(index, values['topology-evidence']).ref : null,
    tests,
    observedParticipants,
    transitions,
    parityReportRef: values['parity-log'] ? scope.index(index, values['parity-log']).ref : null,
    modelEvaluationRef: values['model-evaluation'] ? scope.index(index, values['model-evaluation']).ref : null,
    rollbackReportRef: scope.index(index, values['rehearsal-report']).ref,
    financialRiskDispositionRef: values['financial-risk'] ? scope.index(index, values['financial-risk']).ref : null,
    operatorApprovalRef: values['operator-approval'] ? scope.index(index, values['operator-approval']).ref : null,
    evidenceHashes: index,
    notes,
    blockers: (() => {
      const blockers = [];
      if (g1 !== TEST_STATUS.PASS) blockers.push('baseline and candidate differ from the documented stale prompt-layout set');
      for (const id of xpFailures) blockers.push(`${id} did not pass in the exact-candidate cross-process run`);
      if (g3 !== TEST_STATUS.PASS) blockers.push('the committed binding does not match the candidate descriptor');
      if (g4 !== TEST_STATUS.PASS) blockers.push('operator must verify one host, one shared local filesystem and the full participant inventory (G4)');
      if (g5 !== TEST_STATUS.PASS) blockers.push('the fake-effects rehearsal does not prove forward activation, rollback, the fixture-journal equality or the no-duplicate-entry property (G5)');
      if (g6 !== TEST_STATUS.PASS) blockers.push('operator/model/financial approval is not recorded (G6)');
      blockers.push('G7 live post-activation verification requires an authorized release operation');
      return blockers;
    })(),
    conclusion: [g1, g2, g3, g5].some((status) => status === TEST_STATUS.FAIL)
      ? CONCLUSION.BLOCKED
      : CONCLUSION.OFFLINE_CONFORMANT,
  });

  // The written report must survive its own evidence check before it is trusted.
  const problems = verifyEvidence(report, scope);
  fs.mkdirSync(path.dirname(path.resolve(values.out)), { recursive: true });
  fs.writeFileSync(path.resolve(values.out), `${JSON.stringify(report, null, 2)}\n`);

  process.stdout.write(`${JSON.stringify({
    ok: problems.length === 0 && report.conclusion !== CONCLUSION.BLOCKED,
    conclusion: report.conclusion,
    report: path.resolve(values.out),
    gates: Object.fromEntries(report.tests.filter((entry) => GATES.includes(entry.id)).map((entry) => [entry.id, entry.status])),
    xp: Object.fromEntries(xp.map((entry) => [entry.id, entry.status])),
    baseline: baselineLog.summary,
    candidate: candidateLog.summary,
    observedParticipants: report.observedParticipants.map((entry) => ({ slot: entry.slot, identityReady: entry.identityReady })),
    descriptorSha256: computeReleaseDescriptorDigest(descriptor),
    evidenceRefs: Object.keys(index).length,
    evidenceProblems: problems,
    blockers: report.blockers,
  })}\n`);
  if (problems.length > 0) process.exitCode = 1;
  else if (report.conclusion === CONCLUSION.BLOCKED) process.exitCode = 1;
}

try {
  const isEntryPoint = path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1] ?? '');
  if (isEntryPoint) main();
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: { code: error?.code ?? 'UNEXPECTED_ERROR', message: error instanceof Error ? error.message : String(error) },
  })}\n`);
  process.exitCode = 1;
}

export { parseTap, verifyEvidence, STALE_BASELINE_FAILURES };
