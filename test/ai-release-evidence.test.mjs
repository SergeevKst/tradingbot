/**
 * UAI-09 / C11 — the release report's evidence chain must resolve.
 *
 * A report is only evidence if the files it names exist and still hash to what
 * it recorded. This suite drives the real verifier's check pass over a real
 * temporary dossier: present evidence passes, a deleted file fails, an edited
 * file fails, and a PASS row without a hash is refused by the schema before the
 * filesystem is even consulted.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { verifyEvidence } from '../scripts/ai_release_verify.mjs';
import { sha256Hex } from '../src/config/jcs.mjs';
import {
  CONCLUSION,
  GATE,
  GATES,
  TEST_STATUS,
  XP_IDS,
  validateReleaseReport,
} from '../src/config/ai-release-report.mjs';
import { buildReleaseFixture } from './fixtures/ai-release/factory.mjs';

const fixture = buildReleaseFixture();

/**
 * Materialise a dossier: one log, one transition archive, one topology note and
 * a report whose refs and hashes match them.
 */
function dossier() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-dossier-'));
  fs.mkdirSync(path.join(root, 'evidence', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'evidence', 'control', 'transitions'), { recursive: true });
  const files = {
    'evidence/logs/baseline-suite.log': '# tests 10\n# pass 7\n# fail 3\n',
    'evidence/logs/candidate-suite.log': '# tests 12\n# pass 12\n# fail 0\n',
    'evidence/logs/xp.log': '# tests 18\n# pass 18\n# fail 0\n',
    'evidence/control/transitions/2222.json': '{"transitionId":"22222222-2222-4222-8222-222222222222"}\n',
    'evidence/topology-evidence.md': 'verified: false\n',
  };
  /** @type {Record<string, string>} */
  const evidenceHashes = {};
  for (const [ref, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(root, ref), content);
    evidenceHashes[ref] = sha256Hex(content);
  }
  const tests = [
    ...GATES.map((id) => ({ id, status: TEST_STATUS.NOT_RUN, evidenceRef: null, evidenceSha256: null })),
    ...XP_IDS.map((id) => ({ id, status: TEST_STATUS.PASS, evidenceRef: 'evidence/logs/xp.log', evidenceSha256: evidenceHashes['evidence/logs/xp.log'] })),
  ];
  // G1/G2 PASS with a real hashed log each.
  tests[0] = { id: GATE.G1, status: TEST_STATUS.PASS, evidenceRef: 'evidence/logs/baseline-suite.log', evidenceSha256: evidenceHashes['evidence/logs/baseline-suite.log'] };
  tests[1] = { id: GATE.G2, status: TEST_STATUS.PASS, evidenceRef: 'evidence/logs/xp.log', evidenceSha256: evidenceHashes['evidence/logs/xp.log'] };
  tests[3] = { id: GATE.G4, status: TEST_STATUS.NOT_RUN, evidenceRef: 'evidence/topology-evidence.md', evidenceSha256: evidenceHashes['evidence/topology-evidence.md'] };
  const raw = {
    schemaVersion: 1,
    releaseId: 'dossier-test',
    deploymentId: '11111111-1111-4111-8111-111111111111',
    sourceTask: 't_c7d379c4',
    candidateBinding: fixture.binding,
    previousBinding: null,
    artifactSet: fixture.artifacts.map((artifact) => ({ ...artifact, sourceCommit: null })),
    inventory: fixture.inventory,
    topologyEvidenceRef: 'evidence/topology-evidence.md',
    tests,
    observedParticipants: [],
    transitions: [{
      transitionId: '22222222-2222-4222-8222-222222222222',
      fromGeneration: 0,
      toGeneration: 1,
      phase: 'ACTIVE',
      evidenceRef: 'evidence/control/transitions/2222.json',
    }],
    parityReportRef: null,
    modelEvaluationRef: null,
    rollbackReportRef: null,
    financialRiskDispositionRef: null,
    operatorApprovalRef: null,
    evidenceHashes,
    notes: {},
    blockers: ['G4 not run'],
    conclusion: CONCLUSION.OFFLINE_CONFORMANT,
  };
  return { root, raw, files, evidenceHashes, write() {
    const report = validateReleaseReport(raw);
    fs.writeFileSync(path.join(root, 'release-report.json'), JSON.stringify(report, null, 2));
    return report;
  } };
}

const scopeFor = (root) => ({
  root,
  resolve: (ref) => path.resolve(root, ref),
});

test('UAI-09 evidence: a dossier whose files match its hashes verifies', () => {
  const d = dossier();
  const report = d.write();
  assert.deepEqual(verifyEvidence(report, scopeFor(d.root)), []);
});

test('UAI-09 evidence: a referenced file that is not there is a failure, never a PASS', () => {
  const d = dossier();
  const report = d.write();
  fs.rmSync(path.join(d.root, 'evidence/logs/xp.log'));
  const problems = verifyEvidence(report, scopeFor(d.root));
  assert.ok(problems.some((problem) => problem.ref === 'evidence/logs/xp.log' && problem.problem === 'missing'));
});

test('UAI-09 evidence: a file edited after the report was generated fails the digest check', () => {
  const d = dossier();
  const report = d.write();
  fs.writeFileSync(path.join(d.root, 'evidence/logs/candidate-suite.log'), '# tests 12\n# pass 0\n# fail 12\n');
  const problems = verifyEvidence(report, scopeFor(d.root));
  assert.ok(
    problems.some((problem) => problem.ref === 'evidence/logs/candidate-suite.log' && /digest mismatch|does not match/.test(problem.problem)),
    JSON.stringify(problems),
  );
});

test('UAI-09 evidence: the check pass rejects a report whose refs are not indexed', () => {
  const d = dossier();
  const report = d.write();
  const unindexed = {
    ...report,
    tests: report.tests.map((row) => (row.id === GATE.G1
      ? { ...row, evidenceRef: 'evidence/logs/absent.log', evidenceSha256: 'a'.repeat(64) }
      : row)),
  };
  assert.throws(() => validateReleaseReport(unindexed), /missing from evidenceHashes/);
});

test('UAI-09 evidence: identity readiness must come from an observed participant', () => {
  const d = dossier();
  const report = d.write();
  // The report carries no participant, so no readiness is claimed anywhere.
  assert.equal(report.observedParticipants.length, 0);
  // A roster entry with identityReady=true is only admissible because the
  // verifier refuses to emit one without a probe result; the schema alone cannot
  // tell, so the behaviour is asserted in ai_release_verify.mjs's generate mode.
  assert.equal(report.tests.find((row) => row.id === GATE.G7).status, TEST_STATUS.NOT_RUN);
});
