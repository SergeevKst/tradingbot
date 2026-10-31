#!/usr/bin/env node
/**
 * Offline Skill Package comparison (architecture v1.1 §9.2, SKILL-07).
 *
 * Compares a baseline and a candidate package and emits a deterministic JSON
 * report. The report is evidence for a human review: it never approves anything,
 * never contacts a provider and never touches the control store.
 *
 * usage:
 *   node scripts/skill_compare.mjs <baselineDir> <candidateDir> [--bot <version>]
 *
 * Exit codes: 0 report produced, 1 usage/IO error, 2 a package failed validation.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { parseSourcePackage } from '../src/ai/skills/package-store.mjs';
import { SkillError } from '../src/errors/skill-error.mjs';

const USAGE = 'usage: node scripts/skill_compare.mjs <baselineDir> <candidateDir> [--bot <version>]\n';

/**
 * Stable JSON rendering for report values.
 *
 * @param {unknown} value
 */
function stable(value) {
  return JSON.stringify(value, null, 2);
}

/**
 * @param {Record<string, unknown>} before
 * @param {Record<string, unknown>} after
 * @param {string} prefix
 * @param {string[]} out
 */
function diffObjects(before, after, prefix, out) {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  for (const key of [...keys].sort()) {
    const left = before?.[key];
    const right = after?.[key];
    const at = prefix === '' ? key : `${prefix}.${key}`;
    if (left !== null && typeof left === 'object' && !Array.isArray(left)) {
      diffObjects(/** @type {any} */ (left), right !== null && typeof right === 'object' ? /** @type {any} */ (right) : {}, at, out);
      continue;
    }
    if (stable(left) !== stable(right)) out.push(`${at}: ${stable(left)} -> ${stable(right)}`);
  }
}

/**
 * @param {string} dir
 * @param {string} botVersion
 */
function load(dir, botVersion) {
  return parseSourcePackage(path.resolve(dir), { artifact: { botVersion, skillApiVersion: 1 } });
}

/**
 * @param {any} baseline
 * @param {any} candidate
 */
function buildReport(baseline, candidate) {
  /** @type {string[]} */
  const semantic = [];
  diffObjects(baseline.manifest, candidate.manifest, 'skill.json', semantic);
  diffObjects(baseline.policy, candidate.policy, 'policy.json', semantic);
  diffObjects(baseline.layout, candidate.layout, 'prompt-layout.json', semantic);
  diffObjects(baseline.inputSchema, candidate.inputSchema, 'input.schema.json', semantic);
  diffObjects(baseline.outputSchema, candidate.outputSchema, 'output.schema.json', semantic);

  const beforeFiles = new Map(baseline.files.map((file) => [file.path, file]));
  const afterFiles = new Map(candidate.files.map((file) => [file.path, file]));
  /** @type {string[]} */
  const changedFiles = [];
  for (const [filePath, file] of afterFiles) {
    const previous = beforeFiles.get(filePath);
    if (!previous) changedFiles.push(`added ${filePath}`);
    else if (previous.sha256 !== file.sha256) changedFiles.push(`changed ${filePath}`);
  }
  for (const filePath of beforeFiles.keys()) {
    if (!afterFiles.has(filePath)) changedFiles.push(`removed ${filePath}`);
  }

  /** @type {string[]} */
  const privileged = [];
  const capabilityBefore = baseline.manifest.requiredModelCapabilities;
  const capabilityAfter = candidate.manifest.requiredModelCapabilities;
  if (capabilityAfter.temperature.min < capabilityBefore.temperature.min || capabilityAfter.temperature.max > capabilityBefore.temperature.max) {
    privileged.push('temperature envelope widened');
  }
  if (capabilityAfter.maxOutputTokens > capabilityBefore.maxOutputTokens) privileged.push('maxOutputTokens increased');
  if (capabilityAfter.minOutputTokens < capabilityBefore.minOutputTokens) privileged.push('minOutputTokens decreased');
  if (candidate.policy.limits.maxInputBytes > baseline.policy.limits.maxInputBytes) privileged.push('maxInputBytes increased');
  if (candidate.policy.limits.maxOutputBytes > baseline.policy.limits.maxOutputBytes) privileged.push('maxOutputBytes increased');
  if (candidate.policy.limits.timeoutMs > baseline.policy.limits.timeoutMs) privileged.push('timeoutMs increased');
  if (candidate.policy.limits.maxModelCalls > baseline.policy.limits.maxModelCalls) privileged.push('maxModelCalls increased');
  for (const capability of candidate.policy.dataSources) {
    if (!baseline.policy.dataSources.includes(capability)) privileged.push(`new data source ${capability}`);
  }
  if (candidate.policy.allowedTools.length > 0) privileged.push('allowedTools is no longer empty');

  /** @type {string[]} */
  const contracts = [];
  for (const [kind, beforeContract, afterContract] of [
    ['input', baseline.manifest.inputContract, candidate.manifest.inputContract],
    ['output', baseline.manifest.outputContract, candidate.manifest.outputContract],
  ]) {
    if (beforeContract.id !== afterContract.id) contracts.push(`${kind} contract id ${beforeContract.id} -> ${afterContract.id} (breaking)`);
    else if (beforeContract.version !== afterContract.version) contracts.push(`${kind} contract version ${beforeContract.version} -> ${afterContract.version}`);
  }

  const instructionsChanged = baseline.instructions !== candidate.instructions;
  return {
    schemaVersion: 1,
    baseline: { packageId: baseline.packageId, version: baseline.version, digest: baseline.digest },
    candidate: { packageId: candidate.packageId, version: candidate.version, digest: candidate.digest },
    sameDigest: baseline.digest === candidate.digest,
    changedFiles,
    instructionsChanged,
    semanticChanges: semantic,
    privilegedChanges: privileged,
    contractChanges: contracts,
    requiresNewVersion: baseline.digest !== candidate.digest,
    notes: [
      'A digest change always requires a new version, including a test-only change.',
      'Automated subset checks are advisory; a human reviewer decides semantic compatibility.',
      'This report is not an approval and cannot activate anything.',
    ],
  };
}

function main() {
  const args = process.argv.slice(2).filter((token) => token !== '--bot' && !token.startsWith('--'));
  const flagIndex = process.argv.indexOf('--bot');
  const botVersion = flagIndex >= 0 ? process.argv[flagIndex + 1] : '0.1.0';
  if (args.length < 2) {
    process.stderr.write(USAGE);
    process.exit(1);
  }
  try {
    const baseline = load(args[0], botVersion);
    const candidate = load(args[1], botVersion);
    process.stdout.write(`${JSON.stringify(buildReport(baseline, candidate), null, 2)}\n`);
  } catch (error) {
    if (error instanceof SkillError) {
      process.stderr.write(`${JSON.stringify({ ok: false, cause: error.code, field: error.field, message: error.message })}\n`);
      process.exit(2);
    }
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

main();
