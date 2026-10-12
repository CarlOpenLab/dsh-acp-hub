import { randomUUID } from 'node:crypto';
import { ToolCallId, createToolResultMessage, type ContentBlock } from '@deepseek-ai/dsh-llm';
import { SessionSeq, type Session } from '@deepseek-ai/dsh-session';
import type { ToolCall, ToolCallUpdate } from '@agentclientprotocol/sdk';

type Update = ToolCall | ToolCallUpdate;
interface Call {
  id: ToolCallId;
  seq: SessionSeq;
  update: Update;
  updates: Update[];
  settled: boolean;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Normalize only fields supplied by ACP; the original payload remains in result metadata. */
function presentation(update: Update): { name: string; args: Record<string, unknown> } {
  const input = object(update.rawInput);
  const args = { ...input, description: update.title ?? 'ACP tool' };
  const path = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : update.locations?.[0]?.path;
  if (path) Object.assign(args, { file_path: path });
  const diff = update.content?.find(item => item.type === 'diff');
  if (update.kind === 'read' && path) return { name: 'read', args };
  if (update.kind === 'execute' && typeof input.command === 'string') return { name: 'bash', args };
  if (update.kind === 'edit' && diff?.type === 'diff') {
    return diff.oldText === null
      ? { name: 'write', args: { ...args, file_path: diff.path, content: diff.newText } }
      : { name: 'edit', args: { ...args, file_path: diff.path, old_string: diff.oldText, new_string: diff.newText } };
  }
  if (update.kind === 'edit' && path && typeof input.old_string === 'string' && typeof input.new_string === 'string') return { name: 'edit', args };
  if (update.kind === 'edit' && path && typeof input.content === 'string') return { name: 'write', args };
  return { name: update.title || `ACP ${update.kind || 'tool'}`, args };
}

function output(update: Update): ContentBlock[] {
  const parts: string[] = [];
  for (const item of update.content ?? []) {
    if (item.type === 'content') {
      if (item.content.type === 'text') parts.push(item.content.text);
      else parts.push(JSON.stringify(item.content, null, 2));
    } else if (item.type === 'diff') {
      // Keep a readable fallback when the call head could not select a file card.
      parts.push(JSON.stringify(item, null, 2));
    } else parts.push(JSON.stringify(item, null, 2));
  }
  if (!parts.length && update.rawOutput !== undefined && update.rawOutput !== null) {
    parts.push(typeof update.rawOutput === 'string' ? update.rawOutput : JSON.stringify(update.rawOutput, null, 2));
  }
  return [{ type: 'text', text: parts.join('\n\n') || (update.status === 'failed' ? 'ACP tool failed' : update.title || 'ACP tool completed') }];
}

/** Record externally executed tools. Never yield tool-call blocks to the DSH execution loop. */
export class NativeToolRecorder {
  readonly #calls = new Map<string, Call>();
  readonly #namespace = randomUUID();
  readonly #location: { turn: number; step: number };
  constructor(readonly session: Session) {
    let location: { turn: number; step: number } | undefined;
    for (let seq = session.seq - 1; seq >= 0; seq--) {
      const event = session.eventAt(SessionSeq(seq));
      if (event?.type === 'step/end' || event?.type === 'turn/end') break;
      if (event?.type === 'step/start') { location = event.data; break; }
    }
    if (!location) throw new Error('ACP tool recording requires an open native step');
    this.#location = location;
  }

  record(update: Update): ToolCallId {
    let call = this.#calls.get(update.toolCallId);
    if (!call) {
      const id = ToolCallId(`acp:${this.#namespace}:${update.toolCallId}`);
      const { name, args } = presentation(update);
      const event = this.session.append('tool/call', { ...this.#location, callId: id, name, arguments: JSON.stringify(args) });
      call = { id, seq: event.seq, update, updates: [], settled: false };
      this.#calls.set(update.toolCallId, call);
    }
    if (call.settled) return call.id;
    // ACP updates replace content arrays; missing/null fields leave the prior value intact.
    const fields = Object.fromEntries(Object.entries(update).filter(([, value]) => value !== undefined && value !== null));
    call.update = { ...call.update, ...fields } as Update;
    call.updates.push(update);
    if (call.update.status === 'completed' || call.update.status === 'failed') this.#settle(call);
    return call.id;
  }

  finish(interrupted: boolean): void {
    for (const call of this.#calls.values()) if (!call.settled) this.#settle(call, interrupted ? 'interrupted' : 'ACP_TOOL_INCOMPLETE');
  }

  #settle(call: Call, errorCode?: string): void {
    const failed = Boolean(errorCode) || call.update.status === 'failed';
    const diffs = call.update.content?.filter(item => item.type === 'diff').map(item => ({ path: item.path, oldText: item.oldText, newText: item.newText })) ?? [];
    this.session.append('tool/result', {
      ...this.#location,
      message: createToolResultMessage({ callId: call.id, content: errorCode ? [{ type: 'text', text: errorCode === 'interrupted' ? 'ACP tool interrupted' : 'ACP turn ended before this tool reported a result' }] : output(call.update), isError: failed }),
      ...(failed ? { error: { name: errorCode === 'interrupted' ? 'Interrupted' : 'AcpToolError', code: errorCode || 'ACP_TOOL_FAILED' } } : {}),
      meta: JSON.parse(JSON.stringify({ ...(diffs.length ? { diffs } : {}), acp: { ...call.update, updates: call.updates } })),
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] });
    call.settled = true;
  }
}
