/**
 * Core types for the DSH ACP Hub plugin.
 */

/** Supported agent identifiers. */
export type AgentId = 'claude-code' | 'codex' | 'pi' | 'oh-my-pi' | 'deepseek';

/** How to launch an agent subprocess speaking ACP over stdio. */
export interface AgentLaunchSpec {
  command: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
}

/** Per-agent adapter options. */
export interface AdapterOptions {
  clientInfo?: { name: string; version: string };
  initializeTimeoutMs?: number;
  killGraceMs?: number;
  logger?: (level: 'debug' | 'info' | 'warn' | 'error', message: string, extra?: unknown) => void;
}

/** Options for creating a session. */
export interface CreateSessionOptions {
  cwd: string;
  mcpServers?: unknown[];
  resumeSessionId?: string;
  meta?: Record<string, unknown>;
}

/** Options for sending a prompt. */
export interface PromptOptions {
  signal?: AbortSignal;
  meta?: Record<string, unknown>;
}

/** Session event types streamed from the agent. */
export type SessionEventType =
  | 'user_message'
  | 'turn_end'
  | 'permission_resolved'
  | 'message_delta'
  | 'thought_delta'
  | 'tool_call'
  | 'tool_call_update'
  | 'plan'
  | 'usage'
  | 'permission_request'
  | 'agent_error'
  | 'session_info'
  | 'mode_update'
  | 'raw';

/** One event in the agent's event stream. */
export interface SessionEvent {
  type: SessionEventType;
  text?: string;
  toolCall?: {
    toolCallId: string;
    status?: string;
    title?: string;
    kind?: string;
    name?: string;
  };
  plan?: {
    entries: { status: string; content: string }[];
  };
  usage?: Record<string, unknown>;
  options?: { optionId: string; kind: string; name?: string }[];
  requestId?: string;
  message?: string;
  raw?: unknown;
  stopReason?: string;
}

/** Result of a completed turn. */
export interface TurnResult {
  stopReason: string;
  usage?: Record<string, unknown>;
}

/** Unified agent session handle. */
export interface AgentSession {
  readonly id: string;
  readonly aliases?: ReadonlySet<string>;
  onAlias?: (alias: string) => void;
  readonly raw: unknown;
  readonly events: AsyncIterable<SessionEvent>;
  prompt(input: string, options?: PromptOptions): Promise<TurnResult>;
  interrupt(): Promise<void>;
  respondPermission(requestId: string, optionId: string): Promise<void>;
  cancelPermission(requestId: string): Promise<void>;
  setMode?(modeId: string): Promise<void>;
  setConfigOption?(params: unknown): Promise<unknown>;
  dispose(): Promise<void>;
}

/** Capabilities returned by the agent after initialize. */
export interface AgentCapabilities {
  raw: unknown;
  protocolVersion: number;
  authMethods: { id: string }[];
  supportsLoad: boolean;
}

/** Unified adapter surface every agent package exposes. */
export interface AgentAdapter {
  readonly agentId: AgentId;
  connect(): Promise<AgentCapabilities>;
  createSession(options: CreateSessionOptions): Promise<AgentSession>;
  authenticate?(methodId: string): Promise<void>;
  listSessions?(options?: { cwd?: string }): Promise<{ sessionId: string; cwd?: string; title?: string; updatedAt?: string }[]>;
  dispose(): Promise<void>;
}

/** Plugin configuration. */
export interface AcpHubConfig {
  storageDir?: string;
  initializeTimeoutMs?: number;
  killGraceMs?: number;
  autoAllowPermissions?: boolean;
  agents?: Partial<Record<AgentId, {
    command?: string;
    args?: string[];
    env?: Record<string, string | undefined>;
    provider?: string;
    model?: string;
  }>>;
}

/** Runtime session metadata exposed by the web workbench. */
export interface AcpWebSession {
  id: string;
  agent: AgentId;
  cwd: string;
  connected: boolean;
  createdAt: string;
  provider?: string;
  model?: string;
}
