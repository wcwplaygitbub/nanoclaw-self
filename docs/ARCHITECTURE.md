# NanoClaw 架构分析文档

> 版本: 1.2.1 | 分析日期: 2026-03-03

## 1. 项目概述

NanoClaw 是一个个人 Claude 助手系统。它通过多种即时通讯渠道（WhatsApp、Telegram、Slack、Discord、Gmail）接收用户消息，将消息路由到运行在 Docker 容器中的 Claude Agent SDK，然后将 AI 回复发送回用户。

**一句话总结：** 一个单进程 Node.js 消息路由器 + 多容器 AI Agent 运行时。

```
用户 ──→ 渠道(WhatsApp/Telegram/...) ──→ 宿主机进程(轮询+路由)
                                              │
                                              ↓
                                        Docker 容器(Claude Agent SDK)
                                              │
                                              ↓
                                        宿主机进程 ──→ 渠道 ──→ 用户
```

## 2. 技术栈

| 层级 | 技术 |
|------|------|
| 运行时 | Node.js >= 20 (TypeScript, ESM) |
| 数据库 | SQLite (better-sqlite3) |
| 容器 | Docker (可切换为 Apple Container) |
| AI SDK | @anthropic-ai/claude-agent-sdk ^0.2.34 |
| MCP | @modelcontextprotocol/sdk |
| 日志 | pino + pino-pretty |
| 验证 | zod |
| 定时任务 | cron-parser |
| 测试 | vitest |

**核心依赖仅 6 个**（better-sqlite3, cron-parser, pino, pino-pretty, yaml, zod），非常轻量。

## 3. 项目结构

```
nanoclaw/
├── src/                        # 宿主机进程源码
│   ├── index.ts                # 主入口：状态管理、消息循环、Agent 调用
│   ├── config.ts               # 配置常量（从 .env 读取）
│   ├── db.ts                   # SQLite 数据库操作
│   ├── router.ts               # 消息格式化与出站路由
│   ├── container-runner.ts     # 容器生命周期管理
│   ├── container-runtime.ts    # 容器运行时抽象层 (Docker/Apple Container)
│   ├── group-queue.ts          # 群组级并发队列
│   ├── task-scheduler.ts       # 定时任务调度器
│   ├── ipc.ts                  # IPC 文件监听器
│   ├── mount-security.ts       # 挂载安全验证
│   ├── group-folder.ts         # 群组文件夹路径安全解析
│   ├── env.ts                  # .env 文件解析（不污染 process.env）
│   ├── logger.ts               # pino 日志封装
│   ├── types.ts                # 类型定义
│   └── channels/
│       ├── registry.ts         # 渠道注册表（工厂模式）
│       └── index.ts            # 渠道自注册入口（barrel file）
├── container/
│   ├── Dockerfile              # Agent 容器镜像定义
│   ├── build.sh                # 容器构建脚本
│   ├── agent-runner/
│   │   ├── src/
│   │   │   ├── index.ts        # 容器内主进程（调用 Claude Agent SDK）
│   │   │   └── ipc-mcp-stdio.ts # MCP Server（提供自定义工具给 Agent）
│   │   └── package.json        # 容器内依赖
│   └── skills/                 # 容器内可用的 Skills
├── groups/                     # 群组工作目录（每个群组隔离）
│   ├── main/                   # 主控群组
│   └── {group-name}/           # 其他群组
├── store/                      # SQLite 数据库文件
├── data/                       # 运行时数据
│   ├── sessions/               # 每群组的 Claude 会话和设置
│   └── ipc/                    # IPC 文件（每群组命名空间）
└── .claude/skills/             # 可安装的渠道和功能 Skills
```

## 4. 核心模块详解

### 4.1 主进程 (src/index.ts)

主进程是一个 **轮询式消息循环**，每 2 秒检查一次新消息：

```
main()
  ├── ensureContainerSystemRunning()   # 确认 Docker 可用，清理孤儿容器
  ├── initDatabase()                   # 初始化 SQLite
  ├── loadState()                      # 从 DB 恢复游标、会话、群组
  ├── 连接所有渠道                      # 遍历注册的 ChannelFactory
  ├── startSchedulerLoop()             # 启动定时任务调度
  ├── startIpcWatcher()                # 启动 IPC 文件监听
  ├── recoverPendingMessages()         # 崩溃恢复：检查未处理的消息
  └── startMessageLoop()              # 主消息循环（无限循环，2s 间隔）
```

