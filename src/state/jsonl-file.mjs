/**
 * Minimal JSONL / JSON file primitives.
 *
 * The ONLY module in the project permitted to touch the filesystem. Keeping it
 * this small means the "who may write to disk" question has one reviewable
 * answer, and the storage-dependent code above it stays testable by injecting a
 * fake `fs`.
 *
 * @module state/jsonl-file
 */
import { dirname } from 'node:path';
import { mkdir, appendFile, readFile, writeFile, rename, unlink, open } from 'node:fs/promises';

/** The subset of `fs/promises` this module uses, for injectable fakes. */
const defaultFs = { mkdir, appendFile, readFile, writeFile, rename, unlink, open };

/**
 * @param {string} filePath
 * @param {object} [fs]
 * @returns {Promise<boolean>}
 */
export async function fileExists(filePath, fs) {
  const impl = fs ?? defaultFs;
  try {
    const handle = await impl.open(filePath, 'r');
    await handle.close();
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure the parent directory of a path exists.
 *
 * @param {string} filePath
 * @param {object} [fs]
 */
export async function ensureDirectory(filePath, fs) {
  const impl = fs ?? defaultFs;
  await impl.mkdir(dirname(filePath), { recursive: true });
}

/**
 * Append one line to a file, creating it if needed.
 *
 * @param {string} filePath
 * @param {string} line
 * @param {object} [fs]
 */
export async function appendLine(filePath, line, fs) {
  const impl = fs ?? defaultFs;
  await impl.appendFile(filePath, `${line}\n`, 'utf8');
}

/**
 * Read a file's non-empty lines.
 *
 * @param {string} filePath
 * @param {object} [fs]
 * @returns {Promise<string[]>}
 */
export async function readLines(filePath, fs) {
  const impl = fs ?? defaultFs;
  const raw = await impl.readFile(filePath, 'utf8');
  return String(raw).split('\n');
}

/**
 * Read and parse JSON, returning null when the file does not exist.
 *
 * @param {string} filePath
 * @param {object} [fs]
 * @returns {Promise<unknown | null>}
 * @throws {Error} when the file exists but is not valid JSON
 */
export async function readJson(filePath, fs) {
  const impl = fs ?? defaultFs;
  let raw;
  try {
    raw = await impl.readFile(filePath, 'utf8');
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 'ENOENT') return null;
    throw error;
  }
  if (String(raw).trim() === '') return null;
  return JSON.parse(String(raw));
}

/**
 * Atomically replace a file's contents.
 *
 * Writes to a temporary sibling and renames over the target, so a crash can
 * never leave a half-written state file — the old state survives intact, which
 * matters because a truncated state file would look like corruption on restart.
 *
 * @param {string} filePath
 * @param {string} contents
 * @param {object} [fs]
 */
export async function writeJsonAtomic(filePath, contents, fs) {
  const impl = fs ?? defaultFs;
  const temporary = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await impl.writeFile(temporary, contents, 'utf8');
  try {
    await impl.rename(temporary, filePath);
  } catch (error) {
    await impl.unlink(temporary).catch(() => {});
    throw error;
  }
}

/**
 * Delete a file, ignoring a missing target.
 *
 * @param {string} filePath
 * @param {object} [fs]
 */
export async function removeFile(filePath, fs) {
  const impl = fs ?? defaultFs;
  try {
    await impl.unlink(filePath);
  } catch (error) {
    if (/** @type {any} */ (error)?.code !== 'ENOENT') throw error;
  }
}

export { defaultFs };