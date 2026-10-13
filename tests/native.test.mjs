import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpHub } from '../lib/hub.js';
import { NativeAcpAdapter } from '../lib/native.js';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import { NativeToolRecorder } from '../lib/native-tools.js';

const launch = { command: process.execPath, args: [fileURLToPath(new URL('./mock-agent.mjs', import.meta.url))] };
const message = (id, text, kind = 'user') => ({ id, role: 'user', source: { kind, ...(kind === 'plugin' ? { plugin: 'test' } : {}) }, content: [{ type: 'text', text }] });
const collect = async stream => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks; };
const textOf = chunks => chunks.filter(c => c.type === 'text-delta').map(c => c.text).join('');
const nativeSession = dir => {
  const session = Session.create(SessionId('native-test'), [], { version: 3, id: SessionId('native-test'), cwd: dir, createdAt: Date.now(), isSeeded: false });
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  return session;
};

test('native routing filters plugin context, preserves turns, switches model and restores ACP', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-acp-native-'));
  let hub = new AcpHub({ storageDir: dir, agents: { codex: launch } });
  const ctx = { agents: { get: () => ({ id: 'native-test', session: { header: { cwd: dir } } }) }, emit() {}, approval: { request: async () => 'allowed-once' } };
  const options = { sessionId: 'native-test', provider: 'acp-hub/codex/local', model: 'test-model', messages: [message('p1', 'plugin instructions', 'plugin'), message('u1', 'one')] };
  try {
    await hub.ready;
    let adapter = new NativeAcpAdapter(hub, ctx);
    assert.equal(textOf(await collect(adapter.stream(options))), 'echo:one');
    const second = { ...options, model: 'second-model', messages: [...options.messages, message('u2', 'two')] };
    assert.equal(textOf(await collect(adapter.stream(second))), 'echo:two');
    assert.equal(hub.sessions()[0].configOptions[0].currentValue, 'second-model');
    assert.equal(hub.sessions().length, 1);
    await assert.rejects(collect(adapter.stream(second)), /No new message/);
    await hub.dispose();
    hub = new AcpHub({ storageDir: dir, agents: { codex: launch } }); await hub.ready;
    adapter = new NativeAcpAdapter(hub, ctx);
    assert.equal(textOf(await collect(adapter.stream({ ...second, messages: [...second.messages, message('u3', 'three')] }))), 'echo:three');
    assert.equal(hub.sessions().length, 1);
    assert.deepEqual(hub.sessions()[0].deliveredMessages, ['u1', 'u2', 'u3']);
  } finally { await hub.dispose(); await rm(dir, { recursive: true }); }
});

test('native permissions, cancellation and finish reasons use the host contracts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-acp-native-'));
  const hub = new AcpHub({ storageDir: dir, agents: { codex: launch } });
  const approvals = [];
  const session = nativeSession(dir);
  const ctx = { agents: { get: () => ({ id: 'native-test', session }) }, emit() {}, approval: {
    request: async request => { approvals.push(request); return 'allowed-once'; },
  } };
  const base = { sessionId: 'native-test', provider: 'acp-hub/codex/local', model: 'default' };
  try {
    await hub.ready;
    const adapter = new NativeAcpAdapter(hub, ctx);
    assert.equal(textOf(await collect(adapter.stream({ ...base, messages: [message('u1', 'permission')] }))), 'permission:allow-always');
    assert.equal(approvals[0].toolName, 'Read test file');
    assert.match(approvals[0].callId, /^acp:/);
    const max = await collect(adapter.stream({ ...base, messages: [message('u2', 'max')] }));
    assert.deepEqual(max.at(-1), { type: 'finish', reason: { kind: 'max-tokens' } });
    const controller = new AbortController();
    const cancelled = collect(adapter.stream({ ...base, signal: controller.signal, messages: [message('u3', 'wait')] }));
    const deadline = Date.now() + 3000;
    while (!hub.sessions().some(s => s.status === 'running')) {
      if (Date.now() > deadline) throw new Error('Turn did not start');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    controller.abort();
    await assert.rejects(cancelled, error => error.name === 'AbortError');
    assert.equal(hub.sessions()[0].status, 'idle');
    await assert.rejects(collect(adapter.stream({ ...base, purpose: 'compaction', messages: [] })), /auxiliary/);
  } finally { await hub.dispose(); await rm(dir, { recursive: true }); }
});