**状态管理：**
- `lastTimestamp` — 全局消息游标（已扫描到的最新时间戳）
- `lastAgentTimestamp` — 每群组的 Agent 已处理游标
- `sessions` — 每群组的 Claude 会话 ID
- `registeredGroups` — 已注册群组映射 (JID → RegisteredGroup)

### 4.2 渠道系统 (src/channels/)

采用 **自注册工厂模式**：

```typescript
// registry.ts — 注册表核心
const registry = new Map<string, ChannelFactory>();
export function registerChannel(name: string, factory: ChannelFactory): void;
export function getChannelFactory(name: string): ChannelFactory | undefined;

// 渠道实现（由 Skills 安装，导入时自动注册）
// 例如 WhatsApp 渠道会在模块加载时调用:
// registerChannel('whatsapp', (opts) => new WhatsAppChannel(opts));
```

`Channel` 接口：

```typescript
interface Channel {
  name: string;
  connect(): Promise<void>;
  sendMessage(jid: string, text: string): Promise<void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;       // 判断 JID 属于哪个渠道
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  syncGroups?(force: boolean): Promise<void>;
}
```

当前 `channels/index.ts` 是空的 barrel file — 渠道通过 Skills 系统（如 `/add-whatsapp`、`/add-telegram`）动态安装，安装时会在此文件中添加 import 语句。

### 4.3 消息流转详解

