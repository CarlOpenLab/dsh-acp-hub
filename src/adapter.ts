/**
 * ACP Agent Adapter — spawns an agent subprocess and bridges it to the
 * unified AgentAdapter interface over JSON-RPC stdio.
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import type {
  AdapterOptions,
  AgentAdapter,
  AgentCapabilities,
  AgentId,
  AgentLaunchSpec,
  AgentSession,
  CreateSessionOptions,
  SessionEvent,
  TurnResult,
} from './types.js';

const DEFAULT_CLIENT_INFO = { name: 'dsh-acp-hub', version: '0.1.0' } as const;

function toWebWritable(writable: Writable): WritableStream<Uint8Array> {
  writable.on('error', () => {}); // swallow EPIPE
  return Writable.toWeb(writable) as unknown as WritableStream<Uint8Array>;
}

function toWebReadable(readable: Readable): ReadableStream<Uint8Array> {
  return Readable.toWeb(readable) as unknown as ReadableStream<Uint8Array>;
}

function toCapabilities(init: acp.InitializeResponse): AgentCapabilities {
  return {
    raw: init,
    protocolVersion: init.protocolVersion,
    authMethods: init.authMethods ?? [],
    supportsLoad: init.agentCapabilities?.loadSession === true,
  };
}

/** Owns one agent subprocess and the ACP connection to it. */
export class AcpAgentConnection {
  readonly #spec: AgentLaunchSpec;
  readonly #options: AdapterOptions;
  readonly #log: NonNullable<AdapterOptions['logger']>;
  readonly #sessions = new Map<string, AcpSession>();
  readonly #clientHandler: acp.Client;
  #process?: ChildProcess;
  #connection?: acp.ClientSideConnection;
  #initResponse?: acp.InitializeResponse;
  #closed = false;
  #deathDuringInit?: { promise: Promise<never>; reject: (error: unknown) => void };

  constructor(spec: AgentLaunchSpec, options: AdapterOptions = {}) {
    this.#spec = spec;
    this.#options = options;
    this.#log = options.logger ?? (() => {});

    this.#clientHandler = {
      sessionUpdate: async (params: acp.SessionNotification): Promise<void> => {
        const session = this.#sessions.get(params.sessionId);
        if (session) {
          session.handleNotification(params);
          return;
        }
        // Adopt unknown session updates (some agents reassign session ids)
        const candidates = [...this.#sessions.values()].filter(
          (s) => s.adoptable && !s.receivedUpdate,
        );
        const adopted = candidates.length === 1 ? candidates[0] : undefined;
        if (adopted) {
          adopted.adoptAlias(params.sessionId);
          this.#sessions.set(params.sessionId, adopted);
          adopted.handleNotification(params);
          return;
        }
      },
      requestPermission: async (
        params: acp.RequestPermissionRequest,
      ): Promise<acp.RequestPermissionResponse> => {
        const session =
          this.#sessions.get(params.sessionId) ??
          [...this.#sessions.values()].find((s) => s.aliases.has(params.sessionId));
        if (!session) return { outcome: { outcome: 'cancelled' } };
        return session.handlePermissionRequest(params);
      },
    };
  }

  get isConnected(): boolean {
    return this.#connection !== undefined && this.#initResponse !== undefined && !this.#closed;
  }

  get rawConnection(): acp.ClientSideConnection | undefined {
    return this.#connection;
  }

