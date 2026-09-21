#!/usr/bin/env node
/**
 * List the tools the MCP proxy exposes, with their token cost.
 *
 * Use this when curating mcp/tools.allow.json: it shows what the model would
 * actually see, and (with --all) the full upstream list for picking names.
 *
 *   node --env-file=.env scripts/list_tools.mjs          # exposed set
 *   node --env-file=.env scripts/list_tools.mjs --all    # upstream 382 tools
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const all = process.argv.includes('--all');
const target = all
  ? ['--env-file=.env', 'node_modules/bybit-official-trading-server/dist/index.js']
  : ['--env-file=.env', 'mcp/bybit-mcp-proxy.mjs'];

const transport = new StdioClientTransport({
  command: process.execPath,
  args: target,
  stderr: 'ignore',
});
const client = new Client({ name: 'tool-list', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
const chars = JSON.stringify(tools).length;

console.log(`${all ? 'UPSTREAM' : 'EXPOSED'}: ${tools.length} tools, ${chars} schema chars, ~${Math.round(chars / 3.5)} tokens\n`);
for (const tool of tools) {
  const first = (tool.description ?? '').replace(/\s+/g, ' ').split('. ')[0];
  console.log(`${tool.name.padEnd(26)} ${first.slice(0, 80)}`);
}

await client.close();
process.exit(0);
