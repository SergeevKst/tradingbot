import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const META_PATH = path.join(ROOT, 'graphify-out', 'INDEX_META.json');
const GRAPH_PATH = path.join(ROOT, 'graphify-out', 'graph.json');
const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules', 'data', 'graphify-out']);
const SKIPPED_BASENAMES = new Set(['.env', '.env.example']);
const INDEXABLE_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cs', '.css', '.go', '.h', '.java', '.js', '.jsx', '.kt', '.kts', '.md', '.mjs', '.php', '.py', '.rb', '.rs', '.sh', '.swift', '.ts', '.tsx', '.vue', '.yaml', '.yml', '.json']);

export function parseMeta(text) {
  let value;
  try { value = JSON.parse(text); } catch { return { ok: false, reason: 'INDEX_META.json is not valid JSON' }; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: 'INDEX_META.json must contain an object' };
  for (const key of ['base_sha', 'built_at', 'graphify_version', 'node_count', 'edge_count', 'community_count', 'dirty_tree', 'input_digest']) {
    if (!(key in value)) return { ok: false, reason: `INDEX_META.json is missing ${key}` };
  }
  if (typeof value.base_sha !== 'string' || typeof value.input_digest !== 'string' || typeof value.dirty_tree !== 'boolean') return { ok: false, reason: 'INDEX_META.json has invalid field types' };
  return { ok: true, meta: value };
}

export function classifyFreshness(meta, current) {
  if (meta.base_sha !== current.base_sha) return { fresh: false, reason: 'HEAD changed' };
  if (meta.input_digest !== current.input_digest) return { fresh: false, reason: 'indexed files changed' };
  return { fresh: true, reason: 'index matches HEAD and indexed files' };
}

function git(...args) { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim(); }

function isIndexable(relativePath) {
  const parts = relativePath.split(path.sep);
  if (parts.some((part) => EXCLUDED_DIRECTORIES.has(part))) return false;
  const base = parts.at(-1);
  if (SKIPPED_BASENAMES.has(base) || base.startsWith('.env.')) return false;
  return INDEXABLE_EXTENSIONS.has(path.extname(base).toLowerCase());
}

async function collectIndexableFiles(directory = ROOT, relative = '') {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const childRelative = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRECTORIES.has(entry.name)) files.push(...await collectIndexableFiles(path.join(directory, entry.name), childRelative));
    } else if (entry.isFile() && isIndexable(childRelative)) files.push(childRelative);
  }
  return files;
}

export async function calculateInputDigest() {
  const files = (await collectIndexableFiles()).sort();
  const hash = createHash('sha256');
  for (const relativePath of files) {
    const absolutePath = path.join(ROOT, relativePath);
    const stat = await fs.stat(absolutePath);
    hash.update(relativePath); hash.update('\0'); hash.update(String(stat.mtimeMs)); hash.update('\0'); hash.update(await fs.readFile(absolutePath)); hash.update('\0');
  }
  return hash.digest('hex');
}

async function currentState() { return { base_sha: git('rev-parse', 'HEAD'), input_digest: await calculateInputDigest() }; }

async function readGraph() {
  const graph = JSON.parse(await fs.readFile(GRAPH_PATH, 'utf8'));
  const communities = new Set((graph.nodes ?? []).map((node) => node.community).filter((value) => value !== undefined));
  return { node_count: graph.nodes?.length ?? 0, edge_count: graph.links?.length ?? 0, community_count: communities.size };
}

async function build() {
  const result = spawnSync('graphify', ['update', '.'], { cwd: ROOT, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) { process.exitCode = result.status ?? 1; return; }
  const [state, counts] = await Promise.all([currentState(), readGraph()]);
  const meta = { base_sha: state.base_sha, built_at: new Date().toISOString(), graphify_version: execFileSync('graphify', ['--version'], { cwd: ROOT, encoding: 'utf8' }).trim(), ...counts, dirty_tree: git('status', '--porcelain') !== '', input_digest: state.input_digest };
  await fs.mkdir(path.dirname(META_PATH), { recursive: true });
  await fs.writeFile(META_PATH, `${JSON.stringify(meta, null, 2)}\n`);
  console.log(`Built Graphify index: ${meta.node_count} nodes, ${meta.edge_count} edges, ${meta.community_count} communities`);
}

async function check() {
  let parsed;
  try { parsed = parseMeta(await fs.readFile(META_PATH, 'utf8')); } catch (error) {
    console.error(`Graphify index is stale: INDEX_META.json is missing (${error.code ?? error.message}). Rebuild with: node scripts/graphify_index.mjs build`); process.exitCode = 1; return;
  }
  if (!parsed.ok) { console.error(`Graphify index is stale: ${parsed.reason}. Rebuild with: node scripts/graphify_index.mjs build`); process.exitCode = 1; return; }
  const result = classifyFreshness(parsed.meta, await currentState());
  if (!result.fresh) { console.error(`Graphify index is stale: ${result.reason}. Rebuild with: node scripts/graphify_index.mjs build`); process.exitCode = 1; return; }
  console.log(`Graphify index is fresh: ${parsed.meta.base_sha}`);
}

async function show() {
  const parsed = parseMeta(await fs.readFile(META_PATH, 'utf8'));
  if (!parsed.ok) throw new Error(parsed.reason);
  console.log(JSON.stringify(parsed.meta, null, 2));
}

async function main() {
  const command = process.argv[2];
  if (command === 'build') return build();
  if (command === 'check') return check();
  if (command === 'show') return show();
  console.error('Usage: node scripts/graphify_index.mjs <build|check|show>'); process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`Graphify index failed: ${error.message}`); process.exitCode = 1; });
}
