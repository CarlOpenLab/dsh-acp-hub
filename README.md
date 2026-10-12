# dsh-acp-hub

DSH plugin: ACP client hub for dispatching tasks to multiple coding agents through the [Agent Client Protocol](https://agentclientprotocol.com).

## What it does

The plugin adds ACP agents to DSH Web's native model directory and conversation flow.
The existing DSH session list, chat renderer, composer, stop controls, history and
approval UI remain in use. Open the model button beside the composer and choose
`Agent -> 服务商 / 连接 -> 模型` to route the current native session to Codex,
Claude Code, pi, oh-my-pi or DeepSeek over ACP.

Connections are managed under `设置 -> ACP 代理`. A connection selects the ACP
agent and can store a provider name, endpoint, API key, default model, launch
command, arguments and environment. Each connection is exposed as a model
provider route such as `acp-hub/codex/<connection-id>`; local login/configuration
is available as `acp-hub/<agent>/local` without a saved connection.

ACP turns are persisted and restored by native DSH session id and provider. ACP
stream text, reasoning and plans are rendered in the native chat
transcript. Permission requests are sent through DSH's approval service, so the
native approval panel controls whether an ACP action is allowed or cancelled.
ACP tools now use DSH's native tool cards: calls show as running, then settle as
completed, failed or interrupted. Read paths, shell commands and file edits with
diffs map to the corresponding native cards when ACP supplies the required
fields; other tools use the native generic card. Arguments, outputs, diff
metadata and the original ACP updates are persisted in the native session log,
so cards replay after refresh. Permission requests reference the same native
tool-call identity. These are records of externally executed actions; the DSH
tool executor is never invoked by the bridge.

Native cards publish the output when the tool settles; the original intermediate
ACP updates are retained in result metadata. Input currently accepts text only.
DSH auxiliary title/compaction model calls are not available on ACP routes;
the external ACP agent manages and compacts its own model context.

### Using DSH Web

1. Build the plugin with `npm run build`, restart `dsh --profile web`, then refresh the page.
2. Open `设置 -> ACP 代理` to add a provider connection, or use the agent's local login.
3. Create a native DSH session in the desired workspace. Open the model button
   beside its composer and select the agent, its connection, then a model.
4. Use `读取代理模型` to query the models advertised by that ACP server.
5. Send messages and stop turns with the native composer. For interactive ACP
   approval, use a DSH permission preset with approval policy `ask`; policy
   `never` rejects permission requests. The DSH preset governs the approval
   bridge and does not replace the external agent's own sandbox configuration.

Codex custom endpoints must support the Responses API; Claude Code custom
endpoints must support the Anthropic API. Other agents use their own launch
environment for provider settings. After editing a connection, create a new
session to use the new process configuration.

Connection credentials and ACP session mappings are stored in
`$DSH_HOME/storages/acp-hub/workbench.json` (default `~/.dsh/storages/acp-hub`).
The file has owner-only permissions; saved API keys are omitted from Web API
responses. Native chat history remains in DSH's session log. ACP restoration
after a host restart requires the agent to support `session/load`.

## Installation

### As a DSH plugin

```bash
# In your DSH profile directory
cd ~/.dsh/profiles/<your-profile>
pnpm add @carlopenlab/dsh-acp-hub
```

Add the package to your profile's `dsh.profile.bundles` list in `package.json`,
then configure the installed row in `cordis.patch.yml`:

```yaml
- id: acp-hub
  name: "@carlopenlab/dsh-acp-hub"
  config:
    initializeTimeoutMs: 30000
    killGraceMs: 5000
    autoAllowPermissions: false
```

### As a library

```bash
pnpm add @carlopenlab/dsh-acp-hub
```

```typescript
import { createAgentAdapter } from '@carlopenlab/dsh-acp-hub';

const adapter = createAgentAdapter('claude-code');
await adapter.connect();
const session = await adapter.createSession({ cwd: '/path/to/project' });
const result = await session.prompt('Refactor this module');
console.log(result.stopReason);
await adapter.dispose();
```

## DSH Tools

Once installed, DSH agents gain three tools:

| Tool | Description |
|---|---|
| `acp_agents` | List all available agents and their connection status |
| `acp_connect` | Test the ACP connection to a specific agent |
| `acp_call` | Send a prompt to an agent and get the result |

### Example usage in DSH

```
# List available agents
acp_agents()

# Test connection
acp_connect(agent: "claude-code")

# Send a task
acp_call(agent: "codex", prompt: "Write a hello world in Rust", cwd: "/tmp/test")
```

## Supported Agents

| Agent | Launch | Requires |
|---|---|---|
| **Claude Code** | `npx @agentclientprotocol/claude-agent-acp` | Claude Code CLI + Anthropic auth |
| **Codex** | `npx @agentclientprotocol/codex-acp` | Codex CLI + OpenAI auth |
| **pi** | `pi --mode acp` | pi CLI installed |
| **oh-my-pi** | `omp acp` | omp v18+ installed |
| **DeepSeek** | `dsh --profile acp` | DSH installed |

## Configuration

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: acp-hub
  name: "@carlopenlab/dsh-acp-hub"
  config:
    # Agent initialize timeout (ms)
    initializeTimeoutMs: 30000
    # Process kill grace period (ms)
    killGraceMs: 5000
    # Auto-answer permission requests with first allow_once option
    autoAllowPermissions: false
    # Per-agent launch overrides
    agents:
      claude-code:
        command: "npx"
        args: ["-y", "@agentclientprotocol/claude-agent-acp"]
      codex:
        command: "npx"
        args: ["-y", "@agentclientprotocol/codex-acp"]
```

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                      DSH                             │
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │         dsh-acp-hub plugin                   │    │
│  │                                             │    │
│  │  Tools: acp_agents / acp_call / acp_connect │    │
│  │                                             │    │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐       │    │
│  │  │claude   │ │codex    │ │pi       │ ...   │    │
│  │  │adapter  │ │adapter  │ │adapter  │       │    │
│  │  └────┬────┘ └────┬────┘ └────┬────┘       │    │
│  └───────┼───────────┼───────────┼─────────────┘    │
│          │           │           │                   │
└──────────┼───────────┼───────────┼───────────────────┘
           │           │           │
     ┌─────▼───┐ ┌─────▼───┐ ┌─────▼────┐
     │claude-  │ │codex-   │ │pi --mode│
     │acp      │ │acp      │ │acp      │
     │(npx)    │ │(npx)    │ │         │
     └─────────┘ └─────────┘ └──────────┘
     ACP Server  ACP Server  ACP Server
```

## API Reference

### Web API

All `/acp-hub/api` routes require the same browser cookie and trusted-origin
checks as DSH's stock API. Mutations also require `x-dsh-acp: 1`.

| Route | Purpose |
|---|---|
| `GET /state` | Agents, saved connections, session metadata (no API keys) |
| `POST /profiles`, `DELETE /profiles/:id` | Save/delete connections |
| `POST /test` | Initialize an agent and report capabilities |
| `POST /native/discover` | Read an ACP connection's model catalog for the native picker |
| `POST /sessions` | Create or restore a persistent ACP session |
| `GET /sessions/:id/events?after=0` | Cursor-based event tail and session state |
| `POST /sessions/:id/prompt` | Start a turn directly on the ACP agent |
| `POST /sessions/:id/interrupt` | Cancel the running turn |
| `POST /sessions/:id/permission` | Select or cancel a permission request |
| `POST /sessions/:id/config`, `POST /sessions/:id/mode` | Apply advertised session settings |
| `DELETE /sessions/:id` | Disconnect while retaining history |
| `DELETE /sessions/:id/history` | Disconnect and delete local history |

### `createAgentAdapter(agentId, config?)`

Create an agent adapter for the given agent.

```typescript
function createAgentAdapter(
  agentId: AgentId,
  config?: AcpHubConfig,
): AgentAdapter
```

### `AgentAdapter`

```typescript
interface AgentAdapter {
  readonly agentId: AgentId;
  connect(): Promise<AgentCapabilities>;
  createSession(options: CreateSessionOptions): Promise<AgentSession>;
  authenticate?(methodId: string): Promise<void>;
  listSessions?(options?: { cwd?: string }): Promise<AgentSessionSummary[]>;
  dispose(): Promise<void>;
}
```

### `AgentSession`

```typescript
interface AgentSession {
  readonly id: string;
  readonly events: AsyncIterable<SessionEvent>;
  prompt(input: string, options?: PromptOptions): Promise<TurnResult>;
  interrupt(): Promise<void>;
  respondPermission(requestId: string, optionId: string): Promise<void>;
  dispose(): Promise<void>;
}
```

## License

MIT
