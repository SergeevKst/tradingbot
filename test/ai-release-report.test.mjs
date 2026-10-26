/**
 * UAI-09 — release report contract: NOT_RUN is never PASS, every conformance row
 * is present, every PASS row carries hashed evidence, and the conclusion follows
 * from the rows rather than from prose (C11).
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import {
  CONCLUSION,
  GATE,
  GATES,
  TEST_STATUS,
  XP_IDS,
  validateEvidenceRef,
  validateReleaseReport,
  validateTestRow,
} from '../src/config/ai-release-report.mjs';
import { buildReleaseFixture } from './fixtures/ai-release/factory.mjs';

const fixture = buildReleaseFixture();

const LOG_DIGEST = 'a'.repeat(64);
const TRANSITION_DIGEST = 'b'.repeat(64);
const PARITY_DIGEST = 'c'.repeat(64);

/** @param {Record<string, string>} [overrides] */
function reportWith(overrides = {}) {
  const tests = [
    ...GATES.map((id) => ({ id, status: TEST_STATUS.PASS, evidenceRef: 'evidence/logs/suite.log', evidenceSha256: LOG_DIGEST })),
    ...XP_IDS.map((id) => ({ id, status: TEST_STATUS.PASS, evidenceRef: 'evidence/logs/xp.log', evidenceSha256: LOG_DIGEST })),
  ];
  return {
    schemaVersion: 1,
    releaseId: 'report-test-1',
    deploymentId: '11111111-1111-4111-8111-111111111111',
    sourceTask: 't_c7d379c4',
    candidateBinding: fixture.binding,
    previousBinding: null,
    artifactSet: fixture.artifacts.map((artifact) => ({ ...artifact, sourceCommit: null })),
    inventory: fixture.inventory,
    topologyEvidenceRef: null,
    tests,
    observedParticipants: [{
      slot: 'telegram',
      instanceId: 'inst-1',
      inferenceEnabled: true,
      artifactSha256: fixture.artifactMap.telegram,
      manifestVersion: fixture.binding.manifestVersion,
      manifestSha256: fixture.binding.manifestSha256,
      generation: 1,
      identityReady: true,
    }],
    transitions: [{
      transitionId: '22222222-2222-4222-8222-222222222222',
      fromGeneration: 0,
      toGeneration: 1,
      phase: 'ACTIVE',
      evidenceRef: 'evidence/control/transitions/2222.json',
    }],
    parityReportRef: 'evidence/logs/parity.log',
    modelEvaluationRef: null,
    rollbackReportRef: null,
    financialRiskDispositionRef: null,
    operatorApprovalRef: null,
    evidenceHashes: {
      'evidence/logs/suite.log': LOG_DIGEST,
      'evidence/logs/xp.log': LOG_DIGEST,
      'evidence/logs/parity.log': PARITY_DIGEST,
      'evidence/control/transitions/2222.json': TRANSITION_DIGEST,
    },
    notes: { G1_BASELINE_COMPATIBILITY: 'baseline: 37/40 pass' },
    blockers: [],
    conclusion: CONCLUSION.OFFLINE_CONFORMANT,
    ...overrides,
  };
}

/**
 * @param {Record<string, string>} statuses
 */
function withStatuses(statuses) {
  const report = reportWith();
  report.tests = report.tests.map((row) => (statuses[row.id] ? { ...row, status: statuses[row.id] } : row));
  return report;
}

test('UAI-09 report: a fully conformant offline report validates', () => {
  const validated = validateReleaseReport(reportWith());
  assert.equal(validated.tests.length, GATES.length + XP_IDS.length);
  assert.equal(validated.conclusion, CONCLUSION.OFFLINE_CONFORMANT);
  assert.equal(validated.evidenceHashes['evidence/logs/xp.log'], LOG_DIGEST);
});

test('UAI-09 report: a missing gate or XP row is rejected', () => {
  const missingXp = reportWith();
  missingXp.tests = missingXp.tests.filter((row) => row.id !== 'XP-07');
  assert.throws(() => validateReleaseReport(missingXp), /missing XP-07/);

  const missingGate = reportWith();
  missingGate.tests = missingGate.tests.filter((row) => row.id !== GATE.G4);
  assert.throws(() => validateReleaseReport(missingGate), /missing gate/);
});

