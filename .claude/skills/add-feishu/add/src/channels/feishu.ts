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
  /** Track processed event IDs to deduplicate retries (3-second timeout). */
  private processedEvents = new Set<string>();

  constructor(
    appId: string,
    appSecret: string,
    domain: string,
    opts: FeishuChannelOpts,
  ) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.domain = domain;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    // Create API client for sending messages
    this.client = new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      appType: lark.AppType.SelfBuild,
      domain:
        this.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
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
      logger.info({ botOpenId: this.botOpenId }, 'Feishu bot identity resolved');
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
      domain:
        this.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
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
    const timestamp = new Date(
      parseInt(message.create_time, 10),
    ).toISOString();
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

    // Only deliver full message for registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug({ chatJid }, 'Message from unregistered Feishu chat');
      return;
    }

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
    const lang =
      post.zh_cn || post.en_us || (Object.values(post)[0] as any);
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
      const chatId = jid.replace(/^feishu:/, '');

      // Feishu has ~4000 char practical limit per text message
      const MAX_LENGTH = 4000;
      const chunks: string[] = [];
      for (let i = 0; i < text.length; i += MAX_LENGTH) {
        chunks.push(text.slice(i, i + MAX_LENGTH));
      }

      for (const chunk of chunks) {
        await this.client.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            content: JSON.stringify({ text: chunk }),
            msg_type: 'text',
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

  async setTyping(_jid: string, _isTyping: boolean): Promise<void> {
    // Feishu Open API does not expose a typing indicator
  }
}

// ─── Self-registration ──────────────────────────────────────────────────

registerChannel('feishu', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'FEISHU_APP_ID',
    'FEISHU_APP_SECRET',
    'FEISHU_DOMAIN',
  ]);
  const appId =
    process.env.FEISHU_APP_ID || envVars.FEISHU_APP_ID || '';
  const appSecret =
    process.env.FEISHU_APP_SECRET || envVars.FEISHU_APP_SECRET || '';
  const domain =
    process.env.FEISHU_DOMAIN || envVars.FEISHU_DOMAIN || 'feishu';

  if (!appId || !appSecret) {
    logger.warn('Feishu: FEISHU_APP_ID or FEISHU_APP_SECRET not set');
    return null;
  }

  return new FeishuChannel(appId, appSecret, domain, opts);
});
