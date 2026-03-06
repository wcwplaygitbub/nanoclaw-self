# Token 级流式结果输出方案

> 目标：用户在渠道（飞书、Telegram、Slack 等）中看到 AI 回复像打字机一样逐步输出，而不是等半天一次性出现。
> 只流式输出**结果文本**，工具调用/思考过程对用户不可见（保持"思考中"提示）。

## 渠道能力调研

| 渠道 | 平台 API 支持编辑已发消息 | 当前已实现 | 可用 API |
|------|------------------------|-----------|---------|
| Feishu | Yes | 部分（typing→patch） | `client.im.message.patch()` |
| Telegram | Yes | No | `bot.api.editMessageText()` |
| Slack | Yes | No | `app.client.chat.update()` |
| Discord | Yes | No | `message.edit()` |
| WhatsApp | 有限（baileys 协议层可编辑） | No | `editedMessage` proto |
| Gmail | **No**（邮件不可编辑） | No | N/A |

**策略**：支持编辑的渠道开启流式输出，不支持的渠道保持原有行为（一次性发送完整消息）。

---

## 改动总览

```
container/agent-runner/src/index.ts   ← 开启 includePartialMessages，产出 delta
src/container-runner.ts               ← 解析新的 delta 输出标记
src/types.ts                          ← Channel 接口新增 editMessage / sendMessage 返回 msgId
src/index.ts                          ← onOutput 回调支持 delta 累积 + 编辑消息
src/channels/feishu.ts                ← 实现 editMessage
src/channels/ 其他渠道 skill 模板      ← 支持编辑的渠道实现 editMessage
src/router.ts                         ← 不需要改（编辑逻辑在 index.ts 的回调里）
```

---

## 详细步骤

### Step 1：扩展 Channel 接口和 ContainerOutput 类型

**文件：`src/types.ts`**

```typescript
export interface Channel {
  name: string;
  connect(): Promise<void>;
  // 改动：返回平台消息 ID（用于后续编辑）
  sendMessage(jid: string, text: string): Promise<string | void>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  syncGroups?(force: boolean): Promise<void>;
  // 新增：编辑已发送的消息（可选，不实现则降级为非流式）
  editMessage?(jid: string, messageId: string, text: string): Promise<void>;
}
```

**文件：`src/container-runner.ts`**

ContainerOutput 新增 delta 类型：

```typescript
export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
  // 新增
  delta?: string;        // token 级增量文本
  deltaType?: 'text_start' | 'text_delta' | 'text_done';
}
```

---

### Step 2：容器内 agent-runner 开启流式事件

**文件：`container/agent-runner/src/index.ts`**

2.1 在 `query()` 的 options 中新增：

```typescript
for await (const message of query({
  prompt: stream,
  options: {
    includePartialMessages: true,  // ← 新增：开启 token 级 StreamEvent
    // ...其他选项不变
  }
})) {
```

2.2 在 for-await 循环中新增 StreamEvent 处理：

```typescript
// 状态追踪
let inToolMode = false;
let isStreamingText = false;

// 在 for-await 循环内新增:
if (message.type === 'stream_event') {
  const event = (message as any).event;

  // 工具调用开始 → 进入静默模式
  if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
    inToolMode = true;
  }

  // 文本块开始 → 发 text_start
  if (event.type === 'content_block_start' && event.content_block?.type === 'text' && !inToolMode) {
    isStreamingText = true;
    writeOutput({ status: 'success', result: null, delta: '', deltaType: 'text_start' });
  }

  // token 增量 → 只转发文本 delta，忽略工具参数
  if (event.type === 'content_block_delta'
      && event.delta?.type === 'text_delta'
      && !inToolMode
      && isStreamingText) {
    writeOutput({ status: 'success', result: null, delta: event.delta.text, deltaType: 'text_delta' });
  }

  // 块结束
  if (event.type === 'content_block_stop') {
    if (isStreamingText && !inToolMode) {
      writeOutput({ status: 'success', result: null, delta: '', deltaType: 'text_done' });
      isStreamingText = false;
    }
    inToolMode = false;
  }
}
```

2.3 保留现有 `result` 处理逻辑不变（作为最终确认）。

**注意**：delta 输出通过与现有结果相同的哨兵标记（`OUTPUT_START_MARKER` / `OUTPUT_END_MARKER`）包裹，
宿主机 container-runner 的流式解析器已经能处理多个标记对，无需修改解析逻辑。

---

### Step 3：宿主机 container-runner 适配

**文件：`src/container-runner.ts`**

