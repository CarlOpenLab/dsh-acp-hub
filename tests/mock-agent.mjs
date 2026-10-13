import { createInterface } from 'node:readline';
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
let permissionId = 9000;
const permissions = new Map();
const pendingTurns = new Map();
const configOptions = [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'test-model',
  options: [{ value: 'test-model', name: 'Test model' }, { value: 'second-model', name: 'Second model' }] }];
const respond = (id, result) => send({ jsonrpc: '2.0', id, result });
const update = (sessionId, update) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update } });
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (!request.method) {
    const turn = permissions.get(request.id);
    if (turn) {
      update(turn.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'read-file', status: request.result.outcome.outcome === 'selected' ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text: 'permission tool result' } }] });
      update(turn.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `permission:${request.result.outcome.optionId ?? request.result.outcome.outcome}` } });
      respond(turn.id, { stopReason: 'end_turn' }); permissions.delete(request.id);
    }
    continue;
  }
  const { id, method, params } = request;
  if (method === 'initialize') respond(id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] });
  else if (method === 'session/new' || method === 'session/load') respond(id, { sessionId: params.sessionId || 'mock-session', configOptions,
    modes: { currentModeId: 'code', availableModes: [{ id: 'code', name: 'Code' }, { id: 'ask', name: 'Ask' }] } });
  else if (method === 'session/set_config_option') {
    configOptions[0].currentValue = params.value; respond(id, { configOptions });
  } else if (method === 'session/set_mode') respond(id, {});
  else if (method === 'session/prompt') {
    const text = params.prompt[0].text;
    if (text === 'permission') {
      const rpcId = ++permissionId; permissions.set(rpcId, { id, sessionId: params.sessionId });
      send({ jsonrpc: '2.0', id: rpcId, method: 'session/request_permission', params: {
        sessionId: params.sessionId, toolCall: { toolCallId: 'read-file', title: 'Read test file', status: 'pending' },
        options: [{ optionId: 'allow-always', name: 'Always allow', kind: 'allow_always' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' }],
      } });
    } else if (text === 'wait') pendingTurns.set(params.sessionId, id);
    else if (text === 'tools' || text === 'tools-wait') {
      update(params.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'Read sample.ts', kind: 'read', status: 'pending', rawInput: { file_path: '/tmp/sample.ts' }, locations: [{ path: '/tmp/sample.ts', line: 1 }] });
      update(params.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'in_progress' });
      if (text === 'tools-wait') { pendingTurns.set(params.sessionId, id); continue; }
      update(params.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'const value = 1;' } }] });
      update(params.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'shell-1', title: 'Run tests', kind: 'execute', status: 'in_progress', rawInput: { command: 'npm test' } });
      update(params.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'shell-1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Tests passed\n[exit code: 0]' } }] });
      update(params.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'edit-1', title: 'Edit sample.ts', kind: 'edit', status: 'in_progress', content: [{ type: 'diff', path: '/tmp/sample.ts', oldText: 'const value = 1;', newText: 'const value = 2;' }] });
      update(params.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'edit-1', status: 'completed' });
      update(params.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'other-1', title: 'Custom ACP action', status: 'failed', rawInput: { custom: 'input' }, rawOutput: { error: 'simulated failure' } });
      update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Tools finished' } });
      respond(id, { stopReason: 'end_turn' });
    }
    else {
      update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo:${text}` } });
      respond(id, { stopReason: text === 'max' ? 'max_tokens' : 'end_turn' });
    }
  } else if (method === 'session/cancel') {
    const pending = pendingTurns.get(params.sessionId);
    if (pending) { respond(pending, { stopReason: 'cancelled' }); pendingTurns.delete(params.sessionId); }
  } else respond(id, {});
}
