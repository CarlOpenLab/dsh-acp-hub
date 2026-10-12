/**
 * DSH ACP Hub Plugin
 *
 * A DSH plugin that provides ACP client capabilities, allowing DSH agents
 * to dispatch tasks to multiple coding agents (Claude Code, Codex, pi,
 * oh-my-pi, DeepSeek) through the Agent Client Protocol.
 *
 * Usage in DSH:
 *   - `acp_agents` tool: list available agents and their status
 *   - `acp_call` tool: send a prompt to any ACP-compatible agent
 *   - `acp_connect` tool: test agent connection
 *
 * @module @carlopenlab/dsh-acp-hub
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import { AcpHub } from './hub.js';
import { mountWebApi } from './web.js';
import { installNative } from './native.js';
import type { AcpHubConfig } from './types.js';
import { AGENT_IDS, isSupportedAgent } from './factory.js';

// ── Plugin metadata ──

export const name = 'acp-hub';
export const inject = ['tools'];

// ── Plugin state ──

/** Render helper: wrap text in a ContentBlock array. */
function renderText(text: string): ContentBlock[] {
  return [{ type: 'text', text }];
}

// ── Plugin entry ──

export function apply(ctx: Context, config: AcpHubConfig = {}) {
  const hub = new AcpHub(config);
  ctx.effect(() => () => hub.dispose(), 'acp-hub: connections');
  ctx.inject(['llm', 'agents', 'approval'], async (nativeCtx) => {
    await hub.ready;
    const native = installNative(nativeCtx, hub);
    nativeCtx.inject(['webServer', 'connection'], (webCtx) => mountWebApi(webCtx, hub, native));
  });
  // ── Tool: acp_agents — list available agents ──

  ctx.tools.register(
    defineTool({
      name: 'acp_agents',
      description: 'List all ACP-compatible coding agents available through the hub, with their launch specs and connection status.',
      parameters: {},
      output: {
        schema: { type: 'json' as const },
        render: (_args: unknown, value: unknown) => {
          const v = value as { agents: { id: string; command: string; args: string[]; connected: boolean }[] };
          const lines = v.agents.map(
            (a) => `${a.id}: ${a.command} ${a.args.join(' ')} ${a.connected ? '✅' : '❌'}`,
          );
          return renderText(lines.join('\n'));
        },
      },
      async execute() {
        return { agents: hub.agents() };
      },
    }),
  );

  // ── Tool: acp_call — send a prompt to an agent ──

  ctx.tools.register(
    defineTool({
      name: 'acp_call',
      description: [
        'Send a prompt to a coding agent through ACP and get the result.',
        'Supported agents: claude-code, codex, pi, oh-my-pi, deepseek.',
        'The agent runs in a separate process with its own ACP connection.',
      ].join('\n'),
      parameters: {
        agent: { type: 'string', enum: [...AGENT_IDS], required: true, description: 'Which agent to use' },
        prompt: { type: 'string', required: true, description: 'The prompt to send' },
        cwd: { type: 'string', description: 'Working directory for the agent' },
      },
      output: {
        schema: { type: 'json' as const },
        render: (_args: unknown, value: unknown) => {
          const v = value as { agent: string; sessionId: string; stopReason: string; output: string };
          return renderText(`[${v.agent}] ${v.output}\n\n(stop: ${v.stopReason})`);
        },
      },
      async execute(args: { agent: string; prompt: string; cwd?: string }) {
        const agentId = args.agent;
        if (!isSupportedAgent(agentId)) {
          throw new Error(`Unknown agent: ${agentId}. Supported: ${AGENT_IDS.join(', ')}`);
        }

        const session = await hub.create({ agent: agentId, cwd: args.cwd ?? process.cwd() });
        try {
          let output = '';
          const turnResult = await hub.promptAndWait(session.id, args.prompt);
          for (const event of hub.events(session.id, 0).events) {
            if (event.type === 'message_delta') output += event.text ?? '';
            if (event.type === 'agent_error') output += `\n[error] ${event.message ?? ''}`;
          }

          return {
            agent: agentId,
            sessionId: session.id,
            stopReason: turnResult.stopReason,
            output,
          };
        } finally {
          await hub.close(session.id);
        }
      },
    }),
  );

  // ── Tool: acp_connect — test agent connection ──

  ctx.tools.register(
    defineTool({
      name: 'acp_connect',
      description: 'Test the ACP connection to a specific coding agent. Returns protocol version and capabilities.',
      parameters: {
        agent: { type: 'string', enum: [...AGENT_IDS], required: true, description: 'Which agent to connect to' },
      },
      output: {
        schema: { type: 'json' as const },
        render: (_args: unknown, value: unknown) => {
          const v = value as { agent: string; protocolVersion: number; authMethods: { id: string }[]; supportsLoad: boolean };
          return renderText(`[${v.agent}] protocol=${v.protocolVersion} load=${v.supportsLoad} auth=${v.authMethods.map((m) => m.id).join(',')}`);
        },
      },
      async execute(args: { agent: string }) {
        const agentId = args.agent;
        if (!isSupportedAgent(agentId)) {
          throw new Error(`Unknown agent: ${agentId}. Supported: ${AGENT_IDS.join(', ')}`);
        }

        const capabilities = await hub.test(agentId);
        return {
          agent: agentId,
          protocolVersion: capabilities.protocolVersion,
          authMethods: capabilities.authMethods,
          supportsLoad: capabilities.supportsLoad,
        };
      },
    }),
  );
}

// Re-exports for library consumers
export { AGENT_IDS, createAgentAdapter, getDefaultLaunchSpec, isSupportedAgent } from './factory.js';
export type { AcpHubConfig } from './types.js';
