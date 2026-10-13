import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type * as acp from '@agentclientprotocol/sdk';
import { AGENT_IDS, createAgentAdapter, getDefaultLaunchSpec, isSupportedAgent } from './factory.js';
import type { AcpHubConfig, AgentAdapter, AgentCapabilities, AgentId, AgentSession, SessionEvent, TurnResult } from './types.js';

export interface ConnectionProfile {
  id: string;
  name: string;
  agent: AgentId;
  provider: string;
  baseURL: string;
  apiKey?: string;
  model: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface SessionRecord {
  id: string;
  agent: AgentId;
  profileId?: string;
  title: string;
  cwd: string;
  createdAt: string;
  acpSessionId?: string;
  status: 'idle' | 'running' | 'closed' | 'error';
  events: SessionEvent[];
  configOptions: acp.SessionConfigOption[];
  modes?: acp.SessionModeState | null;
  pendingPermissions: SessionEvent[];
  error?: string;
  adapter?: AgentAdapter;
  session?: AgentSession;
  consumer?: Promise<void>;
  turn?: Promise<TurnResult>;
  nativeSessionId?: string;
  nativeProvider?: string;
  deliveredMessages?: string[];
}

/** Owns ACP processes and transcripts independently of browser mounts. */
export class AcpHub {
  readonly storageDir: string;
  readonly #config: AcpHubConfig;
  readonly #profiles = new Map<string, ConnectionProfile>();
  readonly #sessions = new Map<string, SessionRecord>();
  readonly ready: Promise<void>;
  #writes: Promise<void> = Promise.resolve();
  #disposed = false;
  readonly #listeners = new Map<string, Set<(event: SessionEvent) => void>>();
  readonly #profileListeners = new Set<() => void>();
  readonly #permissionWaiters = new Map<string, Set<(optionId?: string) => void>>();
  readonly #browserSessions = new Set<string>();

  onProfilesChanged(listener: () => void): () => void {
    this.#profileListeners.add(listener);
    return () => this.#profileListeners.delete(listener);
  }