```
┌─────────────────────────────────────────────────────────────────────┐
│                        完整消息生命周期                              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  1. 渠道接收消息 → onMessage 回调 → storeMessage() 写入 SQLite     │
│                                                                     │
│  2. 消息循环 (2s) → getNewMessages() 查询新消息                     │
│       │                                                             │
│       ├─ 非主群组需要触发词 (@AssistantName) 才响应                  │
│       │                                                             │
│       ├─ 有活跃容器 → queue.sendMessage() → IPC 文件 → 容器         │
│       │                                                             │
│       └─ 无活跃容器 → queue.enqueueMessageCheck() → 新容器          │
│                                                                     │
│  3. processGroupMessages()                                          │
│       │                                                             │
│       ├─ 拉取自上次处理以来的所有消息                                │
│       ├─ formatMessages() → XML 格式化                              │
│       └─ runAgent() → runContainerAgent()                           │
│                                                                     │
│  4. 容器内 agent-runner                                             │
│       │                                                             │
│       ├─ stdin 读取配置 JSON（含 secrets）                           │
│       ├─ query() 调用 Claude Agent SDK                              │
│       ├─ SDK 执行工具（Bash, Read, Write, MCP tools...）            │
│       └─ 结果通过 stdout 哨兵标记输出                                │
│                                                                     │
│  5. 宿主机流式解析 stdout → onOutput 回调                           │
│       │                                                             │
│       ├─ 剥离 <internal> 标签                                       │
│       ├─ channel.sendMessage() 发送给用户                            │
│       └─ 更新 session ID 到 SQLite                                  │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

**消息格式化 (router.ts)：**

入站消息被格式化为 XML：
```xml
<messages>
<message sender="Alice" time="2026-03-03T10:00:00Z">Hello @Andy</message>
<message sender="Bob" time="2026-03-03T10:00:05Z">Can you help?</message>
</messages>
```

出站响应会剥离 `<internal>...</internal>` 标签（Agent 内部推理用）。

### 4.4 群组队列 (src/group-queue.ts)

`GroupQueue` 管理容器级别的并发控制：

- **最大并发容器数：** 可配置，默认 5
- **每群组串行：** 同一群组的消息串行处理，避免竞态
- **跨群组并行：** 不同群组的容器并行运行
- **排队机制：** 超过并发限制时，新请求进入等待队列
- **重试策略：** 指数退避重试，最多 5 次（5s → 10s → 20s → 40s → 80s）
- **容器复用：** 活跃容器可通过 IPC 接收后续消息，无需重启
- **空闲管理：** 容器完成工作后进入空闲等待，30 分钟无活动后关闭
- **任务抢占：** 空闲容器在有待处理任务时会被立即关闭以腾出资源
- **优雅关闭：** shutdown 时不杀容器，让它们自然超时退出

### 4.5 容器系统

#### 4.5.1 容器镜像 (container/Dockerfile)

基于 `node:22-slim`，安装了：
- Chromium + 字体（用于浏览器自动化）
- git, curl
- `@anthropic-ai/claude-code`（全局安装，SDK 的运行时依赖）
- `agent-browser`（浏览器自动化工具）

入口脚本：读取 stdin JSON → 重新编译 TypeScript → 运行 agent-runner

#### 4.5.2 容器运行器 (src/container-runner.ts)

负责容器的完整生命周期：

**卷挂载策略：**

| 挂载 | 容器路径 | 权限 | 条件 |
|------|---------|------|------|
| 群组目录 | `/workspace/group` | 读写 | 所有群组 |
| 项目根目录 | `/workspace/project` | 只读 | 仅主群组 |
| `.env` 遮蔽 | `/workspace/project/.env` → `/dev/null` | 只读 | 仅主群组 |
| 全局记忆目录 | `/workspace/global` | 只读 | 非主群组 |
| Claude 会话 | `/home/node/.claude` | 读写 | 所有群组 |
| IPC 目录 | `/workspace/ipc` | 读写 | 所有群组 |
| Agent Runner 源码 | `/app/src` | 读写 | 所有群组（每群组独立副本） |
| 额外挂载 | `/workspace/extra/*` | 视配置 | 经白名单验证 |

**密钥传递流程：**
```
.env 文件 → readSecrets() → 4个密钥 → stdin JSON → 容器
           CLAUDE_CODE_OAUTH_TOKEN
           ANTHROPIC_API_KEY
           ANTHROPIC_BASE_URL
           ANTHROPIC_AUTH_TOKEN
```
密钥永远不写入磁盘、不挂载为文件，用后立即从 input 对象中删除。

**输出解析：**
容器 stdout 中的结果被 `---NANOCLAW_OUTPUT_START---` / `---NANOCLAW_OUTPUT_END---` 哨兵标记包裹，宿主机流式解析这些标记来提取 JSON 结果。

#### 4.5.3 容器运行时抽象 (src/container-runtime.ts)

将 Docker 命令抽象为函数，便于切换到 Apple Container：

```typescript
export const CONTAINER_RUNTIME_BIN = 'docker';
export function readonlyMountArgs(hostPath, containerPath): string[];
export function stopContainer(name: string): string;
export function ensureContainerRuntimeRunning(): void;
export function cleanupOrphans(): void;
```

### 4.6 Agent Runner — 容器内进程

#### 4.6.1 Claude Agent SDK 调用 (container/agent-runner/src/index.ts)

核心调用方式 — `query()` 函数：

```typescript
for await (const message of query({
    prompt: stream,                              // AsyncIterable，非字符串
    options: {
      cwd: '/workspace/group',
      resume: sessionId,                         // 会话恢复
      systemPrompt: { preset: 'claude_code', append: globalClaudeMd },
      allowedTools: [
        'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch', 'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill', 'NotebookEdit',
        'mcp__nanoclaw__*'
      ],
      env: sdkEnv,                               // 仅 SDK 可见的密钥
      permissionMode: 'bypassPermissions',
      mcpServers: { nanoclaw: { ... } },
      hooks: {
        PreCompact: [/* 归档对话 */],
        PreToolUse: [/* Bash 命令清理密钥 */],
      },
    }
})) { /* 处理消息流 */ }
```

**关键设计 — MessageStream（流式输入）：**

```typescript
class MessageStream {
  push(text: string): void;   // 推入新消息
  end(): void;                // 结束流
  [Symbol.asyncIterator]();   // AsyncGenerator 实现
}
```

`query()` 接收 `AsyncIterable<SDKUserMessage>` 而非字符串，实现了：
- 初始消息推入后保持流不关闭
- IPC 轮询循环持续推入后续消息
- Agent Teams 子 Agent 可以运行到完成
- `_close` 哨兵文件触发流关闭

**查询循环模式：**
```
初始消息 → query() → 等待结果 → 等待 IPC → 新 query(resume) → ...
```
容器内不是单次调用，而是循环等待新消息并通过 `resume` 参数恢复会话。

#### 4.6.2 SDK 安全机制

| 机制 | 实现 |
|------|------|
| 密钥隔离 | `sdkEnv` 是 `process.env` 的副本 + 密钥，密钥不注入 `process.env` |
| Bash 清理 | PreToolUse Hook 在每条 Bash 命令前注入 `unset ANTHROPIC_API_KEY ...` |
| 文件删除 | stdin 临时文件 `/tmp/input.json` 读取后立即删除 |
| 非 root 运行 | 容器以 `node` 用户运行 |

#### 4.6.3 Hooks

**PreCompact Hook** — 在 SDK 压缩上下文前归档完整对话：
- 解析 JSONL 格式的对话记录
- 生成 Markdown 文件保存到 `/workspace/group/conversations/`

**PreToolUse Hook (Bash)** — 在每条 Bash 命令前注入 unset：
```bash
unset ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN 2>/dev/null; <原始命令>
```

### 4.7 MCP Server (container/agent-runner/src/ipc-mcp-stdio.ts)

通过 MCP 协议向 Agent 暴露自定义工具，所有操作通过 IPC 文件与宿主机通信：

| 工具 | 功能 | 权限 |
|------|------|------|
| `send_message` | 实时发送消息给用户 | 主群组可发任意群组，其他只能发自己 |
| `schedule_task` | 创建定时/周期任务 | 同上 |
| `list_tasks` | 列出所有定时任务 | 主群组看全部，其他只看自己 |
| `pause_task` | 暂停任务 | 同上 |
| `resume_task` | 恢复任务 | 同上 |
| `cancel_task` | 取消任务 | 同上 |
| `register_group` | 注册新群组 | 仅主群组 |

### 4.8 IPC 机制 (src/ipc.ts)

宿主机和容器通过 **文件系统 IPC** 通信，每个群组有独立命名空间：

```
data/ipc/{group-folder}/
├── messages/        # Agent → 宿主机：发送消息请求
├── tasks/           # Agent → 宿主机：任务管理请求
└── input/           # 宿主机 → Agent：后续消息
    ├── *.json       # 新消息文件
    └── _close       # 关闭哨兵
