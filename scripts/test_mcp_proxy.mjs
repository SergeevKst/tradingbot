import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const t = new StdioClientTransport({
  command: process.execPath,
  args: ['--env-file=.env', 'mcp/bybit-mcp-proxy.mjs'],
});
const c = new Client({ name: 'proxy-test', version: '1.0.0' }, { capabilities: {} });
await c.connect(t);
const { tools } = await c.listTools();
const json = JSON.stringify(tools);
console.log('exposed tools:', tools.length, '| schema chars:', json.length, '| ~tokens:', Math.round(json.length / 3.5));
console.log('names:', tools.map(x => x.name).join(', '));
// deny check: a tool that must NOT be reachable
try {
  await c.callTool({ name: 'queryWithdrawRecords', arguments: {} });
  console.log('DENY FAIL: withdraw tool callable');
} catch (e) { console.log('deny OK:', e.message.slice(0, 80)); }
// live read-only call through the proxy
const time = await c.callTool({ name: 'getServerTime', arguments: {} });
console.log('getServerTime ->', JSON.stringify(time.structuredContent ?? time.content).slice(0, 200));
const bal = await c.callTool({ name: 'getWalletBalance', arguments: { accountType: 'UNIFIED' } });
const txt = JSON.stringify(bal.structuredContent ?? bal.content);
console.log('getWalletBalance ->', txt.slice(0, 400));
await c.close();
process.exit(0);
