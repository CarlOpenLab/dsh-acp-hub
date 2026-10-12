# dsh-acp-hub — 架构文档

## 概述

`dsh-acp-hub` 是一个 DSH 插件，将 DSH 转变为 **ACP 客户端**，使其能够通过 [Agent Client Protocol](https://agentclientprotocol.com) 向多个编码 agent 派发任务。

## DSH Web 原生接入

当前实现新增 `src/hub.ts` 管理独立 ACP 进程、持久会话、连接配置和权限请求。
`src/web.ts` 在 `/acp-hub/api` 提供接口，调用 dsh connection 的认证与来源检查。
`src/native.ts` 注册 LLM adapter，将本机代理和保存的服务商连接加入 dsh 原生模型目录。
`src/client.js` 通过 dsh client module loader 扩展原生模型选择插槽，提供
Agent → 服务商 / 连接 → 模型选择，并在设置中注册 ACP 连接管理页面。
会话列表、聊天区、输入框和停止操作使用 dsh 原生组件。

连接配置和完整事件历史保存在 `storages/acp-hub/workbench.json`，文件权限为 0600。
连接拥有独立环境：Codex 自定义服务商通过 `CODEX_CONFIG` / `MODEL_PROVIDER` 配置；
Claude Code 使用 Anthropic 环境变量。模型、模式和推理设置优先使用会话返回的 ACP
`configOptions`，不存在的设置不会作为已支持能力展示。

每个原生会话和连接映射到独立 ACP 会话，后续只发送新增用户消息，外部代理负责上下文管理。
`src/native-tools.ts` 将外部工具执行映射到原生 `tool/call` 和 `tool/result` 事件，
复用工具卡片、diff、权限关联及历史回放。工具事件不会作为模型流工具调用返回，
因此不触发 dsh 工具执行器重复执行。权限请求通过 dsh approval service 处理。

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                          DSH                                 │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │           dsh-acp-hub 插件                           │    │
│  │                                                     │    │
│  │  工具：acp_agents / acp_call / acp_connect          │    │
│  │                                                     │    │
│  │  ┌─────────────────────────────────────────────┐    │    │
│  │  │  AgentFactory (factory.ts)                   │    │    │
│  │  │  创建和管理 agent adapter 实例                │    │    │
│  │  └──────────────────┬──────────────────────────┘    │    │
│  │                     │                               │    │
│  │  ┌──────────────────▼──────────────────────────┐    │    │
│  │  │  AcpAgentConnection (adapter.ts)             │    │    │
│  │  │  管理子进程 + ACP 连接                       │    │    │
│  │  │  · spawn agent 子进程                        │    │    │
│  │  │  · ndJsonStream (stdio JSON-RPC)            │    │    │
│  │  │  · initialize 握手                           │    │    │
│  │  │  · session/new, session/prompt               │    │    │
│  │  │  · session/cancel, session/list              │    │    │
│  │  └──────────────────┬──────────────────────────┘    │    │
│  │                     │                               │    │
│  │  ┌──────────────────▼──────────────────────────┐    │    │
│  │  │  AcpSession (adapter.ts)                     │    │    │
│  │  │  单个会话，事件流，权限处理                    │    │    │
│  │  └──────────────────────────────────────────────┘    │    │
│  └─────────────────────────────────────────────────────┘    │
│                          │                                  │
└──────────────────────────┼──────────────────────────────────┘
                           │
            ┌──────────────┼──────────────┐
            │              │              │
     ┌──────▼─────┐ ┌─────▼──────┐ ┌────▼───────┐
     │ claude-acp │ │ codex-acp  │ │ pi --mode  │
     │ (npx)      │ │ (npx)      │ │ acp        │
     └────────────┘ └────────────┘ └────────────┘
     ACP Server     ACP Server     ACP Server
```

## 与 DSH 基座的关系

DSH 本身已经内置了 **ACP Server**（`@deepseek-ai/dsh-acp`），通过 `dsh --profile acp` 启动。这让 DSH agent 能被外部 ACP 客户端调用。

```
外部 ACP 客户端 ──ACP──→ DSH (内置 ACP Server)
                          │
                          │ dsh-acp-hub 插件新增：
                          │
    DSH Agent ──ACP──→ 外部 agent (Claude/Codex/pi/omp)
```

本插件补全了 **Client 侧**，使 DSH 能反向调用其他 agent。

## 数据流

```
1. DSH Agent 调用 acp_call 工具
2. 插件查找/创建对应 agent 的 adapter
3. adapter.connect() → spawn 子进程 → initialize 握手
4. adapter.createSession(cwd) → session/new
5. session.prompt(text) → session/prompt
6. 事件流通过 session/update 异步返回
7. 工具返回聚合结果给 DSH Agent
8. session.dispose() → session/close
```

## 事件翻译

ACP `session/update` 通知被翻译为统一的 `SessionEvent`：

| ACP 更新 | SessionEvent 类型 |
|---|---|
| `content.text` | `message_delta` |
| `content.thinking` | `thought_delta` |
| `tool_call` | `tool_call` |
| `tool_call_update` | `tool_call_update` |
| `plan` | `plan` |
| `usage` | `usage` |
| `permission_request` | `permission_request` |

## 扩展新 agent

1. 在 `factory.ts` 的 `DEFAULT_LAUNCH_SPECS` 添加启动配置
2. 在 `types.ts` 的 `AgentId` 联合类型添加标识符
3. 无需修改插件入口——工具自动覆盖