container-runner 的 stdout 流式解析器（`container.stdout.on('data', ...)`）已经能解析多个哨兵对。
只需确保 `ContainerOutput` 类型包含 `delta`/`deltaType` 字段（Step 1 已完成），解析后的对象会原样传给 `onOutput` 回调。

实际上这一步**不需要改代码**，只需要 Step 1 中的类型定义更新。

---

### Step 4：宿主机 index.ts 消费 delta 事件

**文件：`src/index.ts`**

在 `processGroupMessages()` 的 `onOutput` 回调中，新增 delta 累积和编辑消息逻辑：

```typescript
// 新增状态变量
let streamingMsgId: string | null = null;   // 当前正在编辑的消息 ID
let accumulatedText = '';                    // 累积的流式文本
const supportsEdit = typeof channel.editMessage === 'function';

// 控制编辑频率，避免 API 限流（飞书/Telegram 都有频率限制）
let lastEditTime = 0;
const EDIT_INTERVAL_MS = 300;  // 每 300ms 最多编辑一次
let pendingEditTimer: ReturnType<typeof setTimeout> | null = null;

const flushEdit = async () => {
  if (streamingMsgId && accumulatedText) {
    await channel.editMessage!(chatJid, streamingMsgId, accumulatedText);
    lastEditTime = Date.now();
  }
};

const output = await runAgent(group, prompt, chatJid, async (result) => {
  // ── 新增：处理 delta 事件 ──
  if (result.deltaType && supportsEdit) {
    if (result.deltaType === 'text_start') {
      // 新文本块开始：清除 typing 指示器，发送初始空/占位消息
      await channel.setTyping?.(chatJid, false);
      accumulatedText = '';
      // 发一条初始消息，拿到消息 ID
      streamingMsgId = (await channel.sendMessage(chatJid, '▍')) || null;
    }

    if (result.deltaType === 'text_delta' && result.delta) {
      accumulatedText += result.delta;
      // 节流：间隔 >= EDIT_INTERVAL_MS 才实际调 editMessage
      const now = Date.now();
      if (now - lastEditTime >= EDIT_INTERVAL_MS) {
        if (pendingEditTimer) clearTimeout(pendingEditTimer);
        await flushEdit();
      } else if (!pendingEditTimer) {
        pendingEditTimer = setTimeout(async () => {
          pendingEditTimer = null;
          await flushEdit();
        }, EDIT_INTERVAL_MS - (now - lastEditTime));
      }
    }

    if (result.deltaType === 'text_done') {
      // 文本块结束：最终刷新，确保完整内容
      if (pendingEditTimer) { clearTimeout(pendingEditTimer); pendingEditTimer = null; }
      await flushEdit();
      streamingMsgId = null;
      outputSentToUser = true;
    }

    resetIdleTimer();
    return;  // delta 事件已处理，不走下面的完整消息逻辑
  }

  // ── 原有逻辑：处理完整 result ──
  if (result.result) {
    const raw = typeof result.result === 'string' ? result.result : JSON.stringify(result.result);
    const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
    if (text) {
      // 如果已经通过流式发过了，跳过重复发送
      if (!outputSentToUser) {
        await channel.sendMessage(chatJid, text);
      }
      outputSentToUser = true;
    }
    resetIdleTimer();
  }
  // ...其余 status 处理不变
});
```

**兜底逻辑**：当 `supportsEdit` 为 false 时，delta 事件被忽略，
最终 `result` 消息仍然走原有 `sendMessage()` 路径，行为完全不变。

---

### Step 5：各渠道实现 editMessage

#### 5.1 Feishu（`src/channels/feishu.ts`）

飞书已有 `im.message.patch()` 能力，实现最简单：

```typescript
async editMessage(jid: string, messageId: string, text: string): Promise<void> {
  if (!this.client) return;
  try {
    const card = {
      schema: '2.0',
      body: { elements: [{ tag: 'markdown', content: text }] },
    };
    await this.client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card) },
    });
  } catch (err) {
    logger.debug({ jid, messageId, err }, 'Failed to edit Feishu message');
  }
}
```

同时修改 `sendMessage` 返回消息 ID：

```typescript
async sendMessage(jid: string, text: string): Promise<string | void> {
  // ...现有分片逻辑...
  const resp = await this.client.im.message.create({ ... });
  return resp?.data?.message_id;  // ← 返回 ID
}
```

#### 5.2 Telegram skill 模板（`.claude/skills/add-telegram/add/src/channels/telegram.ts`）

```typescript
async editMessage(jid: string, messageId: string, text: string): Promise<void> {
  const numericId = Number(jid.replace(/^tg:/, ''));
  try {
    await this.bot.api.editMessageText(numericId, Number(messageId), text);
  } catch (err) {
    logger.debug({ jid, messageId, err }, 'Failed to edit Telegram message');
  }
}
```