  subscribe(id: string, listener: (event: SessionEvent) => void): () => void {
    const listeners = this.#listeners.get(id) ?? new Set();
    this.#listeners.set(id, listeners); listeners.add(listener);
    return () => { listeners.delete(listener); if (!listeners.size) this.#listeners.delete(id); };
  }

  #publish(record: SessionRecord, event: SessionEvent): void {
    record.events.push(event);
    for (const listener of this.#listeners.get(record.id) ?? []) listener(event);
  }

  constructor(config: AcpHubConfig = {}) {
    this.#config = config;
    this.storageDir = config.storageDir ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages', 'acp-hub');
    this.ready = this.#load();
  }

  async #load(): Promise<void> {
    await mkdir(this.storageDir, { recursive: true, mode: 0o700 });
    try {
      const saved = JSON.parse(await readFile(join(this.storageDir, 'workbench.json'), 'utf8'));
      for (const profile of saved.profiles ?? []) this.#profiles.set(profile.id, profile);
      for (const record of saved.sessions ?? []) this.#sessions.set(record.id, {
        ...record, status: 'closed', pendingPermissions: [],
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  async #save(): Promise<void> {
    const snapshot = JSON.stringify({
      profiles: [...this.#profiles.values()],
      sessions: [...this.#sessions.values()].map(({ adapter, session, consumer, turn, ...record }) => record),
    });
    const write = this.#writes.catch(() => {}).then(async () => {
      const temp = join(this.storageDir, 'workbench.json.tmp');
      await writeFile(temp, snapshot, { mode: 0o600 });
      await rename(temp, join(this.storageDir, 'workbench.json'));
    });
    this.#writes = write;
    await write;
  }

  agents() {
    return AGENT_IDS.map(id => ({ id, ...getDefaultLaunchSpec(id), ...this.#config.agents?.[id],
      connected: [...this.#sessions.values()].some(s => s.agent === id && s.session && s.status !== 'closed'),
    })).map(({ env, ...safe }) => safe);
  }

  profiles() {
    return [...this.#profiles.values()].map(({ apiKey, ...profile }) => ({ ...profile, hasApiKey: Boolean(apiKey) }));
  }

  async saveProfile(input: ConnectionProfile): Promise<unknown> {
    await this.ready;
    if (!isSupportedAgent(input.agent)) throw new Error('Unsupported agent');
    if (!input.name?.trim()) throw new Error('Connection name is required');
    for (const key of ['provider', 'baseURL', 'model', 'command'] as const) {
      if (typeof input[key] !== 'string') throw new Error(`${key} must be a string`);
    }
    if (input.baseURL) {
      const url = new URL(input.baseURL);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Endpoint must use HTTP or HTTPS');
    }
    if (!Array.isArray(input.args) || input.args.some(arg => typeof arg !== 'string')) throw new Error('Arguments must be an array of strings');
    if (!input.env || Object.values(input.env).some(value => typeof value !== 'string')) throw new Error('Environment must be a string map');
    const id = input.id || randomUUID();
    if (id === 'local' || !/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Connection id must use letters, numbers, hyphens or underscores and cannot be local');
    const prior = this.#profiles.get(id);
    const profile = { ...input, id, apiKey: input.apiKey === undefined ? prior?.apiKey : input.apiKey };
    this.#profiles.set(id, profile);
    await this.#save();
    for (const listener of this.#profileListeners) listener();
    return this.profiles().find(p => p.id === id);
  }

  async deleteProfile(id: string): Promise<void> {
    await this.ready;
    this.#profiles.delete(id);
    await this.#save();
    for (const listener of this.#profileListeners) listener();
  }

  #launchConfig(agent: AgentId, profile?: ConnectionProfile): AcpHubConfig {
    if (!profile) return this.#config;
    const env = { ...this.#config.agents?.[agent]?.env, ...profile.env };
    if (agent === 'claude-code') {
      if (profile.baseURL) env.ANTHROPIC_BASE_URL = profile.baseURL;
      if (profile.apiKey) { env.ANTHROPIC_API_KEY = profile.apiKey; env.ANTHROPIC_AUTH_TOKEN = undefined; }
      if (profile.model) env.ANTHROPIC_MODEL = profile.model;
    } else if (agent === 'codex') {
      const codexConfig: Record<string, unknown> = env.CODEX_CONFIG ? JSON.parse(env.CODEX_CONFIG) : {};
      if (profile.model) codexConfig.model = profile.model;
      if (profile.baseURL) {
        const provider = 'dsh_acp_gateway';
        codexConfig.model_provider = provider;
        codexConfig.model_providers = { [provider]: {
          name: profile.provider || profile.name, base_url: profile.baseURL,
          wire_api: 'responses', env_key: 'DSH_ACP_API_KEY',
        } };
        env.MODEL_PROVIDER = provider;
        if (profile.apiKey) env.DSH_ACP_API_KEY = profile.apiKey;
      }
      if (profile.apiKey) env.CODEX_API_KEY = profile.apiKey;
      env.CODEX_CONFIG = JSON.stringify(codexConfig);
    } else if (profile.baseURL || profile.apiKey || profile.model) {
      throw new Error('This agent needs provider/model settings in its own launch environment. Use the advanced environment field.');
    }
    return { ...this.#config, agents: { ...this.#config.agents, [agent]: {
      ...this.#config.agents?.[agent], command: profile.command || getDefaultLaunchSpec(agent).command,
      args: profile.args, env,
    } } };
  }

  async test(agent: AgentId, profileId?: string): Promise<AgentCapabilities> {
    await this.ready;
    const profile = profileId ? this.#profile(profileId) : undefined;
    const adapter = createAgentAdapter(profile?.agent ?? agent, this.#launchConfig(profile?.agent ?? agent, profile));
    try { return await adapter.connect(); } finally { await adapter.dispose(); }
  }

  #profile(id: string): ConnectionProfile {
    const profile = this.#profiles.get(id);
    if (!profile) throw new Error('Connection profile not found');
    return profile;
  }

  async create(input: { agent: AgentId; cwd: string; profileId?: string; resumeId?: string }) {
    await this.ready;
    if (this.#disposed) throw new Error('Hub is disposed');
    if (!isAbsolute(input.cwd)) throw new Error('Working directory must be an absolute path');
    if (!(await stat(input.cwd)).isDirectory()) throw new Error('Working directory must exist and be a directory');
    const profile = input.profileId ? this.#profile(input.profileId) : undefined;
    const agent = profile?.agent ?? input.agent;
    if (!isSupportedAgent(agent)) throw new Error('Unsupported agent');
    const old = input.resumeId ? this.#record(input.resumeId) : undefined;
    if (old?.session) {
      if (old.status === 'error') await this.close(old.id);
      else throw new Error('Session is already connected');
    }
    const adapter = createAgentAdapter(agent, this.#launchConfig(agent, profile));
    try {
      const capabilities = await adapter.connect();
      if (this.#disposed) throw new Error('Hub is disposed');
      if (old && !capabilities.supportsLoad) throw new Error('Agent does not support restoring sessions');
      const session = await adapter.createSession({ cwd: input.cwd, resumeSessionId: old?.acpSessionId });
      if (this.#disposed) { await session.dispose(); throw new Error('Hub is disposed'); }
      const raw = session.raw as acp.NewSessionResponse;
      const record: SessionRecord = { id: old?.id ?? randomUUID(), agent, cwd: input.cwd,
        profileId: profile?.id, title: old?.title ?? `${profile?.name ?? agent} · ${input.cwd.split('/').pop()}`,
        createdAt: old?.createdAt ?? new Date().toISOString(), acpSessionId: session.id,
        status: 'idle', events: old?.events ?? [], configOptions: raw.configOptions ?? [], modes: raw.modes,
        pendingPermissions: [], adapter, session,
        nativeSessionId: old?.nativeSessionId, nativeProvider: old?.nativeProvider,
        deliveredMessages: old?.deliveredMessages,
      };
      if (profile?.model) {
        const option = record.configOptions.find(o => o.category === 'model');
        if (option?.type === 'select') {
          await session.setConfigOption?.({ configId: option.id, value: profile.model });
          option.currentValue = profile.model;
        }
      }
      this.#sessions.set(record.id, record);
      record.consumer = this.#consume(record);
      await this.#save();
      return this.info(record.id);
    } catch (error) { await adapter.dispose(); throw error; }
  }

  async #consume(record: SessionRecord): Promise<void> {
    try {
      for await (const event of record.session!.events) {
        if (event.type === 'permission_request') {
          record.pendingPermissions.push(event);
          if (this.#config.autoAllowPermissions && !record.nativeSessionId) {
            const allow = event.options?.find(o => o.kind === 'allow_always')
              ?? event.options?.find(o => o.kind === 'allow_once');
            if (allow) await this.permission(record.id, event.requestId!, allow.optionId);
          }
        }
        if (event.type === 'permission_resolved') record.pendingPermissions = record.pendingPermissions.filter(p => p.requestId !== event.requestId);
        const update = (event.raw as { update?: { sessionUpdate?: string; configOptions?: acp.SessionConfigOption[] } })?.update;
        if (update?.sessionUpdate === 'config_option_update' && update.configOptions) record.configOptions = update.configOptions;
        if (event.type === 'mode_update' && record.modes) {
          const mode = (event.raw as { update?: { currentModeId?: string } })?.update?.currentModeId;
          if (mode) record.modes.currentModeId = mode;
        }
        if (event.type === 'agent_error') { record.status = 'error'; record.error = event.message; }
        this.#publish(record, event);
      }
    } catch (error) {
      record.status = 'error'; record.error = String(error);
      record.events.push({ type: 'agent_error', message: record.error });
    } finally {
      if (record.status !== 'error') record.status = 'closed';
      record.pendingPermissions = [];
      await this.#save();
    }
  }

  #record(id: string): SessionRecord {
    const record = this.#sessions.get(id);
    if (!record) throw new Error('Session not found');
    return record;
  }

  info(id: string) {
    const { events, adapter, session, consumer, turn, ...info } = this.#record(id);
    return { ...info, connected: Boolean(session) && info.status !== 'closed' && info.status !== 'error' };
  }

  sessions() { return [...this.#sessions.keys()].map(id => this.info(id)); }

  async nativeSession(nativeId: string, provider: string, agent: AgentId, cwd: string, profileId?: string) {
    await this.ready;
    let record = [...this.#sessions.values()].find(s => s.nativeSessionId === nativeId && s.nativeProvider === provider);
    if (record) {
      if (!this.info(record.id).connected) await this.create({ agent, cwd, profileId, resumeId: record.id });
      return this.info(record.id);
    }
    const created = await this.create({ agent, cwd, profileId });
    record = this.#record(created.id);
    record.nativeSessionId = nativeId; record.nativeProvider = provider; record.deliveredMessages = [];
    await this.#save();
    return this.info(record.id);
  }

  async markDelivered(id: string, messageIds: string[]): Promise<void> {
    const record = this.#record(id);
    record.deliveredMessages = [...new Set([...(record.deliveredMessages ?? []), ...messageIds])];
    await this.#save();
  }

  async releaseNative(nativeId: string): Promise<void> {
    this.#browserSessions.delete(nativeId);
    await Promise.all([...this.#sessions.values()].filter(s => s.nativeSessionId === nativeId && s.session).map(s => this.close(s.id)));
  }

  events(id: string, after: number) {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid event cursor');
    const record = this.#record(id);
    const events = record.events.slice(after, after + 500);
    return { events, next: after + events.length, session: this.info(id) };
  }

  markBrowserSession(nativeSessionId: string): void { this.#browserSessions.add(nativeSessionId); }
  isBrowserSession(nativeSessionId: string): boolean { return this.#browserSessions.has(nativeSessionId); }

  waitForPermission(id: string, requestId: string): Promise<string | undefined> {
    const key = `${id}:${requestId}`;
    const record = this.#record(id);
    if (!record.pendingPermissions.some(permission => permission.requestId === requestId)) return Promise.resolve(undefined);
    return new Promise(resolve => {
      const waiters = this.#permissionWaiters.get(key) ?? new Set();
      waiters.add(resolve);
      this.#permissionWaiters.set(key, waiters);
    });
  }

  clearPermissionWait(id: string, requestId: string): void {
    this.#permissionWaiters.delete(`${id}:${requestId}`);
  }


  prompt(id: string, text: string): void {
    void this.promptAndWait(id, text).catch(() => {});
  }

  async promptAndWait(id: string, text: string): Promise<TurnResult> {
    const record = this.#record(id);
    if (!record.session || record.status !== 'idle') throw new Error('Session must be connected and idle');
    if (!text.trim()) throw new Error('Message cannot be empty');
    record.status = 'running';
    record.events.push({ type: 'user_message', text });
    record.turn = record.session.prompt(text);
    try {
      const result = await record.turn;
      // Notification callbacks run before the prompt response; allow the stream reader to drain.
      await new Promise<void>(resolve => setImmediate(resolve));
      record.events.push({ type: 'turn_end', stopReason: result.stopReason });
      if (record.session && this.info(id).status !== 'closed') record.status = 'idle';
      return result;
    } catch (error) {
      record.events.push({ type: 'agent_error', message: String(error) });
      if (record.session && this.info(id).status !== 'closed') record.status = 'error';
      record.error = String(error);
      throw error;
    } finally { record.turn = undefined; await this.#save(); }
  }

  async interrupt(id: string): Promise<void> {
    const record = this.#record(id);
    for (const permission of [...record.pendingPermissions]) await this.permission(id, permission.requestId!);
    await record.session?.interrupt();
  }

  async permission(id: string, requestId: string, optionId?: string): Promise<void> {
    const record = this.#record(id);
    if (!record.session) throw new Error('Session is not connected');
    if (optionId) await record.session.respondPermission(requestId, optionId);
    else await record.session.cancelPermission(requestId);
    record.pendingPermissions = record.pendingPermissions.filter(p => p.requestId !== requestId);
    record.events.push({ type: 'permission_resolved', requestId });
    const key = `${id}:${requestId}`;
    for (const resolve of this.#permissionWaiters.get(key) ?? []) resolve(optionId);
    this.#permissionWaiters.delete(key);
  }

  async configure(id: string, configId: string, value: string | boolean): Promise<void> {
    const record = this.#record(id);
    if (record.status !== 'idle' || !record.session) throw new Error('Session must be idle');
    const option = record.configOptions.find(o => o.id === configId);
    if (!option) throw new Error('Agent did not advertise this setting');
    const result = await record.session.setConfigOption?.({ configId, value, ...(option.type === 'boolean' ? { type: 'boolean' } : {}) }) as { configOptions?: acp.SessionConfigOption[] };
    record.configOptions = result?.configOptions ?? record.configOptions;
    await this.#save();
  }

  async setMode(id: string, modeId: string): Promise<void> {
    const record = this.#record(id);
    if (record.status !== 'idle' || !record.modes?.availableModes.some(m => m.id === modeId)) throw new Error('Mode unavailable');
    await record.session?.setMode?.(modeId);
    record.modes.currentModeId = modeId;
    await this.#save();
  }

  async deleteSession(id: string): Promise<void> {
    await this.close(id);
    this.#sessions.delete(id);
    await this.#save();
  }

  async close(id: string): Promise<void> {
    const record = this.#record(id);
    await record.session?.dispose();
    await record.adapter?.dispose();
    record.session = undefined; record.adapter = undefined; record.status = 'closed';
    await record.consumer;
    await this.#save();
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    await this.ready;
    await Promise.allSettled([...this.#sessions.keys()].map(id => this.close(id)));
    await this.#writes;
  }
}
