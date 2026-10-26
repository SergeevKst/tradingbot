/**
 * UAI-09 / G5 — rehearsal evidence, including the financial half.
 *
 * G5 requires the fake-effects rehearsal to prove forward activation, a stale
 * restart, an interrupted prepare and rollback; that the control generation
 * increases; that the financial state/journal is unchanged before and after
 * except for fixture-declared normal deterministic actions; that no entry is
 * duplicated; and that pending-approval invalidation is recorded.
 *
 * The implementation proves the financial half on a synthetic fixture journal
 * and discloses that live financial-state equivalence remains a G7/operator
 * obligation. These tests make sure a PASS row can only be produced when that
 * evidence is actually present, and that the real rehearsal script emits it.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DECLARED_FIXTURE_ACTIONS,
  FIXTURE_JOURNAL_BASE,
  buildJournalProof,
} from '../scripts/ai_release_rehearsal.mjs';
import { evaluateG5 } from '../scripts/ai_release_verify.mjs';
import { digestJson } from '../src/config/jcs.mjs';
import { XP_IDS } from '../src/config/ai-release-report.mjs';
import { buildReleaseFixture } from './fixtures/ai-release/factory.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REHEARSAL_ENTRY = path.resolve(HERE, '..', 'scripts', 'ai_release_rehearsal.mjs');

/** @param {string} [overrides] */
function xpRowStatus(overrides = {}) {
  return XP_IDS.map((id) => ({ id, status: overrides[id] ?? 'PASS' }));
}

function validRehearsal() {
  return {
    ok: true,
    phases: [
      { phase: 'PAUSED', generation: 0 },
      { phase: 'QUIESCING', generation: 0, reserved: 1 },
      { phase: 'ACTIVE', generation: 1 },
      { phase: 'QUIESCING', generation: 1, reserved: 2, via: 'rollback', controlFilesCopied: false },
      { phase: 'ACTIVE', generation: 2 },
    ],
    forward: { transitionId: '3db746e2-02b0-494b-8d50-796e35fc1be8' },
    rollback: { transitionId: '32f180c8-37f8-47d0-acf4-b313b50dbc19', via: 'rollback' },
    financialState: {
      declaredActions: [{ entryId: 'fx-journal-trailing-1', kind: 'trailing-stop-adjust', appliedDuring: 'forward' }],
      entryCountBefore: 2,
      entryCountAfter: 3,
      journalBeforeSha256: 'a'.repeat(64),
      journalAfterSha256: 'b'.repeat(64),
      residualBeforeSha256: 'c'.repeat(64),
      residualAfterSha256: 'c'.repeat(64),
      residualEqual: true,
      declaredActionsApplied: true,
      duplicateEntryIds: [],
      noDuplicateEntry: true,
    },
  };
}

test('G5 journal proof: declared deterministic actions are the only journal delta', () => {
  const after = FIXTURE_JOURNAL_BASE.map((entry) => ({ ...entry }));
  for (const [index, action] of DECLARED_FIXTURE_ACTIONS.entries()) {
    after.push({
      entryId: action.entryId,
      kind: action.kind,
      slot: action.slot,
      amount: action.amount,
      generation: index + 1,
    });
  }
  const proof = buildJournalProof({
    before: FIXTURE_JOURNAL_BASE,
    after,
    declaredActions: DECLARED_FIXTURE_ACTIONS,
  });
  assert.equal(proof.residualEqual, true);
  assert.equal(proof.noDuplicateEntry, true);
  assert.equal(proof.declaredActionsApplied, true);
  assert.deepEqual(proof.duplicateEntryIds, []);
  assert.notEqual(proof.journalBeforeSha256, proof.journalAfterSha256);
  assert.equal(proof.entryCountBefore, 2);
  assert.equal(proof.entryCountAfter, 4);
  // The residual hash really is the hash of the entries without the declared ids.
  assert.equal(proof.residualBeforeSha256, digestJson(FIXTURE_JOURNAL_BASE));
  assert.equal(proof.residualAfterSha256, proof.residualBeforeSha256);
});