test('external tools produce native cards without executable stream blocks and survive replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-acp-native-tools-'));
  const hub = new AcpHub({ storageDir: dir, agents: { codex: launch } });
  const session = nativeSession(dir);
  const ctx = { agents: { get: () => ({ id: 'native-test', session }) }, emit() {}, approval: { request: async () => 'allowed-once' } };
  try {
    await hub.ready;
    const adapter = new NativeAcpAdapter(hub, ctx);
    const base = { sessionId: 'native-test', provider: 'acp-hub/codex/local', model: 'default' };
    const chunks = await collect(adapter.stream({ ...base, messages: [message('u1', 'tools')] }));
    assert.equal(textOf(chunks), 'Tools finished');
    assert.equal(chunks.some(c => c.type === 'tool-call-delta' || c.blockType === 'tool-call'), false);
    const calls = session.snapshotEvents().filter(e => e.type === 'tool/call');
    const results = session.snapshotEvents().filter(e => e.type === 'tool/result');
    assert.deepEqual(calls.map(e => e.data.name), ['read', 'bash', 'edit', 'Custom ACP action']);
    assert.equal(results.length, 4);
    assert.equal(results[2].data.meta.diffs[0].newText, 'const value = 2;');
    assert.equal(results[0].data.meta.acp.updates.length, 3);
    assert.equal(results[3].data.message.content[0].isError, true);
    for (let index = 0; index < calls.length; index++) {
      assert.equal(results[index].data.message.source.callId, calls[index].data.callId);
      assert.deepEqual(results[index].sourceEventSeqs, [calls[index].seq]);
    }
    const replay = Session.create(SessionId('native-test'), JSON.parse(JSON.stringify(session.snapshotEvents())));
    assert.deepEqual(replay.snapshotEvents().filter(e => e.type !== 'session/end-seed'), session.snapshotEvents().filter(e => e.type !== 'session/end-seed'));
    await collect(adapter.stream({ ...base, messages: [message('u2', 'tools')] }));
    assert.equal(new Set(session.snapshotEvents().filter(e => e.type === 'tool/call').map(e => e.data.callId)).size, 8);
    const controller = new AbortController();
    const waiting = collect(adapter.stream({ ...base, signal: controller.signal, messages: [message('u3', 'tools-wait')] }));
    const deadline = Date.now() + 3000;
    while (session.snapshotEvents().filter(e => e.type === 'tool/call').length < 9) {
      if (Date.now() > deadline) { controller.abort(); throw new Error('Tool call did not start'); }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    controller.abort(); await assert.rejects(waiting, error => error.name === 'AbortError');
    assert.equal(session.snapshotEvents().filter(e => e.type === 'tool/result').at(-1).data.error.code, 'interrupted');
  } finally { await hub.dispose(); await rm(dir, { recursive: true }); }
});

test('partial ACP updates, interleaved calls and missing terminal results keep one native card per call', () => {
  const session = nativeSession('/tmp');
  const tools = new NativeToolRecorder(session);
  const firstId = tools.record({ toolCallId: 'one', title: 'Custom action', rawInput: { value: 1 } });
  tools.record({ toolCallId: 'two', title: 'Other action', status: 'pending' });
  tools.record({ toolCallId: 'one', title: null, rawInput: null, status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: 'old output' } }] });
  tools.record({ toolCallId: 'one', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'new output' } }] });
  tools.record({ toolCallId: 'one', status: 'completed' });
  tools.finish(false);
  const calls = session.snapshotEvents().filter(e => e.type === 'tool/call');
  const results = session.snapshotEvents().filter(e => e.type === 'tool/result');
  assert.equal(calls.length, 2);
  assert.equal(results.length, 2);
  assert.equal(results[0].data.message.source.callId, firstId);
  assert.equal(results[0].data.message.content[0].content[0].text, 'new output');
  assert.equal(results[0].data.meta.acp.title, 'Custom action');
  assert.equal(results[0].data.meta.acp.rawInput.value, 1);
  assert.equal(results[1].data.error.code, 'ACP_TOOL_INCOMPLETE');
  assert.throws(() => new NativeToolRecorder(Session.create(SessionId('idle'))), /open native step/);
});