test('UAI-09 report: NOT_RUN is not PASS and blocks readiness', () => {
  const partial = withStatuses({ [GATE.G4]: TEST_STATUS.NOT_RUN });
  partial.conclusion = CONCLUSION.READY_FOR_OPERATOR_APPROVAL;
  assert.throws(() => validateReleaseReport(partial), /requires G1–G5/);

  const xpNotRun = withStatuses({ 'XP-11': TEST_STATUS.NOT_RUN });
  xpNotRun.conclusion = CONCLUSION.READY_FOR_OPERATOR_APPROVAL;
  assert.throws(() => validateReleaseReport(xpNotRun), /every XP to PASS/);
});

test('UAI-09 report: a PASS without hashed evidence is refused (C11)', () => {
  const unhashed = reportWith();
  unhashed.tests = unhashed.tests.map((row) => (row.id === GATE.G2 ? { ...row, evidenceRef: null, evidenceSha256: null } : row));
  assert.throws(() => validateReleaseReport(unhashed), /PASS row requires an evidence reference/);

  const noDigest = reportWith();
  noDigest.tests = noDigest.tests.map((row) => (row.id === GATE.G2 ? { ...row, evidenceSha256: null } : row));
  assert.throws(() => validateReleaseReport(noDigest), /both evidenceRef and evidenceSha256/);

  // A ref that no evidence index entry covers cannot be checked on disk.
  const unindexed = reportWith();
  unindexed.tests = unindexed.tests.map((row) => (row.id === GATE.G1
    ? { ...row, evidenceRef: 'evidence/logs/absent.log', evidenceSha256: LOG_DIGEST }
    : row));
  assert.throws(() => validateReleaseReport(unindexed), /missing from evidenceHashes/);

  // A row digest that disagrees with the index would let two numbers drift.
  const drifted = reportWith();
  drifted.tests = drifted.tests.map((row) => (row.id === GATE.G1 ? { ...row, evidenceSha256: 'd'.repeat(64) } : row));
  assert.throws(() => validateReleaseReport(drifted), /does not match evidenceHashes/);
});

test('UAI-09 report: NOT_RUN rows may carry evidence, PASS rows may not be bare', () => {
  const withEvidence = validateTestRow({
    id: GATE.G4,
    status: TEST_STATUS.NOT_RUN,
    evidenceRef: 'evidence/topology-evidence.md',
    evidenceSha256: 'e'.repeat(64),
  });
  assert.equal(withEvidence.status, TEST_STATUS.NOT_RUN);
  assert.equal(withEvidence.evidenceSha256, 'e'.repeat(64));
  assert.throws(
    () => validateTestRow({ id: GATE.G7, status: TEST_STATUS.PASS, evidenceRef: null, evidenceSha256: null }),
    /PASS row requires an evidence reference/,
  );
});

test('UAI-09 report: evidence refs must be dossier-relative and non-traversing', () => {
  assert.equal(validateEvidenceRef('evidence/logs/xp.log'), 'evidence/logs/xp.log');
  assert.equal(validateEvidenceRef(null), null);
  for (const bad of ['/etc/passwd', '../escape.log', 'evidence/../../x.log', 'evidence\\x.log', 'evidence//x.log', 'evidence/./x.log']) {
    assert.throws(() => validateEvidenceRef(bad), /dossier-relative|must not contain/, bad);
  }
});

test('UAI-09 report: ACTIVATION_VERIFIED needs every gate including G6/G7', () => {
  const verified = withStatuses({ [GATE.G7]: TEST_STATUS.NOT_RUN });
  verified.conclusion = CONCLUSION.ACTIVATION_VERIFIED;
  assert.throws(() => validateReleaseReport(verified), /every XP and every gate/);

  // The schema can only check the rows; it cannot tell an offline dossier from a
  // live run. The verifier always emits G7=NOT_RUN, so an all-PASS row set is
  // reachable only from an authorized post-activation verification.
  const full = reportWith({ operatorApprovalRef: 'evidence/approval-1.md', evidenceHashes: { ...reportWith().evidenceHashes, 'evidence/approval-1.md': 'f'.repeat(64) } });
  const validated = validateReleaseReport({ ...full, conclusion: CONCLUSION.ACTIVATION_VERIFIED });
  assert.equal(validated.conclusion, CONCLUSION.ACTIVATION_VERIFIED);
});