```

**通信方向：**
- **Agent → 宿主机：** MCP Server 写入 `messages/` 或 `tasks/` 目录，宿主机 IPC Watcher（1s 间隔）扫描并处理
- **宿主机 → Agent：** GroupQueue.sendMessage() 写入 `input/` 目录，容器内 IPC 轮询（500ms）读取
- **关闭信号：** 写入 `input/_close` 哨兵文件

**写入原子性：** 所有 IPC 文件先写 `.tmp` 后缀，再 `rename` 到最终路径，防止读取到半写的文件。

**权限控制：** IPC Watcher 会验证源群组身份，非主群组不能跨群组发送消息或管理任务。

### 4.9 定时任务调度 (src/task-scheduler.ts)

每 60 秒轮询一次 SQLite 中到期的任务：

**支持的调度类型：**
- `cron` — Cron 表达式（支持时区）
- `interval` — 固定间隔（毫秒）
- `once` — 一次性定时

**上下文模式：**
- `group` — 使用群组的现有会话上下文（包含历史对话）
- `isolated` — 全新会话（无历史上下文）

任务通过 `GroupQueue.enqueueTask()` 排队，与普通消息共享并发限制。完成后自动计算下一次运行时间。

### 4.10 数据库 (src/db.ts)

SQLite 数据库位于 `store/messages.db`，包含 7 张表：

| 表 | 用途 |
|----|------|
| `chats` | 聊天/群组元数据（JID、名称、渠道、最后活动时间） |
| `messages` | 消息内容（ID、发送者、内容、时间戳、是否机器人） |
| `scheduled_tasks` | 定时任务定义（调度规则、状态、下次运行时间） |
| `task_run_logs` | 任务执行日志（耗时、结果、错误） |
| `router_state` | 路由器状态 KV 存储（游标等） |
| `sessions` | Claude 会话 ID（group_folder → session_id） |
| `registered_groups` | 已注册群组配置 |

**数据库迁移：** 使用 `ALTER TABLE ... ADD COLUMN` 的 try-catch 模式做渐进式迁移，不使用版本号。还支持从旧版 JSON 文件格式迁移。

### 4.11 挂载安全 (src/mount-security.ts)

额外挂载通过外部白名单文件 `~/.config/nanoclaw/mount-allowlist.json` 控制：

**验证流程：**
1. 白名单文件不存在 → 拒绝所有额外挂载
2. 路径展开和符号链接解析（`realpathSync`）
3. 检查默认屏蔽模式（`.ssh`, `.gnupg`, `.aws`, `.kube`, `.env` 等 17 种）
4. 验证是否在允许的根目录下
5. 确定有效读写权限（非主群组可强制只读）

白名单文件存储在项目外部（`~/.config/`），容器内的 Agent 无法修改。

## 5. 安全架构

NanoClaw 的安全设计是**纵深防御**：

```
┌────────────────────────────────────────┐
│ 第1层：容器隔离                         │
│   Docker 容器 + 非 root 用户           │
├────────────────────────────────────────┤
│ 第2层：文件系统隔离                     │
│   每群组独立工作目录和 IPC 命名空间      │
├────────────────────────────────────────┤
│ 第3层：密钥保护                         │
│   stdin 传递 + process.env 隔离        │
│   + Bash Hook 清理 + .env 遮蔽         │
├────────────────────────────────────────┤
│ 第4层：挂载安全                         │
│   外部白名单 + 路径验证 + 屏蔽模式       │
├────────────────────────────────────────┤
│ 第5层：IPC 权限控制                     │
│   基于目录的身份验证                    │
│   非主群组不能跨群组操作               │
├────────────────────────────────────────┤
│ 第6层：群组文件夹名验证                  │
│   正则白名单 + 路径遍历防护             │
└────────────────────────────────────────┘
```

**主群组 vs 普通群组权限矩阵：**

| 能力 | 主群组 | 普通群组 |
|------|--------|---------|
| 跨群组发消息 | ✓ | ✗ |
| 跨群组创建任务 | ✓ | ✗ |
| 注册新群组 | ✓ | ✗ |
| 刷新群组元数据 | ✓ | ✗ |
| 读取项目源码 | ✓ (只读) | ✗ |
| 免触发词响应 | ✓ | 需配置 |
| 查看所有任务 | ✓ | 仅自己 |

## 6. 配置系统 (src/config.ts)

所有配置从 `.env` 文件和环境变量读取：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `ASSISTANT_NAME` | Andy | 助手名称（触发词 `@{name}`） |
| `POLL_INTERVAL` | 2000ms | 消息轮询间隔 |
| `SCHEDULER_POLL_INTERVAL` | 60000ms | 任务调度轮询间隔 |
| `CONTAINER_IMAGE` | nanoclaw-agent:latest | 容器镜像名 |
| `CONTAINER_TIMEOUT` | 1800000ms (30min) | 容器硬超时 |
| `IDLE_TIMEOUT` | 1800000ms (30min) | 容器空闲超时 |
| `MAX_CONCURRENT_CONTAINERS` | 5 | 最大并发容器数 |
| `CONTAINER_MAX_OUTPUT_SIZE` | 10MB | 容器输出截断限制 |
| `IPC_POLL_INTERVAL` | 1000ms | IPC 文件扫描间隔 |

**重要：** 密钥（`ANTHROPIC_API_KEY` 等）不通过 `config.ts` 加载，而是在 `container-runner.ts` 中按需读取，防止泄漏到子进程。

## 7. Skills 系统

Skills 是 NanoClaw 的扩展机制，位于 `.claude/skills/`：

- **渠道 Skills：** `/add-whatsapp`, `/add-telegram`, `/add-slack`, `/add-gmail` — 安装新的通讯渠道
- **功能 Skills：** `/customize`, `/debug`, `/setup` — 系统管理
- **容器 Skills：** `container/skills/` 下的 Skills 会被同步到每个群组的 `.claude/skills/`

渠道安装本质上是：
1. 将渠道代码文件写入 `src/channels/`
2. 在 `channels/index.ts` 中添加 import
3. 在 `.env` 中写入渠道凭证
4. 重新构建

## 8. 数据流总览

```
                ┌──────────────┐
                │   用户/群组    │
                └──────┬───────┘
                       │
          ┌────────────┼────────────┐
          │            │            │
    ┌─────▼─────┐┌────▼────┐┌─────▼─────┐
    │ WhatsApp  ││Telegram ││  Slack    │ ...
    └─────┬─────┘└────┬────┘└─────┬─────┘
          │            │            │
          └────────────┼────────────┘
                       │ onMessage()
                       ▼
              ┌────────────────┐
              │   SQLite DB    │ ← storeMessage()
              └────────┬───────┘
                       │ getNewMessages() (每2s)
                       ▼
              ┌────────────────┐
              │  GroupQueue    │ ← 并发控制 (max 5)
              └────────┬───────┘
                       │
           ┌───────────┼───────────┐
           │ 有活跃容器  │ 无活跃容器 │
           │           │           │
           ▼           ▼           │
    IPC 文件写入   启动新容器       │
    (input/*.json)     │           │
           │           ▼           │
           │   ┌──────────────┐   │
           └──→│ Docker 容器   │←──┘
               │              │
               │ agent-runner │
               │      │       │
               │      ▼       │
               │  query()     │ ← Claude Agent SDK
               │      │       │
               │      ▼       │
               │ MCP Server   │ ← send_message, schedule_task ...
               │      │       │
               └──────┼───────┘
                      │ stdout (哨兵标记)
                      ▼
              ┌────────────────┐
              │ 流式解析输出    │
              │ → 路由回渠道    │
              └────────────────┘
```

## 9. 关键设计决策

### 9.1 为什么用容器而不是直接运行 SDK？

- **安全隔离：** Agent 有完整的 Bash 和文件系统访问权限，容器防止逃逸
- **群组隔离：** 不同群组的 Agent 无法互相访问文件系统
- **密钥保护：** 多层机制防止 Agent 通过 Bash 泄漏 API 密钥
- **资源控制：** 容器超时、输出大小限制

### 9.2 为什么用文件系统 IPC 而不是 TCP/gRPC？

- **跨容器简单：** 只需要文件挂载，无需网络配置
- **原子性：** 先写 .tmp 再 rename 保证完整性
- **可审计：** 文件系统操作可以被日志记录和审查
- **无状态：** 容器重启不影响 IPC 机制

### 9.3 为什么用轮询而不是事件驱动？

- **鲁棒性：** 即使渠道断连再重连，轮询循环不会丢消息（消息在 SQLite 中）
- **崩溃恢复：** 重启后通过游标对比自动发现未处理的消息
- **简单可靠：** 避免了复杂的事件订阅和取消逻辑

### 9.4 为什么 .env 不加载到 process.env？

`env.ts` 的 `readEnvFile()` 显式不修改 `process.env`，只返回值给调用者。这样：
- 密钥不会通过 `process.env` 泄漏到任何子进程
- 每个调用点精确控制哪些密钥在哪里可见
- 容器内的 `sdkEnv` 也是独立副本，不污染 `process.env`

## 10. 开发和运维

```bash
# 开发
npm run dev              # tsx 热重载运行
npm run build            # 编译 TypeScript
npm run typecheck        # 类型检查
npm run test             # 运行 vitest 测试

# 容器
./container/build.sh     # 构建容器镜像

# 服务管理 (macOS)
launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# 服务管理 (Linux)
systemctl --user start nanoclaw
systemctl --user restart nanoclaw
```

**测试覆盖：** 项目有针对以下模块的测试：
- `db.test.ts` — 数据库操作
- `group-queue.test.ts` — 队列和并发逻辑
- `group-folder.test.ts` — 路径安全验证
- `container-runner.test.ts` — 容器管理
- `container-runtime.test.ts` — 运行时抽象
- `ipc-auth.test.ts` — IPC 权限控制
- `routing.test.ts` — 消息路由
- `formatting.test.ts` — 消息格式化
- `task-scheduler.test.ts` — 任务调度
- `channels/registry.test.ts` — 渠道注册
