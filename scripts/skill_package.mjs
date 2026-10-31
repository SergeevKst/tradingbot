#!/usr/bin/env node
/**
 * Offline Skill Package administration (architecture v1.1 §9.1, SKILL-03).
 *
 * Verbs:
 *   validate <packageDir>            structural + schema + example validation
 *   inspect  <packageDir>            digest, files and effective limits as JSON
 *   publish  <packageDir> --store <dir> --attestation <file>
 *            publish verified bytes plus their signed approval into the CAS
 *   revoke   <packageDir> --store <dir> --revocation <file>
 *            record a signed revocation for an already published package
 *
 * This tool never activates anything: it does not write `control.json`, does not
 * select a model and does not contact a provider. Publication is an
 * administrative act; activation remains the control-plane's job.
 *
 * Exit codes: 0 success, 1 usage, 2 refusal (structural package fault).
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { createSkillPackageStore, parseSourcePackage, readPackageFiles } from '../src/ai/skills/package-store.mjs';
import { SkillError } from '../src/errors/skill-error.mjs';

const USAGE = `usage:
  node scripts/skill_package.mjs validate <packageDir> [--bot <version>]
  node scripts/skill_package.mjs inspect  <packageDir> [--bot <version>]
  node scripts/skill_package.mjs publish  <packageDir> --store <dir> --attestation <file> --trust-roots <file> [--bot <version>]
  node scripts/skill_package.mjs revoke   <packageDir> --store <dir> --revocation <file> --trust-roots <file>
`;

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {Record<string, string>} */
  const options = {};
  /** @type {string[]} */
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      const [flag, inline] = token.slice(2).split('=');
      if (inline !== undefined) {
        options[flag] = inline;
        continue;
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`--${flag} requires a value`);
      options[flag] = value;
      index += 1;
      continue;
    }
    positional.push(token);
  }
  return { command: positional[0] ?? null, target: positional[1] ?? null, options };
}

/**
 * @param {string} file
 */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * @param {string} dir
 * @param {{ botVersion: string }} options
 */
function verify(dir, options) {
  return parseSourcePackage(dir, { artifact: { botVersion: options.botVersion, skillApiVersion: 1 } });
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    process.exit(1);
  }
  const { command, target, options } = parsed;
  if (!command || !target || command === 'help') {
    process.stdout.write(USAGE);
    process.exit(command === 'help' ? 0 : 1);
  }
  const botVersion = options.bot ?? '0.1.0';
  const dir = path.resolve(target);

  try {
    switch (command) {
      case 'validate': {
        const pkg = verify(dir, { botVersion });
        process.stdout.write(
          `${JSON.stringify(
            {
              ok: true,
              packageId: pkg.packageId,
              version: pkg.version,
              operation: pkg.operation,
              digest: pkg.digest,
              files: pkg.files.length,
              examples: pkg.examples.length,
              acceptanceCases: pkg.acceptanceCases.length,
              botVersionRange: pkg.manifest.compatibility.botVersionRange,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }
      case 'inspect': {
        const pkg = verify(dir, { botVersion });
        process.stdout.write(
          `${JSON.stringify(
            {
              packageId: pkg.packageId,
              version: pkg.version,
              operation: pkg.operation,
              digest: pkg.digest,
              index: pkg.index,
              policy: pkg.policy,
              inputContract: pkg.manifest.inputContract,
              outputContract: pkg.manifest.outputContract,
              requiredModelCapabilities: pkg.manifest.requiredModelCapabilities,
              promptLayout: pkg.layout,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }
      case 'publish': {
        if (!options.store || !options.attestation || !options['trust-roots']) {
          throw new Error('publish requires --store, --attestation and --trust-roots');
        }
        const store = createSkillPackageStore({ rootDir: path.resolve(options.store) });
        const parsedPackage = verify(dir, { botVersion });
        const published = store.publishPackage({
          files: readPackageFiles(dir),
          attestation: readJson(path.resolve(options.attestation)),
          trustRoots: readJson(path.resolve(options['trust-roots'])),
          artifact: { botVersion, skillApiVersion: 1 },
        });
        process.stdout.write(`${JSON.stringify({ ok: true, packageId: parsedPackage.packageId, version: parsedPackage.version, digest: published.packageDigestSha256, republished: published.republished })}\n`);
        return;
      }
      case 'revoke': {
        if (!options.store || !options.revocation || !options['trust-roots']) {
          throw new Error('revoke requires --store, --revocation and --trust-roots');
        }
        const store = createSkillPackageStore({ rootDir: path.resolve(options.store) });
        const recorded = store.publishRevocation(readJson(path.resolve(options.revocation)), {
          trustRoots: readJson(path.resolve(options['trust-roots'])),
        });
        process.stdout.write(`${JSON.stringify({ ok: true, revoked: recorded.packageDigestSha256 })}\n`);
        return;
      }
      default:
        throw new Error(`unknown verb ${JSON.stringify(command)}`);
    }
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
