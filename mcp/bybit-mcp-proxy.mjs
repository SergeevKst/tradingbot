#!/usr/bin/env node
/**
 * Bybit MCP proxy — filters the official Bybit MCP server's tool list.
 *
 * The official server (bybit-official-trading-server) exposes 382 tools, whose
 * JSON schemas cost ~116k tokens in EVERY model request. This proxy speaks
 * MCP over stdio (newline-delimited JSON-RPC) on both sides, spawns the
 * official server as a child, and rewrites only `tools/list` results to the
 * curated allowlist in tools.allow.json. Every other message is forwarded
 * untouched, so tool calls keep the official implementation and auth.
 *
 * Usage: node --env-file=<project>/.env mcp/bybit-mcp-proxy.mjs
 * Env:   BYBIT_MCP_ALLOW_FILE  path to the allow/deny config (default: sibling tools.allow.json)
 *        BYBIT_MCP_UPSTREAM    path to the official server entry (default: project node_modules)
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '..');

const allowFile = process.env.BYBIT_MCP_ALLOW_FILE ?? join(here, 'tools.allow.json');
const upstream =
  process.env.BYBIT_MCP_UPSTREAM ??
  join(projectRoot, 'node_modules', 'bybit-official-trading-server', 'dist', 'index.js');

const config = JSON.parse(readFileSync(allowFile, 'utf8'));

/** Compile a glob (`*`, `?`) into an anchored RegExp. */
function globToRegExp(glob) {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
}

const allow = (config.allow ?? []).map(globToRegExp);
const deny = (config.deny ?? []).map(globToRegExp);

const isExposed = (name) => allow.some((re) => re.test(name)) && !deny.some((re) => re.test(name));

// The child inherits our env (which carries BYBIT_API_KEY etc. when this proxy
// is launched with `node --env-file=...`).
const child = spawn(process.execPath, [upstream], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: process.env,
});

child.on('exit', (code, signal) => {
  process.stderr.write(`[bybit-mcp-proxy] upstream exited code=${code} signal=${signal}\n`);
  process.exit(code ?? 1);
});
child.on('error', (err) => {
  process.stderr.write(`[bybit-mcp-proxy] upstream spawn failed: ${err.message}\n`);
  process.exit(1);
});

/** Request id -> method, so we can recognise the response we must rewrite. */
const pending = new Map();

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function toChild(msg) {
  child.stdin.write(`${JSON.stringify(msg)}\n`);
}

// ---- client -> child ------------------------------------------------------
let inBuffer = '';
process.stdin.on('data', (chunk) => {
  inBuffer += chunk.toString('utf8');
  let index;
  while ((index = inBuffer.indexOf('\n')) !== -1) {
    const line = inBuffer.slice(0, index).trim();
    inBuffer = inBuffer.slice(index + 1);
    if (!line) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue; // not ours to interpret
    }

    if (msg.method === 'tools/call') {
      const name = msg.params?.name;
      if (!isExposed(name)) {
        send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32602, message: `Tool not exposed by bybit-mcp-proxy: ${name}` },
        });
        continue;
      }
    }

    if (typeof msg.id !== 'undefined' && msg.method) pending.set(msg.id, msg.method);
    toChild(msg);
  }
});

// ---- child -> client -----------------------------------------------------
let outBuffer = '';
child.stdout.on('data', (chunk) => {
  outBuffer += chunk.toString('utf8');
  let index;
  while ((index = outBuffer.indexOf('\n')) !== -1) {
    const line = outBuffer.slice(0, index).trim();
    outBuffer = outBuffer.slice(index + 1);
    if (!line) continue;

    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }

    const method = pending.get(msg.id);
    if (method) pending.delete(msg.id);

    if (method === 'tools/list' && msg.result && Array.isArray(msg.result.tools)) {
      const total = msg.result.tools.length;
      const kept = msg.result.tools.filter((tool) => isExposed(tool.name));
      process.stderr.write(
        `[bybit-mcp-proxy] tools/list: ${total} upstream -> ${kept.length} exposed\n`,
      );
      msg.result.tools = kept;
    }

    send(msg);
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    child.kill(signal);
    process.exit(0);
  });
}
