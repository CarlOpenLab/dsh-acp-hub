import type { Context } from '@deepseek-ai/cordis';
import { LlmAdapter, LlmError, type GenerateOptions, type StreamChunk, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ApprovalService } from '@deepseek-ai/dsh-user-approval';
import type { AgentRegistry } from '@deepseek-ai/dsh-agent';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';
import { AcpHub } from './hub.js';
import { AGENT_IDS } from './factory.js';
import type { AgentId, SessionEvent } from './types.js';
import { NativeToolRecorder } from './native-tools.js';

export const NATIVE_PREFIX = 'acp-hub/';
interface Route { provider: string; agent: AgentId; profileId?: string; name: string }
interface NativeContext extends Context { agents: AgentRegistry; approval: ApprovalService }

export class NativeAcpAdapter extends LlmAdapter {
  readonly #routes = new Map<string, Route>();
  readonly #catalogs = new Map<string, { models: { id: string; name: string }[]; options: SessionConfigOption[] }>();
  readonly #loads = new Map<string, Promise<void>>();
  constructor(readonly hub: AcpHub, readonly ctx: NativeContext) { super(); this.refresh(); }

  refresh(): string[] {
    this.#routes.clear(); this.#catalogs.clear();
    for (const agent of AGENT_IDS) this.#routes.set(`${NATIVE_PREFIX}${agent}/local`, {
      provider: `${NATIVE_PREFIX}${agent}/local`, agent, name: `${agent} · 本机登录`,
    });
    for (const profile of this.hub.profiles()) {
      const provider = `${NATIVE_PREFIX}${profile.agent}/${profile.id}`;
      this.#routes.set(provider, { provider, agent: profile.agent, profileId: profile.id, name: profile.name });
    }
    return [...this.#routes.keys()];
  }

  route(provider: string): Route {
    const route = this.#routes.get(provider);
    if (!route) throw new LlmError('ACP connection no longer exists', 'ACP_CONNECTION_MISSING');
    return route;
  }

  override providerInfo(provider: string) { return { id: provider, name: this.route(provider).name }; }
  override providerRetryPolicy() {
    // ACP owns tool execution: automatic replay could repeat filesystem side effects.
    return { mode: 'normal' as const, maxRetries: 0, retryableCodes: [], initialDelayMs: 500, maxDelayMs: 1000, jitterRatio: 0 };
  }

  override async listModels(provider: string) {
    const profile = this.hub.profiles().find(p => p.id === this.route(provider).profileId);
    return (this.#catalogs.get(provider)?.models ?? [{ id: profile?.model || 'default', name: profile?.model || '代理默认模型' }]).map(model => ({ ...model, provider }));
  }

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    this.route(provider);
    return { provider, id: model, name: model === 'default' ? '代理默认模型' : model, inputModalities: ['text'] };
  }

  async discover(provider: string, cwd: string): Promise<void> {
    if (this.#catalogs.has(provider)) return;
    const existing = this.#loads.get(provider);
    if (existing) return existing;
    const route = this.route(provider);
    const pending = (async () => {
      const session = await this.hub.create({ agent: route.agent, profileId: route.profileId, cwd });
      try { this.#cache(provider, session.configOptions); }
      finally { await this.hub.deleteSession(session.id); }
    })();
    this.#loads.set(provider, pending);
    try { await pending; } finally { this.#loads.delete(provider); }
  }

  #cache(provider: string, options: SessionConfigOption[]): void {
    const option = options.find(o => o.category === 'model');
    const models = option?.type === 'select' ? option.options.flatMap(o => 'options' in o ? o.options : [o]).map(o => ({ id: o.value, name: o.name })) : [];
    this.#catalogs.set(provider, { models: models.length ? models : [{ id: 'default', name: '代理默认模型' }], options });
    this.ctx.emit('llm/adapters-updated');
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose) throw new LlmError('ACP agents do not provide auxiliary model calls', 'ACP_AUXILIARY_UNSUPPORTED');
    if (!options.sessionId) throw new LlmError('ACP requires a native session', 'ACP_SESSION_REQUIRED');
    const agent = this.ctx.agents.get(options.sessionId);
    if (!agent) throw new LlmError('Native agent is unavailable', 'ACP_SESSION_REQUIRED');
    const route = this.route(options.provider);
    options.signal?.throwIfAborted();
    const native = await this.hub.nativeSession(String(options.sessionId), options.provider, route.agent,
      agent.session.header.cwd ?? process.cwd(), route.profileId);
    options.signal?.throwIfAborted();
    this.#cache(options.provider, native.configOptions);
    const modelOption = native.configOptions.find(o => o.category === 'model');
    if (options.model !== 'default' && modelOption?.type === 'select' && modelOption.currentValue !== options.model) {
      await this.hub.configure(native.id, modelOption.id, options.model);
    }
    const effort = native.configOptions.find(o => o.category === 'thought_level');
    if (options.reasoningEffort && effort) await this.hub.configure(native.id, effort.id, options.reasoningEffort);
    const delivered = new Set(native.deliveredMessages ?? []);
    const messages = options.messages.filter(m => m.role === 'user' && m.source.kind === 'user' && !delivered.has(String(m.id)));
    if (messages.some(m => m.content.some(b => b.type !== 'text'))) {
      throw new LlmError('ACP native sessions currently support text messages; attachments are not supported yet', 'ACP_TEXT_REQUIRED');
    }
    if (!messages.length) throw new LlmError('No new message to send to the ACP agent', 'ACP_NO_NEW_MESSAGE');
    const prompt = messages.map(m => m.content.map(b => b.type === 'text' ? b.text : '').join('\n')).join('\n\n');
    if (!prompt.trim()) throw new LlmError('ACP currently accepts text prompts', 'ACP_TEXT_REQUIRED');

    const queue: SessionEvent[] = [];
    let wake: (() => void) | undefined;
    const notify = () => { wake?.(); wake = undefined; };
    const unsubscribe = this.hub.subscribe(native.id, event => { queue.push(event); notify(); });
    let done = false;
    let failure: unknown;
    let stopReason = 'end_turn';
    let index = 0;
    let block: { index: number; type: 'text' | 'reasoning'; text: string } | undefined;
    const permissionTasks = new Set<Promise<void>>();
    let tools: NativeToolRecorder | undefined;
    const recorder = () => tools ??= new NativeToolRecorder(agent.session);
    const abort = () => { void this.hub.interrupt(native.id).catch(() => {}); notify(); };
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      // Persist admitted message ids before execution; retries must not repeat agent work.
      await this.hub.markDelivered(native.id, messages.map(m => String(m.id)));
      const turn = this.hub.promptAndWait(native.id, prompt).then(result => { stopReason = result.stopReason; }, error => { failure = error; }).finally(() => { done = true; notify(); });
      while (!done || queue.length) {
        if (!queue.length) { await new Promise<void>(resolve => { wake = resolve; }); continue; }
        const event = queue.shift()!;
        if (event.type === 'permission_request') {
          const request = event.raw as { toolCall?: import('@agentclientprotocol/sdk').ToolCallUpdate };
          const callId = request.toolCall ? recorder().record(request.toolCall) : undefined;
          const task = this.#permission(agent, native.id, event, options.signal, callId).finally(() => permissionTasks.delete(task));
          permissionTasks.add(task);
          continue;
        }
        let text = '', type: 'text' | 'reasoning' = 'text';
        if (event.type === 'message_delta') text = event.text ?? '';
        else if (event.type === 'thought_delta') { text = event.text ?? ''; type = 'reasoning'; }
        else if (event.toolCall) {
          recorder().record((event.raw as { update: import('@agentclientprotocol/sdk').ToolCallUpdate }).update);
        } else if (event.type === 'plan') text = '\n\n' + event.plan!.entries.map(e => `- [${e.status === 'completed' ? 'x' : ' '}] ${e.content}`).join('\n') + '\n\n';
        else if (event.type === 'agent_error') failure = new Error(event.message);
        if (!text) continue;
        if (block && block.type !== type) {
          yield { type: 'block-end', index: block.index, block: { type: block.type, text: block.text } }; block = undefined;
        }
        if (!block) { block = { index: index++, type, text: '' }; yield { type: 'block-start', index: block.index, blockType: type }; }
        block.text += text;
        yield { type: type === 'text' ? 'text-delta' : 'reasoning-delta', index: block.index, text };
      }
      await turn;
      await Promise.all(permissionTasks);
      if (block) yield { type: 'block-end', index: block.index, block: { type: block.type, text: block.text } };
      options.signal?.throwIfAborted();
      if (failure) throw failure;
      yield { type: 'finish', reason: { kind: stopReason === 'max_tokens' ? 'max-tokens' : 'stop' } };
    } finally {
      unsubscribe(); options.signal?.removeEventListener('abort', abort);
      if (!done) await this.hub.interrupt(native.id);
      tools?.finish(Boolean(options.signal?.aborted) || Boolean(failure) || !done);
    }
  }

  async #permission(agent: Agent, id: string, event: SessionEvent, signal?: AbortSignal, callId?: import('@deepseek-ai/dsh-llm').ToolCallId): Promise<void> {
    try {
      const request = event.raw as { toolCall?: { title?: string } };
      const outcome = await this.ctx.approval.request({ agent, toolName: request.toolCall?.title ?? 'ACP action', reason: request.toolCall?.title ?? 'ACP agent requests permission', signal, ...(callId ? { callId } : {}) });
      const allow = event.options?.find(o => o.kind === 'allow_once');
      if (outcome === 'allowed-once' && allow) await this.hub.permission(id, event.requestId!, allow.optionId);
      else await this.hub.permission(id, event.requestId!);
    } catch (error) {
      this.ctx.logger?.error('ACP approval failed: %s', error);
      await this.hub.permission(id, event.requestId!).catch(() => {});
    }
  }
}

export function installNative(context: Context, hub: AcpHub): NativeAcpAdapter {
  const ctx = context as NativeContext;
  const adapter = new NativeAcpAdapter(hub, ctx);
  const registration = ctx.llm.registerAdapter(adapter.refresh(), adapter);
  ctx.effect(() => hub.onProfilesChanged(() => registration.replace(adapter.refresh())), 'acp-hub: native routes');
  ctx.on('agent/disposed', ({ agent }) => { void hub.releaseNative(String(agent.id)).catch(error => ctx.logger.error(error)); });
  return adapter;
}