  async connect(): Promise<AgentCapabilities> {
    if (this.isConnected && this.#initResponse) return toCapabilities(this.#initResponse);
    if (this.#closed) throw new Error('Connection already disposed');

    const child = spawn(this.#spec.command, this.#spec.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.#spec.env },
      ...(this.#spec.cwd !== undefined ? { cwd: this.#spec.cwd } : {}),
      windowsHide: true,
    });
    this.#process = child;

    let rejectDeathDuringInit: ((error: unknown) => void) | undefined;
    const deathDuringInit = new Promise<never>((_, reject) => {
      rejectDeathDuringInit = reject;
    });
    deathDuringInit.catch(() => {});
    this.#deathDuringInit = { promise: deathDuringInit, reject: rejectDeathDuringInit! };

    child.on('error', (err: NodeJS.ErrnoException) => {
      const error = new Error(`Failed to launch "${this.#spec.command}": ${err.message}`);
      if (!this.#initResponse) rejectDeathDuringInit?.(error);
      this.#handleDeath(error);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trimEnd();
      if (text.length > 0) this.#log('debug', `[${this.#spec.command} stderr] ${text}`);
    });

    child.on('exit', (code, signal) => {
      const error = new Error(
        `Agent process exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
      );
      if (!this.#initResponse) rejectDeathDuringInit?.(error);
      this.#handleDeath(error);
    });

    if (!child.stdin || !child.stdout) {
      this.#closed = true;
      throw new Error('Agent subprocess stdio pipes unavailable');
    }

    const stream = acp.ndJsonStream(toWebWritable(child.stdin), toWebReadable(child.stdout));
    const connection = new acp.ClientSideConnection(() => this.#clientHandler, stream);
    this.#connection = connection;

    const timeoutMs = this.#options.initializeTimeoutMs ?? 30_000;
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Agent did not complete initialize within ${timeoutMs}ms`)),
        timeoutMs,
      );
    });
    timeoutPromise.catch(() => {});

    try {
      const init = await Promise.race([
        connection.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
          },
          clientInfo: this.#options.clientInfo ?? { ...DEFAULT_CLIENT_INFO },
        }),
        deathDuringInit,
        timeoutPromise,
      ]);
      this.#initResponse = init;
      return toCapabilities(init);
    } catch (error) {
      this.#closed = true;
      try { child.kill('SIGKILL'); } catch { /* already dead */ }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      this.#deathDuringInit = undefined;
    }
  }

  async createSession(options: CreateSessionOptions): Promise<AcpSession> {
    const connection = this.#connection;
    if (!connection || !this.#initResponse) {
      throw new Error('connect() must complete before createSession()');
    }
    const mcpServers = (options.mcpServers ?? []) as acp.McpServer[];
    const meta = options.meta as acp.NewSessionRequest['_meta'];
    const response: acp.NewSessionResponse | acp.LoadSessionResponse = options.resumeSessionId
      ? await connection.loadSession({
          cwd: options.cwd,
          mcpServers,
          sessionId: options.resumeSessionId,
          ...(meta ? { _meta: meta } : {}),
        })
      : await connection.newSession({
          cwd: options.cwd,
          mcpServers,
          ...(meta ? { _meta: meta } : {}),
        });
    const sessionId =
      options.resumeSessionId ?? (response as acp.NewSessionResponse).sessionId;
    const session = new AcpSession(sessionId, response, this, {
      adoptable: Boolean(options.resumeSessionId),
    });
    this.#sessions.set(session.id, session);
    return session;
  }

  async prompt(
    sessionId: string,
    blocks: acp.ContentBlock[],
    meta?: Record<string, unknown>,
  ): Promise<acp.PromptResponse> {
    if (!this.#connection) throw new Error('Agent connection is not open');
    const promptMeta = meta as acp.PromptRequest['_meta'];
    return this.#connection.prompt({
      sessionId,
      prompt: blocks,
      ...(promptMeta ? { _meta: promptMeta } : {}),
    });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.#connection?.cancel({ sessionId });
  }

  async setSessionConfigOption(
    params: acp.SetSessionConfigOptionRequest,
  ): Promise<acp.SetSessionConfigOptionResponse> {
    if (!this.#connection) throw new Error('Agent connection is not open');
    return this.#connection.setSessionConfigOption(params);
  }

  onSessionDisposed(sessionId: string): void {
    this.#sessions.delete(sessionId);
  }

  async dispose(): Promise<void> {
    this.#closed = true;
    for (const session of [...this.#sessions.values()]) {
      await session.dispose();
    }
    const child = this.#process;
    this.#process = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      let killTimer: NodeJS.Timeout | undefined;
      let finishTimer: NodeJS.Timeout | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(killTimer);
        clearTimeout(finishTimer);
        resolve();
      };
      child.once('exit', finish);
      try { child.kill('SIGTERM'); } catch { finish(); }
      const graceMs = this.#options.killGraceMs ?? 5_000;
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already dead */ }
      }, graceMs).unref?.();
      finishTimer = setTimeout(finish, graceMs + 1_000);
      finishTimer.unref?.();
    });
  }

  #handleDeath(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const session of [...this.#sessions.values()]) {
      session.handleClosed(error);
    }
    this.#sessions.clear();
  }
}

