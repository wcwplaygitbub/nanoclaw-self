---
name: add-feishu
description: Add Feishu (飞书/Lark) as a channel. Uses WebSocket long-connection mode — no public URL needed. Can run alongside other channels.
---

# Add Feishu Channel

This skill adds Feishu/Lark support to NanoClaw using the skills engine for deterministic code changes, then walks through interactive setup.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `feishu` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

Use `AskUserQuestion` to collect configuration:

AskUserQuestion: Do you have a Feishu self-built app with bot capability? Options: "Yes, I have App ID and App Secret" / "No, I need to create one"

If they already have credentials, collect the App ID and App Secret now.

AskUserQuestion: Are you using Feishu (China) or Lark (International)? Options: "Feishu (飞书, China)" / "Lark (International)"

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-feishu
```

This deterministically:

- Adds `src/channels/feishu.ts` (Feishu ChannelAdapter with WebSocket event handling and self-registration via `registerChannelAdapter`)
- Adds `src/channels/feishu.test.ts` (unit tests for v2 ChannelAdapter interface)
- Appends `import './feishu.js'` to the channel barrel file `src/channels/index.ts`
- Installs the `@larksuiteoapi/node-sdk` npm dependency
- Updates `.env.example` with `FEISHU_APP_ID` and `FEISHU_APP_SECRET`
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent file:
- `modify/src/channels/index.ts.intent.md` — what changed and invariants

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass and build must be clean before proceeding.

## Phase 3: Setup

### Create Feishu App (if needed)

If the user doesn't have an app, tell them:

> I need you to create a Feishu self-built app with bot capability:
>
> 1. Visit [Feishu Open Platform](https://open.feishu.cn/app) (or [Lark Developer](https://open.larksuite.com/app) for international)
> 2. Click **Create Custom App** (创建企业自建应用)
> 3. Fill in app name and description, then click **Create**
> 4. Go to **Add Capabilities** (添加应用能力) > select **Bot** (机器人) > **Add**
> 5. Go to **Credentials** (凭证与基础信息) and copy the **App ID** and **App Secret**
>
> Then configure permissions:
> 6. Go to **Permission Management** (权限管理)
> 7. Search and add these permissions:
>    - `im:message` — Send and receive messages
>    - `im:message:send_as_bot` — Send messages as bot
>    - `im:message.p2p_msg:readonly` — Receive DM messages
>    - `im:message.group_at_msg:readonly` — Receive group @bot messages
>    - `im:chat` — Access chat info
>    - `contact:user.base:readonly` — Get basic user info
>
> Then configure event subscription:
> 8. Go to **Events and Callbacks** (事件与回调) > **Event Configuration** (事件配置)
> 9. Select **Use long connection to receive events** (使用长连接接收事件) as the subscription method
> 10. Add event: `im.message.receive_v1` (Receive messages / 接收消息)
>
> Finally publish:
> 11. Go to **Version Management** (版本管理与发布) > Create a version > Submit and publish
> 12. Ask your organization admin to approve the app if needed

Wait for the user to provide the App ID and App Secret.

### Configure environment

Add to `.env`:

```bash
FEISHU_APP_ID=cli_xxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
# Optional: 'feishu' (default, China) or 'lark' (international)
FEISHU_DOMAIN=feishu
```

Channels auto-enable when their credentials are present — no extra configuration needed.

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Phase 4: Registration

### Get Chat ID

Tell the user:

> 1. Add the bot to a Feishu group (or start a DM with the bot)
> 2. Send any message — check the NanoClaw logs for the chat ID
> 3. The chat ID will appear in the log as `feishu:oc_xxxxxxxxxx`
>
> ```bash
> tail -f logs/nanoclaw.log | grep "Feishu"
> ```

Wait for the user to provide the chat ID (format: `feishu:oc_xxxxxxxxxx`).

### Register the chat

Use the IPC register flow or register directly. The chat ID, name, and folder name are needed.

For a main chat (responds to all messages):

```typescript
registerGroup("feishu:oc_xxxxxxxxxx", {
  name: "<chat-name>",
  folder: "feishu_main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
  isMain: true,
});
```

For additional chats (trigger-only):

```typescript
registerGroup("feishu:oc_xxxxxxxxxx", {
  name: "<chat-name>",
  folder: "feishu_<group-name>",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

### Test the connection

Tell the user:

> Send a message to your registered Feishu chat:
> - For main chat: Any message works
> - For non-main groups: @mention the bot in the group
>
> The bot should respond within a few seconds.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Bot not responding

Check:
1. `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are set in `.env` AND synced to `data/env/env`
2. The app has bot capability enabled and is published/approved
3. Event subscription is configured to use **long connection** mode with `im.message.receive_v1`
4. Chat is registered in SQLite: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'feishu:%'"`
5. For non-main chats: message includes trigger pattern (or bot is @mentioned)
6. Service is running: `launchctl list | grep nanoclaw` (macOS) or `systemctl --user status nanoclaw` (Linux)

### WebSocket connection fails

- Verify the App ID and App Secret are correct
- Check internet connectivity (WebSocket needs outbound HTTPS)
- Ensure the app is published and approved by your org admin
- Check if you exceeded the 50 WebSocket connection limit per app

### Bot only sees @mentions in groups

This is expected behavior unless you add the `im:message.group_msg` permission (allows reading all group messages). By default, the bot only receives messages where it is @mentioned in groups.

### Using Lark (International) instead of Feishu (China)

Set in `.env`:
```bash
FEISHU_DOMAIN=lark
```

## Removal

To remove Feishu integration:

1. Delete `src/channels/feishu.ts` and `src/channels/feishu.test.ts`
2. Remove `import './feishu.js'` from `src/channels/index.ts`
3. Remove `FEISHU_APP_ID`, `FEISHU_APP_SECRET`, `FEISHU_DOMAIN` from `.env`
4. Remove Feishu registrations from SQLite: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'feishu:%'"`
5. Uninstall: `npm uninstall @larksuiteoapi/node-sdk`
6. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `npm run build && systemctl --user restart nanoclaw` (Linux)
