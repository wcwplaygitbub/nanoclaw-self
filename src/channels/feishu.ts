import * as lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel } from '../types.js';

export interface FeishuChannelOpts {
  onMessage: ChannelOpts['onMessage'];
  onChatMetadata: ChannelOpts['onChatMetadata'];
  registeredGroups: ChannelOpts['registeredGroups'];
  registerGroup: ChannelOpts['registerGroup'];
}

export class FeishuChannel implements Channel {
  name = 'feishu';

  private client: lark.Client | null = null;
  private wsClient: lark.WSClient | null = null;
  private botOpenId = '';
  private connected = false;
  private opts: FeishuChannelOpts;
  private appId: string;
  private appSecret: string;
  private domain: string;
  private allowedUsers: Set<string>;
  /** Track processed event IDs to deduplicate retries (3-second timeout). */
  private processedEvents = new Set<string>();
  /** Track "thinking" placeholder message IDs per JID so we can delete them. */
  private typingMessageIds = new Map<string, string>();
  /** Track last inbound message ID per JID for reply-style typing indicator. */
  private lastInboundMessageId = new Map<string, string>();

  constructor(
    appId: string,
    appSecret: string,
    domain: string,
    opts: FeishuChannelOpts,
    allowedUsers: string[] = [],
  ) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.domain = domain;
    this.opts = opts;
    this.allowedUsers = new Set(allowedUsers);
  }

  async connect(): Promise<void> {
    // Create API client for sending messages
    this.client = new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      appType: lark.AppType.SelfBuild,
      domain: this.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
    });

    // Resolve bot identity so we can detect @bot mentions
    try {
      const resp = await (this.client as any).request({
        method: 'GET',
        url: 'https://open.feishu.cn/open-apis/bot/v3/info',
        data: {},
        params: {},
      });
      this.botOpenId = resp?.bot?.open_id || '';
      logger.info(
        { botOpenId: this.botOpenId },
        'Feishu bot identity resolved',
      );
    } catch (err) {
      logger.error({ err }, 'Failed to get Feishu bot info');
    }

    // Create event dispatcher
    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        this.handleMessage(data);
      },
    });

    // Create and start WebSocket long-connection client
    this.wsClient = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: lark.LoggerLevel.info,
      domain: this.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
    });

    await this.wsClient.start({ eventDispatcher });
    this.connected = true;
    logger.info('Feishu WebSocket connection established');
    console.log('\n  Feishu bot connected (WebSocket mode)');
    console.log(
      '  Add the bot to a group and send a message to get the chat ID\n',
    );
  }

  // ─── Inbound message handling ───────────────────────────────────────

  private handleMessage(data: any): void {
    const message = data.message;
    const sender = data.sender;

    // Skip bot's own messages
    if (sender?.sender_type === 'app') return;

    // Deduplicate retries (Feishu retries if handler takes > 3s)
    const eventId =
      data.event_id || data.header?.event_id || message?.message_id;
    if (eventId) {
      if (this.processedEvents.has(eventId)) return;
      this.processedEvents.add(eventId);
      // Evict old entries after 60 s to prevent memory leak
      setTimeout(() => this.processedEvents.delete(eventId), 60_000);
    }

    const chatId = message.chat_id;
    const chatJid = `feishu:${chatId}`;
    const chatType: string = message.chat_type; // 'group' or 'p2p'
    const isGroup = chatType === 'group';
    const msgId: string = message.message_id;
    const timestamp = new Date(parseInt(message.create_time, 10)).toISOString();
    const senderId: string = sender?.sender_id?.open_id || '';
    const senderName: string =
      sender?.sender_id?.user_id || senderId || 'Unknown';

    // Parse content based on message type
    const content = this.extractContent(message);

    // Translate @bot mention → TRIGGER_PATTERN so the orchestrator picks it up
    let finalContent = content;
    if (isGroup) {
      const mentions: any[] = message.mentions || [];
      const isBotMentioned = mentions.some(
        (m) => m.id?.open_id === this.botOpenId,
      );
      if (isBotMentioned && !TRIGGER_PATTERN.test(finalContent)) {
        finalContent = `@${ASSISTANT_NAME} ${finalContent}`;
      }
    }

    // Report chat metadata for discovery
    this.opts.onChatMetadata(chatJid, timestamp, undefined, 'feishu', isGroup);

    // Auto-register unregistered chats:
    //  - P2P (private) chats: always auto-register (no trigger required)
    //  - Group chats: auto-register as main if no main group exists yet
    let group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      const allGroups = this.opts.registeredGroups();
      const hasMain = Object.values(allGroups).some((g) => g.isMain);

      if (!isGroup) {
        // P2P → auto-register only if sender is in allowlist (or allowlist is empty = allow all)
        if (this.allowedUsers.size > 0 && !this.allowedUsers.has(senderId)) {
          logger.debug(
            { chatJid, senderId },
            'P2P from non-allowlisted user, ignoring',
          );
          return;
        }
        const folder = `feishu_dm_${chatId.slice(-8)}`;
        group = {
          name: `Feishu DM ${chatId.slice(-8)}`,
          folder,
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString(),
          requiresTrigger: false,
        };
        this.opts.registerGroup(chatJid, group);
        logger.info({ chatJid, folder }, 'Auto-registered Feishu P2P chat');
      } else if (!hasMain) {
        // First group → auto-register as main
        const folder = 'main';
        group = {
          name: 'Feishu Main',
          folder,
          trigger: `@${ASSISTANT_NAME}`,
          added_at: new Date().toISOString(),
          requiresTrigger: true,
          isMain: true,
        };
        this.opts.registerGroup(chatJid, group);
        logger.info({ chatJid }, 'Auto-registered first Feishu group as main');
      } else {
        logger.debug({ chatJid }, 'Message from unregistered Feishu chat');
        return;
      }
    }

    // Track last inbound message ID for reply-style typing indicator
    this.lastInboundMessageId.set(chatJid, msgId);

    this.opts.onMessage(chatJid, {
      id: msgId,
      chat_jid: chatJid,
      sender: senderId,
      sender_name: senderName,
      content: finalContent,
      timestamp,
      is_from_me: false,
    });

    logger.info({ chatJid, sender: senderName }, 'Feishu message stored');
  }

  // ─── Content extraction ─────────────────────────────────────────────

  extractContent(message: any): string {
    const messageType: string = message.message_type;
    let parsed: any;
    try {
      parsed = JSON.parse(message.content);
    } catch {
      return message.content || `[${messageType}]`;
    }

    switch (messageType) {
      case 'text': {
        let text: string = parsed.text || '';
        // Replace @_user_N placeholders with actual names
        const mentions: any[] = message.mentions || [];
        for (const mention of mentions) {
          text = text.replace(mention.key, `@${mention.name}`);
        }
        return text;
      }
      case 'post':
        return this.parsePostContent(parsed);
      case 'image':
        return '[Image]';
      case 'file':
        return `[File: ${parsed.file_name || 'unknown'}]`;
      case 'audio':
        return '[Audio]';
      case 'sticker':
        return '[Sticker]';
      case 'interactive':
        return '[Card]';
      case 'share_chat':
        return '[Shared Chat]';
      case 'share_user':
        return '[Shared Contact]';
      default:
        return `[${messageType}]`;
    }
  }

  private parsePostContent(post: any): string {
    const lang = post.zh_cn || post.en_us || (Object.values(post)[0] as any);
    if (!lang) return '[Rich Text]';

    let text = lang.title ? `${lang.title}\n` : '';
    for (const paragraph of lang.content || []) {
      for (const el of paragraph) {
        if (el.tag === 'text') text += el.text;
        else if (el.tag === 'a') text += el.text;
        else if (el.tag === 'at') text += `@${el.user_name || 'user'}`;
        else if (el.tag === 'img') text += '[Image]';
        else if (el.tag === 'media') text += '[Media]';
      }
      text += '\n';
    }
    return text.trim();
  }

  // ─── Outbound ───────────────────────────────────────────────────────

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Feishu client not initialized');
      return;
    }

    try {
      // Feishu card markdown has ~30000 char limit, but split at 4000 for readability
      const MAX_LENGTH = 4000;
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        chunks.push(text.slice(i, i + MAX_LENGTH));
      }

      const chatId = jid.replace(/^feishu:/, '');

      // If there's a "thinking" placeholder, update the first chunk into it
      const typingMsgId = this.typingMessageIds.get(jid);
      let startIndex = 0;

      if (typingMsgId && chunks.length > 0) {
        this.typingMessageIds.delete(jid);
        try {
          const card = {
            schema: '2.0',
            body: {
              elements: [{ tag: 'markdown', content: chunks[0] }],
            },
          };
          await this.client.im.message.patch({
            path: { message_id: typingMsgId },
            data: {
              content: JSON.stringify(card),
            },
          });
          startIndex = 1; // first chunk handled via update
        } catch {
          // Update failed (e.g. message already deleted), fall back to sending new
          startIndex = 0;
        }
      }

      // Send remaining chunks (or all chunks if no typing message)
      for (let i = startIndex; i < chunks.length; i++) {
        const card = {
          schema: '2.0',
          body: {
            elements: [{ tag: 'markdown', content: chunks[i] }],
          },
        };
        await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            content: JSON.stringify(card),
            msg_type: 'interactive',
          },
        });
      }

      logger.info({ jid, length: text.length }, 'Feishu message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Feishu message');
    }
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('feishu:');
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.wsClient = null;
    this.client = null;
    logger.info('Feishu channel stopped');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client) return;

    if (isTyping) {
      // Reply to the last inbound message with a "thinking" card
      const replyToId = this.lastInboundMessageId.get(jid);
      if (!replyToId) return;

      try {
        const card = {
          schema: '2.0',
          body: {
            elements: [{ tag: 'markdown', content: '⏳ 思考中...' }],
          },
        };
        const resp = await this.client.im.message.reply({
          path: { message_id: replyToId },
          data: {
            content: JSON.stringify(card),
            msg_type: 'interactive',
          },
        });
        const msgId = resp?.data?.message_id;
        if (msgId) {
          this.typingMessageIds.set(jid, msgId);
        }
      } catch (err) {
        logger.debug({ jid, err }, 'Failed to send typing indicator');
      }
    } else {
      // If sendMessage hasn't consumed the typing message, delete it
      await this.deleteTypingMessage(jid);
    }
  }

  private async deleteTypingMessage(jid: string): Promise<void> {
    const msgId = this.typingMessageIds.get(jid);
    if (!msgId || !this.client) return;
    this.typingMessageIds.delete(jid);
    try {
      await this.client.im.message.delete({ path: { message_id: msgId } });
    } catch (err) {
      logger.debug({ jid, msgId, err }, 'Failed to delete typing message');
    }
  }
}

// ─── Self-registration ──────────────────────────────────────────────────

registerChannel('feishu', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
    'FEISHU_DOMAIN',
    'FEISHU_ALLOWED_USERS',
  ]);
  const appId = process.env.FEISHU_APP_ID || envVars.FEISHU_APP_ID || '';
  const appSecret =
    process.env.FEISHU_APP_SECRET || envVars.FEISHU_APP_SECRET || '';
  const domain = process.env.FEISHU_DOMAIN || envVars.FEISHU_DOMAIN || 'feishu';
  const allowedUsersRaw =
    process.env.FEISHU_ALLOWED_USERS || envVars.FEISHU_ALLOWED_USERS || '';
  const allowedUsers = allowedUsersRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  if (!appId || !appSecret) {
    logger.warn('Feishu: FEISHU_APP_ID or FEISHU_APP_SECRET not set');
    return null;
  }

  return new FeishuChannel(appId, appSecret, domain, opts, allowedUsers);
});