/** One ACP session with an agent. */
export class AcpSession implements AgentSession {
  readonly #id: string;
  readonly #raw: unknown;
  readonly #connection: AcpAgentConnection;
  readonly #contentController: ReadableStreamDefaultController<SessionEvent>;
  readonly #contentStream: ReadableStream<SessionEvent>;
  readonly #aliases = new Set<string>();
  #receivedUpdate = false;
  #adoptable: boolean;
  #closed = false;
  #permissionRequests = new Map<string, {
    resolve: (response: acp.RequestPermissionResponse) => void;
    timer: NodeJS.Timeout;
    options: Set<string>;
  }>();

  constructor(
    id: string,
    raw: unknown,
    connection: AcpAgentConnection,
    options: { adoptable?: boolean } = {},
  ) {
    this.#id = id;
    this.#raw = raw;
    this.#connection = connection;
    this.#adoptable = options.adoptable ?? false;

    let contentCtrl: ReadableStreamDefaultController<SessionEvent>;
    this.#contentStream = new ReadableStream<SessionEvent>({
      start(controller) { contentCtrl = controller; },
    });
    this.#contentController = contentCtrl!;
  }

  get id(): string { return this.#id; }
  get aliases(): ReadonlySet<string> { return this.#aliases; }
  get raw(): unknown { return this.#raw; }
  get events(): AsyncIterable<SessionEvent> { return this.#contentStream; }

  get adoptable(): boolean { return this.#adoptable; }
  get receivedUpdate(): boolean { return this.#receivedUpdate; }

  onAlias?: (alias: string) => void;

  adoptAlias(alias: string): void {
    this.#aliases.add(alias);
    this.onAlias?.(alias);
  }

  handleNotification(params: acp.SessionNotification): void {
    if (this.#closed) return;
    this.#receivedUpdate = true;
    const event = translateSessionUpdate(params);
    if (event) this.#contentController.enqueue(event);
  }

  handlePermissionRequest(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    if (this.#closed) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    const requestId = randomUUID();
    const options = params.options?.map((option) => ({
      optionId: option.optionId,
      kind: option.kind,
      name: option.name,
    }));
    this.#contentController.enqueue({ type: 'permission_request', requestId, options, raw: params });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#permissionRequests.delete(requestId);
        if (!this.#closed) this.#contentController.enqueue({ type: 'permission_resolved', requestId });
        resolve({ outcome: { outcome: 'cancelled' } });
      }, 5 * 60_000);
      timer.unref?.();
      this.#permissionRequests.set(requestId, { resolve, timer, options: new Set(params.options.map(option => option.optionId)) });
    });
  }

  async prompt(input: string): Promise<TurnResult> {
    if (this.#closed) throw new Error('Session is closed');
    const response = await this.#connection.prompt(this.#id, [
      { type: 'text', text: input },
    ]);
    return { stopReason: response.stopReason };
  }

  async setMode(modeId: string): Promise<void> {
    await this.#connection.rawConnection?.setSessionMode({ sessionId: this.id, modeId });
  }

  async setConfigOption(params: unknown): Promise<unknown> {
    const option = params as { configId: string; value: string };
    return this.#connection.setSessionConfigOption({ sessionId: this.id, ...option });
  }

  async interrupt(): Promise<void> {
    await this.#connection.cancel(this.#id);
  }

  async respondPermission(_requestId: string, _optionId: string): Promise<void> {
    const pending = this.#permissionRequests.get(_requestId);
    if (!pending) throw new Error(`Unknown permission request: ${_requestId}`);
    if (!pending.options.has(_optionId)) throw new Error('Invalid permission option');
    clearTimeout(pending.timer);
    this.#permissionRequests.delete(_requestId);
    pending.resolve({ outcome: { outcome: 'selected', optionId: _optionId } });
  }

  async cancelPermission(_requestId: string): Promise<void> {
    const pending = this.#permissionRequests.get(_requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.#permissionRequests.delete(_requestId);
    pending.resolve({ outcome: { outcome: 'cancelled' } });
  }

  async dispose(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const requestId of this.#permissionRequests.keys()) await this.cancelPermission(requestId);
    this.#contentController.close();
    this.#connection.onSessionDisposed(this.#id);
  }

  handleClosed(error: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const requestId of this.#permissionRequests.keys()) void this.cancelPermission(requestId);
    this.#contentController.enqueue({ type: 'agent_error', message: String(error) });
    this.#contentController.close();
  }
}

/** Translate ACP session updates to our SessionEvent vocabulary. */
function translateSessionUpdate(params: acp.SessionNotification): SessionEvent | null {
  const update = params.update as Record<string, unknown>;

  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const chunk = update as acp.ContentChunk;
      if (chunk.content?.type === 'text') {
        return { type: 'message_delta', text: chunk.content.text };
      }
      return { type: 'raw', raw: params };
    }
    case 'agent_thought_chunk': {
      const chunk = update as acp.ContentChunk;
      if (chunk.content?.type === 'text') {
        return { type: 'thought_delta', text: chunk.content.text };
      }
      return { type: 'raw', raw: params };
    }
    case 'tool_call': {
      const tc = update as acp.ToolCall;
      return {
        type: 'tool_call',
        toolCall: {
          toolCallId: tc.toolCallId,
          status: tc.status,
          title: tc.title,
          kind: tc.kind,
          name: tc.name ?? undefined,
        },
        raw: params,
      };
    }
    case 'tool_call_update': {
      const tc = update as acp.ToolCallUpdate;
      return {
        type: 'tool_call_update',
        toolCall: {
          toolCallId: tc.toolCallId,
          status: tc.status ?? undefined,
          title: tc.title ?? undefined,
          kind: tc.kind ?? undefined,
        },
        raw: params,
      };
    }
    case 'plan': {
      const plan = update as acp.Plan;
      return {
        type: 'plan',
        plan: {
          entries: (plan.entries ?? []).map((e) => ({ status: e.status, content: e.content })),
        },
      };
    }
    case 'usage_update': {
      const usage = update as acp.UsageUpdate;
      return { type: 'usage', usage: usage as unknown as Record<string, unknown> };
    }
    case 'session_info_update': {
      return { type: 'session_info', raw: params };
    }
    case 'current_mode_update': {
      return { type: 'mode_update', raw: params };
    }
    default:
      return { type: 'raw', raw: params };
  }
}

/** Create a ready-made AgentAdapter backed by an ACP-speaking subprocess. */
export function createAcpAgentAdapter(
  agentId: AgentId,
  launch: AgentLaunchSpec,
  options?: AdapterOptions,
): AgentAdapter {
  let connection: AcpAgentConnection | undefined;

  return {
    agentId,

    async connect(): Promise<AgentCapabilities> {
      connection ??= new AcpAgentConnection(launch, options);
      return connection.connect();
    },

    async createSession(opts: CreateSessionOptions): Promise<AgentSession> {
      if (!connection) {
        connection = new AcpAgentConnection(launch, options);
        await connection.connect();
      }
      return connection.createSession(opts);
    },

    async authenticate(methodId: string): Promise<void> {
      if (!connection?.rawConnection) throw new Error('Not connected');
      await connection.rawConnection.authenticate({ methodId });
    },

    async dispose(): Promise<void> {
      await connection?.dispose();
      connection = undefined;
    },
  };
}