test('UAI-09 report: duplicate rows, bad statuses and non-monotonic generations fail', () => {
  const duplicate = reportWith();
  duplicate.tests = [...duplicate.tests, { id: 'XP-01', status: TEST_STATUS.PASS, evidenceRef: 'evidence/logs/xp.log', evidenceSha256: LOG_DIGEST }];
  assert.throws(() => validateReleaseReport(duplicate), /duplicate test row/);

  const badStatus = reportWith();
  badStatus.tests[0] = { ...badStatus.tests[0], status: 'SKIPPED' };
  assert.throws(() => validateReleaseReport(badStatus), /must be PASS, FAIL or NOT_RUN/);

  const backwards = reportWith();
  backwards.transitions = [{ ...backwards.transitions[0], fromGeneration: 3, toGeneration: 2 }];
  assert.throws(() => validateReleaseReport(backwards), /monotonic/);
});

test('UAI-09 report: unknown fields and missing binding hashes are rejected', () => {
  const extra = reportWith({ extra: true });
  assert.throws(() => validateReleaseReport(extra), /unknown field/);
  const badBinding = reportWith({ candidateBinding: { ...fixture.binding, manifestSha256: 'nope' } });
  assert.throws(() => validateReleaseReport(badBinding), /SHA-256/);
  const missingIndex = reportWith();
  delete missingIndex.evidenceHashes;
  assert.throws(() => validateReleaseReport(missingIndex), /evidenceHashes/);
});

test('UAI-09 report: the dossier report on disk is valid and self-consistent', () => {
  const file = path.resolve(import.meta.dirname, '..', 'docs', 'architecture', 'unified-ai', 'release-report.json');
  if (!fs.existsSync(file)) {
    // The dossier report is a generated artefact; absent in a clean checkout is
    // not a failure, but a present one must validate.
    return;
  }
  const report = validateReleaseReport(JSON.parse(fs.readFileSync(file, 'utf8')));
  const byId = new Map(report.tests.map((row) => [row.id, row.status]));
  for (const xp of XP_IDS) assert.equal(byId.get(xp), TEST_STATUS.PASS);
  assert.notEqual(byId.get(GATE.G7), TEST_STATUS.PASS, 'an offline dossier cannot verify a live release');

  // The conclusion must follow from the rows: an offline dossier is either
  // conformant with no failing gate, or blocked with a stated reason.
  const failingGates = [GATE.G1, GATE.G2, GATE.G3, GATE.G5].filter((id) => byId.get(id) === TEST_STATUS.FAIL);
  if (report.conclusion === CONCLUSION.OFFLINE_CONFORMANT) {
    assert.deepEqual(failingGates, [], 'OFFLINE_CONFORMANT cannot hide a failing gate');
  } else if (report.conclusion === CONCLUSION.BLOCKED) {
    assert.ok(failingGates.length > 0, 'BLOCKED must name a failing gate');
  }
  assert.ok(report.blockers.length > 0, 'an offline dossier must state what is still missing');

  // Every referenced file must exist in the dossier (C11: absent evidence can
  // never read as PASS). The digests themselves are re-checked by
  // `ai_release_verify.mjs --check`, which is the release gate.
  for (const row of report.tests.filter((entry) => entry.evidenceRef !== null)) {
    const absolute = path.resolve(path.dirname(file), row.evidenceRef);
    assert.ok(fs.existsSync(absolute), `${row.id} evidence ${row.evidenceRef} exists`);
  }
  // Identity readiness is observed, never copied from the roster.
  assert.ok(report.notes.observation.includes('ai_participant_probe.mjs'));
  assert.ok(report.notes.G1_BASELINE_COMPATIBILITY.includes('baseline'));
  assert.ok(report.notes.G5_REHEARSAL.includes('rehearsal-report.json'));
});