test('G5 journal proof: an undeclared change to the journal breaks the equality', () => {
  const after = FIXTURE_JOURNAL_BASE.map((entry) => ({ ...entry }));
  after.push({ entryId: 'fx-journal-trailing-1', kind: 'trailing-stop-adjust', slot: 'telegram', amount: '0.000', generation: 1 });
  after[0] = { ...after[0], amount: '0.020' }; // undeclared mutation of a pre-existing entry
  const proof = buildJournalProof({ before: FIXTURE_JOURNAL_BASE, after, declaredActions: DECLARED_FIXTURE_ACTIONS });
  assert.equal(proof.residualEqual, false);
  assert.notEqual(proof.residualBeforeSha256, proof.residualAfterSha256);
});

test('G5 journal proof: a duplicated entry is reported, including a repeated declared action', () => {
  const after = FIXTURE_JOURNAL_BASE.map((entry) => ({ ...entry }));
  for (const action of DECLARED_FIXTURE_ACTIONS) {
    after.push({ entryId: action.entryId, kind: action.kind, slot: action.slot, amount: action.amount, generation: 1 });
  }
  after.push({ ...after[after.length - 1] }); // exact duplicate: the classic "duplicate order" failure
  const proof = buildJournalProof({ before: FIXTURE_JOURNAL_BASE, after, declaredActions: DECLARED_FIXTURE_ACTIONS });
  assert.equal(proof.noDuplicateEntry, false);
  assert.deepEqual(proof.duplicateEntryIds, [DECLARED_FIXTURE_ACTIONS[1].entryId]);
  assert.equal(proof.declaredActionsApplied, false);
});

test('G5 gate: a fully evidenced rehearsal passes and the note discloses the fixture scope', () => {
  const result = evaluateG5(validRehearsal(), xpRowStatus());
  assert.equal(result.status, 'PASS');
  assert.equal(result.residualEqual, true);
  assert.equal(result.noDuplicateEntry, true);
  assert.match(result.note, /synthetic fixture journal only/);
  assert.match(result.note, /G7\/operator obligations/);
  assert.match(result.note, /via rollback/);
});

test('G5 gate: a rehearsal element missing the financial evidence cannot pass', () => {
  const rehearsal = validRehearsal();
  delete rehearsal.financialState;
  const result = evaluateG5(rehearsal, xpRowStatus());
  assert.equal(result.status, 'FAIL');
  assert.equal(result.residualEqual, false);
  assert.match(result.note, /financial journal residual hash equal before\/after/);
});

test('G5 gate: unequal residual journal hashes fail the gate', () => {
  const rehearsal = validRehearsal();
  rehearsal.financialState = {
    ...rehearsal.financialState,
    residualEqual: false,
    residualAfterSha256: 'd'.repeat(64),
  };
  assert.equal(evaluateG5(rehearsal, xpRowStatus()).status, 'FAIL');
});

test('G5 gate: a duplicate journal entry fails the gate', () => {
  const rehearsal = validRehearsal();
  rehearsal.financialState = {
    ...rehearsal.financialState,
    noDuplicateEntry: false,
    duplicateEntryIds: ['fx-journal-harvest-1'],
  };
  const result = evaluateG5(rehearsal, xpRowStatus());
  assert.equal(result.status, 'FAIL');
  assert.match(result.note, /duplicate entries: \["fx-journal-harvest-1"\]/);
});

test('G5 gate: a declared action that was never applied fails the gate', () => {
  const rehearsal = validRehearsal();
  rehearsal.financialState = { ...rehearsal.financialState, declaredActionsApplied: false };
  assert.equal(evaluateG5(rehearsal, xpRowStatus()).status, 'FAIL');
});

