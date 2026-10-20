import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { classifyFreshness, parseMeta } from '../scripts/graphify_index.mjs';

const meta = { base_sha: 'abc123', built_at: '2026-10-20T00:00:00.000Z', graphify_version: 'graphify 0.9.71', node_count: 1590, edge_count: 4661, community_count: 72, dirty_tree: false, input_digest: 'digest-a' };

test('parseMeta accepts complete metadata', () => assert.deepEqual(parseMeta(JSON.stringify(meta)), { ok: true, meta }));
test('parseMeta rejects malformed or incomplete metadata', () => { assert.equal(parseMeta('{').ok, false); assert.equal(parseMeta(JSON.stringify({ base_sha: 'abc123' })).ok, false); });
test('classifyFreshness accepts matching SHA and indexed input digest', () => assert.deepEqual(classifyFreshness(meta, { base_sha: 'abc123', input_digest: 'digest-a' }), { fresh: true, reason: 'index matches HEAD and indexed files' }));
test('classifyFreshness rejects a different SHA or changed indexed files', () => { assert.equal(classifyFreshness(meta, { base_sha: 'def456', input_digest: 'digest-a' }).fresh, false); assert.equal(classifyFreshness(meta, { base_sha: 'abc123', input_digest: 'digest-b' }).reason, 'indexed files changed'); });