`sendMessage` 返回 `message_id`：

```typescript
async sendMessage(jid: string, text: string): Promise<string | void> {
  const resp = await this.bot.api.sendMessage(numericId, text);
  return String(resp.message_id);
}
```

#### 5.3 Slack skill 模板（`.claude/skills/add-slack/add/src/channels/slack.ts`）

```typescript
async editMessage(jid: string, messageId: string, text: string): Promise<void> {
  const channelId = jid.replace(/^slack:/, '');
  try {
    await this.app.client.chat.update({ channel: channelId, ts: messageId, text });
  } catch (err) {
    logger.debug({ jid, messageId, err }, 'Failed to edit Slack message');
  }
}
```

`sendMessage` 返回消息 `ts`：

```typescript
async sendMessage(jid: string, text: string): Promise<string | void> {
  const resp = await this.app.client.chat.postMessage({ channel: channelId, text });
  return resp.ts;
}
```

#### 5.4 Discord skill 模板（`.claude/skills/add-discord/add/src/channels/discord.ts`）

```typescript
async editMessage(jid: string, messageId: string, text: string): Promise<void> {
  const channelId = jid.replace(/^dc:/, '');
  try {
    const channel = await this.client.channels.fetch(channelId);
    if (channel?.isTextBased()) {
      const msg = await (channel as any).messages.fetch(messageId);
      await msg.edit(text);
    }
  } catch (err) {
    logger.debug({ jid, messageId, err }, 'Failed to edit Discord message');
  }
}
```

#### 5.5 WhatsApp / Gmail → 不实现 editMessage

这两个渠道不实现 `editMessage`，自动走兜底路径（完整消息一次性发送）。

---

### Step 6：避免重复发送

当 delta 流式已经把完整文本发给了用户，最终的 `result` 消息不应再次发送。

在 Step 4 中已通过 `outputSentToUser` 标记解决：
- delta 流完成时设 `outputSentToUser = true`
- 后续 `result` 回调检查此标记，为 true 则跳过 `sendMessage`

---

### Step 7：API 限流保护

各平台编辑消息都有频率限制：

| 平台 | 限制 | 建议编辑间隔 |
|------|------|------------|
| Feishu | ~50 req/s per app | 300ms |
| Telegram | ~30 msg/s per bot | 300ms |
| Slack | ~1 req/s per channel for updates | 1000ms |
| Discord | ~5 req/10s per channel | 2000ms |

在 Step 4 中已通过 `EDIT_INTERVAL_MS` 节流机制处理。
可考虑做成每个渠道可配的值（通过 Channel 接口暴露 `editThrottleMs?` 属性）。

---

### Step 8：重建容器

改动涉及容器内代码（`agent-runner`），需要重新构建：

```bash
./container/build.sh
```

---

## 兜底策略总结

```
channel.editMessage 存在？
  ├─ YES → 流式模式
  │   ├─ text_start  → 清 typing，sendMessage('▍')，拿 msgId
  │   ├─ text_delta  → 累积文本，节流 editMessage
  │   └─ text_done   → 最终 editMessage，标记 outputSentToUser
  │
  └─ NO → 原有模式（完全不变）
      └─ result → sendMessage(完整文本)
```

不支持编辑的渠道（WhatsApp、Gmail）：
- delta 事件被忽略（`supportsEdit === false` 直接 return）
- 用户看到的体验与当前完全一致：typing 指示 → 等待 → 完整消息

---

## 风险与注意事项

1. **SDK 版本要求**：`includePartialMessages` 需要 `@anthropic-ai/claude-agent-sdk >= 0.2.x` 确认支持（当前 `^0.2.34`）。如不支持需升级。
2. **Extended Thinking 不兼容**：SDK 文档指出开启 `max_thinking_tokens` 后不产出 `StreamEvent`，此时自动降级为非流式。
3. **飞书卡片编辑限制**：飞书只能编辑 `interactive`（卡片）类型消息，不能编辑纯文本消息。当前实现已使用卡片格式，兼容。
4. **消息长度**：流式累积的文本可能超出平台单消息限制（飞书 ~30000 字符、Telegram 4096 字符）。需在 editMessage 实现中处理截断或分片。
5. **`<internal>` 标签过滤**：agent 输出中可能包含 `<internal>` 标签。在 token 级别可能会出现跨 delta 的不完整标签。需要在 `text_done` 时对累积文本做一次 `stripInternalTags` 清理。
