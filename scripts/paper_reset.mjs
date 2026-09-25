#!/usr/bin/env node
/**
 * `paper:reset` — delete persisted PAPER state and journal.
 *
 * REQUIRES `--confirm-reset`. Without it the command refuses and changes
 * nothing. The confirmation is enforced twice: here, and again inside the state
 * store, so no other caller can delete trading state by accident.
 *
 * Usage: npm run paper:reset -- --confirm-reset
 */
import { loadConfig } from '../src/config/env.mjs';
import { createStateStore } from '../src/state/state-store.mjs';
import { removeFile, fileExists } from '../src/state/jsonl-file.mjs';

const confirmFlag = '--confirm-reset';
const confirmed = process.argv.includes(confirmFlag);

if (!confirmed) {
  console.error('Refusing to delete PAPER state: --confirm-reset was not passed.');
  console.error('');
  console.error('This command deletes the simulated account AND its trade journal.');
  console.error('If you really mean it:  npm run paper:reset -- --confirm-reset');
  process.exitCode = 1;
} else {
  const config = loadConfig();

  try {
    const store = createStateStore({ filePath: config.paper.stateFile });
    const existed = await store.reset(true);

    const journalExisted = await fileExists(config.paper.journalFile);
    await removeFile(config.paper.journalFile);

    console.log('PAPER state reset.');
    console.log('  state file   :', config.paper.stateFile, existed ? '(deleted)' : '(did not exist)');
    console.log('  journal file :', config.paper.journalFile, journalExisted ? '(deleted)' : '(did not exist)');
    console.log('');
    console.log(`The next run starts a fresh account at ${config.risk.initialCapitalUsd} USD.`);
  } catch (error) {
    console.error('paper:reset failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}