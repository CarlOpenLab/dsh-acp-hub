/**
 * Agent factory — creates ACP adapters for each supported coding agent.
 */
import type { AcpHubConfig, AgentAdapter, AgentId, AgentLaunchSpec, AdapterOptions } from './types.js';
import { createAcpAgentAdapter } from './adapter.js';

/** Default launch specs for each supported agent. */
const DEFAULT_LAUNCH_SPECS: Record<AgentId, { command: string; args: string[] }> = {
  'claude-code': {
    command: 'npx',
    args: ['-y', '@agentclientprotocol/claude-agent-acp'],
  },
  codex: {
    command: 'npx',
    args: ['-y', '@agentclientprotocol/codex-acp'],
  },
  pi: {
    command: 'pi',
    args: ['--mode', 'acp'],
  },
  'oh-my-pi': {
    command: 'omp',
    args: ['acp'],
  },
  deepseek: {
    command: 'dsh',
    args: ['--profile', 'acp'],
  },
};

/** All supported agent ids. */
export const AGENT_IDS: readonly AgentId[] = [
  'claude-code',
  'codex',
  'pi',
  'oh-my-pi',
  'deepseek',
];

/** Create an agent adapter with the given config. */
export function createAgentAdapter(
  agentId: AgentId,
  config: AcpHubConfig = {},
): AgentAdapter {
  const defaults = DEFAULT_LAUNCH_SPECS[agentId];
  const overrides = config.agents?.[agentId];

  const launch: AgentLaunchSpec = {
    command: overrides?.command ?? defaults.command,
    args: overrides?.args ?? [...defaults.args],
    ...(overrides?.env !== undefined ? { env: overrides.env } : {}),
  };

  const adapterOptions: AdapterOptions = {
    initializeTimeoutMs: config.initializeTimeoutMs,
    killGraceMs: config.killGraceMs,
    clientInfo: { name: 'dsh-acp-hub', version: '0.1.0' },
  };

  return createAcpAgentAdapter(agentId, launch, adapterOptions);
}

/** Get the default launch spec for an agent (for display/debugging). */
export function getDefaultLaunchSpec(agentId: AgentId): { command: string; args: string[] } {
  return DEFAULT_LAUNCH_SPECS[agentId];
}

/** Check if an agent id is supported. */
export function isSupportedAgent(id: string): id is AgentId {
  return (AGENT_IDS as readonly string[]).includes(id);
}
