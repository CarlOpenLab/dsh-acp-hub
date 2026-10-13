import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { AcpHub } from '../lib/hub.js';

const launch = { command: process.execPath, args: [fileURLToPath(new URL('./mock-agent.mjs', import.meta.url))] };
const waitFor = async predicate => {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
};

test('persistent multi-turn ACP session, controls, permissions and restore', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-acp-test-'));
  let hub = new AcpHub({ storageDir: dir, agents: { codex: launch } });
  try {
    const session = await hub.create({ agent: 'codex', cwd: dir });
    assert.equal(hub.info(session.id).configOptions[0].currentValue, 'test-model');
    await hub.configure(session.id, 'model', 'second-model');
    assert.equal(hub.info(session.id).configOptions[0].currentValue, 'second-model');
    await hub.setMode(session.id, 'ask');
    assert.equal(hub.info(session.id).modes.currentModeId, 'ask');
    assert.equal((await hub.promptAndWait(session.id, 'one')).stopReason, 'end_turn');
    assert.equal((await hub.promptAndWait(session.id, 'max')).stopReason, 'max_tokens');
    assert.deepEqual(hub.events(session.id, 0).events.filter(e => e.type === 'message_delta').map(e => e.text), ['echo:one', 'echo:max']);
    const turn = hub.promptAndWait(session.id, 'permission');
    await waitFor(() => hub.info(session.id).pendingPermissions.length === 1);
    const permission = hub.info(session.id).pendingPermissions[0];
    await assert.rejects(hub.permission(session.id, permission.requestId, 'not-advertised'), /Invalid permission/);
    await hub.permission(session.id, permission.requestId, 'allow-always');
    await turn;
    assert.equal(hub.info(session.id).pendingPermissions.length, 0);
    const cancelled = hub.promptAndWait(session.id, 'wait');
    await hub.interrupt(session.id);
    assert.equal((await cancelled).stopReason, 'cancelled');
    await hub.close(session.id);
    await hub.dispose();
    hub = new AcpHub({ storageDir: dir, agents: { codex: launch } });
    await hub.ready;
    assert.equal(hub.info(session.id).connected, false);
    await hub.create({ agent: 'codex', cwd: dir, resumeId: session.id });
    await hub.promptAndWait(session.id, 'restored');
    assert.ok(hub.events(session.id, 0).events.some(e => e.text === 'echo:restored'));
    assert.equal((await stat(join(dir, 'workbench.json'))).mode & 0o777, 0o600);
  } finally { await hub.dispose(); await rm(dir, { recursive: true }); }
});

test('profile credentials are preserved on edits and omitted from public state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-acp-profile-'));
  const hub = new AcpHub({ storageDir: dir });
  try {
    const profile = await hub.saveProfile({ id: '', name: 'Gateway', agent: 'codex', provider: 'Gateway',
      baseURL: 'https://example.com/v1', apiKey: 'test-secret', model: 'test-model', ...launch, env: {} });
    assert.equal(profile.hasApiKey, true);
    assert.equal(JSON.stringify(hub.profiles()).includes('test-secret'), false);
    await hub.saveProfile({ ...profile, name: 'Renamed' });
    assert.ok((await readFile(join(dir, 'workbench.json'), 'utf8')).includes('test-secret'));
    await hub.deleteProfile(profile.id);
    assert.equal(hub.profiles().length, 0);
  } finally { await hub.dispose(); await rm(dir, { recursive: true }); }
});