test('G5 gate: an unproven rollback or a missing XP row fails the gate', () => {
  const singleGeneration = validRehearsal();
  singleGeneration.phases = [{ phase: 'ACTIVE', generation: 1 }];
  assert.equal(evaluateG5(singleGeneration, xpRowStatus()).status, 'FAIL');

  const noRollback = validRehearsal();
  noRollback.rollback = {};
  assert.equal(evaluateG5(noRollback, xpRowStatus()).status, 'FAIL');

  assert.equal(evaluateG5(validRehearsal(), xpRowStatus({ 'XP-10': 'NOT_RUN' })).status, 'FAIL');
});

test('G5 rehearsal: the real script produces the financial journal evidence end to end', () => {
  const fixture = buildReleaseFixture();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-g5-'));
  const manifestPath = path.join(workDir, 'manifest.json');
  const profilePath = path.join(workDir, 'profile.json');
  const descriptorPath = path.join(workDir, 'descriptor.json');
  fs.writeFileSync(manifestPath, JSON.stringify(fixture.manifest));
  fs.writeFileSync(profilePath, JSON.stringify(fixture.profile));
  fs.writeFileSync(descriptorPath, JSON.stringify(fixture.descriptor));
  const controlDir = path.join(workDir, 'control');
  const reportPath = path.join(workDir, 'rehearsal-report.json');

  const run = spawnSync(process.execPath, [
    REHEARSAL_ENTRY,
    '--control-dir', controlDir,
    '--manifest', manifestPath,
    '--profile', profilePath,
    '--descriptor', descriptorPath,
    '--report', reportPath,
  ], { encoding: 'utf8', timeout: 60000 });

  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.ok, true);
  assert.equal(report.rollback.via, 'rollback');
  assert.equal(
    report.phases.find((entry) => entry.via === 'rollback').controlFilesCopied,
    false,
  );

  const financial = report.financialState;
  assert.equal(financial.residualEqual, true);
  assert.equal(financial.noDuplicateEntry, true);
  assert.equal(financial.declaredActionsApplied, true);
  assert.deepEqual(financial.duplicateEntryIds, []);
  assert.equal(financial.entryCountBefore, FIXTURE_JOURNAL_BASE.length);
  assert.equal(financial.entryCountAfter, FIXTURE_JOURNAL_BASE.length + DECLARED_FIXTURE_ACTIONS.length);
  // Every hash in the report is recomputable from the entries it embeds.
  const declaredIds = new Set(financial.declaredActions.map((action) => action.entryId));
  const residual = (entries) => entries.filter((entry) => !declaredIds.has(entry.entryId));
  assert.equal(financial.journalBeforeSha256, digestJson(financial.journalBefore));
  assert.equal(financial.journalAfterSha256, digestJson(financial.journalAfter));
  assert.equal(financial.residualBeforeSha256, digestJson(residual(financial.journalBefore)));
  assert.equal(financial.residualAfterSha256, digestJson(residual(financial.journalAfter)));
  // And the generated report satisfies the G5 gate.
  assert.equal(evaluateG5(report, xpRowStatus()).status, 'PASS');

  // Each declared action really landed *inside* its own barrier: it carries the
  // PREPARING phase and the generation that transition went on to commit, so the
  // equality proof covers a transition, not an idle window between two of them.
  const committedGenerations = report.phases
    .filter((entry) => entry.phase === 'ACTIVE')
    .map((entry) => entry.generation);
  const declaredEntries = financial.journalAfter.filter((entry) => declaredIds.has(entry.entryId));
  assert.deepEqual(
    declaredEntries.map((entry) => ({ id: entry.entryId, phase: entry.phase, generation: entry.generation })),
    DECLARED_FIXTURE_ACTIONS.map((action, index) => ({
      id: action.entryId,
      phase: 'PREPARING',
      generation: committedGenerations[index],
    })),
  );
  assert.equal(financial.journalAfter.length, financial.journalBefore.length + declaredEntries.length);
});
