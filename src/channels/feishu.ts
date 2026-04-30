/**
 * Feishu (飞书/Lark) channel adapter.
 *
 * Uses WebSocket long-connection mode — no public URL needed.
 * Implements the v2 ChannelAdapter interface.
 */
import fs from 'fs';
import * as lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

// ─── Adapter factory ──────────────────────────────────────────────────────

function createAdapter(): ChannelAdapter | null {
  const envVars = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_DOMAIN', 'FEISHU_ALLOWED_USERS']);
  const appId = process.env.FEISHU_APP_ID || envVars.FEISHU_APP_ID || '';
  const appSecret = process.env.FEISHU_APP_SECRET || envVars.FEISHU_APP_SECRET || '';
  const domain = process.env.FEISHU_DOMAIN || envVars.FEISHU_DOMAIN || 'feishu';
  const allowedUsersRaw = process.env.FEISHU_ALLOWED_USERS || envVars.FEISHU_ALLOWED_USERS || '';
  const allowedUsers = new Set(
    allowedUsersRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  if (!appId || !appSecret) {
    log.warn('Feishu: FEISHU_APP_ID or FEISHU_APP_SECRET not set');
    return null;
  }

  // ─── State ───────────────────────────────────────────────────────────

  let client: lark.Client | null = null;
  let wsClient: lark.WSClient | null = null;
  let botOpenId = '';
  let connected = false;
  let setupConfig: ChannelSetup | null = null;
  /** Track processed event IDs to deduplicate retries (3-second timeout). */
  const processedEvents = new Set<string>();
  /** Track "thinking" placeholder message IDs per chatId so we can delete them. */
  const typingMessageIds = new Map<string, string>();
  /** Track last inbound message ID per chatId for reply-style typing indicator. */
  const lastInboundMessageId = new Map<string, string>();

  // ─── Inbound message handling ────────────────────────────────────────

  async function handleMessage(data: any): Promise<void> {
    const message = data.message;
    const sender = data.sender;

    // Skip bot's own messages
    if (sender?.sender_type === 'app') return;

    // Deduplicate retries (Feishu retries if handler takes > 3s)
    const eventId = data.event_id || data.header?.event_id || message?.message_id;
    if (eventId) {
      if (processedEvents.has(eventId)) return;
      processedEvents.add(eventId);
      // Evict old entries after 60 s to prevent memory leak
      setTimeout(() => processedEvents.delete(eventId), 60_000);
    }

    const chatId = message.chat_id;
    const platformId = chatId; // chatId is the Feishu platform identifier
    const chatType: string = message.chat_type; // 'group' or 'p2p'
    const isGroup = chatType === 'group';
    const msgId: string = message.message_id;
    const timestamp = new Date(parseInt(message.create_time, 10)).toISOString();
    const senderId: string = sender?.sender_id?.open_id || '';
    const senderName: string = sender?.sender_id?.user_id || senderId || 'Unknown';

    // Parse content based on message type
    const content = extractContent(message);
    log.info('Feishu message received (debug)', {
      messageType: message.message_type,
      content: message.content,
      extractedContent: content,
    });

    // Translate @bot mention → isMention flag
    let isMention: boolean | undefined;
    if (isGroup) {
      const mentions: any[] = message.mentions || [];
      isMention = mentions.some((m) => m.id?.open_id === botOpenId);
    }

    // Report chat metadata for discovery
    if (setupConfig) {
      setupConfig.onMetadata(platformId, undefined, isGroup);
    }

    // Build inbound message content (v2 format: JS object, host will JSON.stringify)
    const inboundContent = {
      text: content,
      sender: senderName,
      senderId,
      isMention,
    };

    // Track last inbound message ID for reply-style typing indicator
    lastInboundMessageId.set(platformId, msgId);

    // Deliver via v2 onInbound API
    if (setupConfig) {
      await setupConfig.onInbound(platformId, null, {
        id: msgId,
        kind: 'chat',
        content: inboundContent,
        timestamp,
        isMention,
        isGroup,
      });
    }

    log.info('Feishu message delivered to host', { platformId, sender: senderName });
  }

  // ─── Content extraction ──────────────────────────────────────────────

  function extractContent(message: any): string {
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
        return parsePostContent(parsed);
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

  function parsePostContent(post: any): string {
    const lang = resolvePostLang(post);
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

  function resolvePostLang(post: any): any {
    if (post.zh_cn) return post.zh_cn;
    if (post.en_us) return post.en_us;
    // Flat format: { title, content: [[...]] }
    if (Array.isArray(post.content)) return post;
    // Fallback: first value that has a content array
    for (const val of Object.values(post)) {
      if (val && typeof val === 'object' && Array.isArray((val as any).content)) {
        return val;
      }
    }
    return null;
  }

  // ─── Outbound delivery ───────────────────────────────────────────────

  function extractOutboundText(message: OutboundMessage): string | null {
    const c = message.content;
    if (typeof c === 'string') return c;
    if (c && typeof c === 'object' && typeof (c as any).text === 'string') {
      return (c as any).text;
    }
    return null;
  }

  // ─── Adapter object ─────────────────────────────────────────────────

  const adapter: ChannelAdapter = {
    name: 'feishu',
    channelType: 'feishu',
    supportsThreads: false,

    async setup(config: ChannelSetup): Promise<void> {
      setupConfig = config;

      // Create API client for sending messages
      client = new lark.Client({
        appId,
        appSecret,
        appType: lark.AppType.SelfBuild,
        domain: domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
      });

      // Resolve bot identity so we can detect @bot mentions
      try {
        const resp = await (client as any).request({
          method: 'GET',
          url: 'https://open.feishu.cn/open-apis/bot/v3/info',
          data: {},
          params: {},
        });
        botOpenId = resp?.bot?.open_id || '';
        log.info('Feishu bot identity resolved', { botOpenId });
      } catch (err) {
        log.error('Failed to get Feishu bot info', { err });
      }

      // Create event dispatcher
      const eventDispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data: any) => {
          handleMessage(data);
        },
      });

      // Create and start WebSocket long-connection client
      wsClient = new lark.WSClient({
        appId,
        appSecret,
        loggerLevel: lark.LoggerLevel.info,
        domain: domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu,
      });

      await wsClient.start({ eventDispatcher });
      connected = true;
      log.info('Feishu WebSocket connection established');
      console.log('\n  Feishu bot connected (WebSocket mode)');
      console.log('  Add the bot to a group and send a message to get the chat ID\n');
    },

    async teardown(): Promise<void> {
      connected = false;
      wsClient = null;
      client = null;
      setupConfig = null;
      log.info('Feishu channel stopped');
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      if (!client) {
        log.warn('Feishu client not initialized');
        return undefined;
      }

      const text = extractOutboundText(message);
      if (text === null) return undefined;

      try {
        // Feishu card markdown has ~30000 char limit, but split at 4000 for readability
        const MAX_LENGTH = 4000;
        const chunks: string[] = [];
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          chunks.push(text.slice(i, i + MAX_LENGTH));
        }

        const chatId = platformId;

        // If there's a "thinking" placeholder, update the first chunk into it
        const typingMsgId = typingMessageIds.get(platformId);
        let startIndex = 0;
        let lastMsgId: string | undefined;

        if (typingMsgId && chunks.length > 0) {
          typingMessageIds.delete(platformId);
          try {
            const card = {
              schema: '2.0',
              body: {
                elements: [{ tag: 'markdown', content: chunks[0] }],
              },
            };
            await client.im.message.patch({
              path: { message_id: typingMsgId },
              data: {
                content: JSON.stringify(card),
              },
            });
            lastMsgId = typingMsgId;
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
          const resp = await client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              content: JSON.stringify(card),
              msg_type: 'interactive',
            },
          });
          lastMsgId = resp?.data?.message_id;
        }

        // Handle file attachments from outbound message
        if (message.files && message.files.length > 0) {
          for (const file of message.files) {
            try {
              const uploadResp = await client.im.file.create({
                data: {
                  file_type: 'stream',
                  file_name: file.filename,
                  file: fs.createReadStream(pathFromBuffer(file.filename, file.data)),
                },
              });

              const fileKey = (uploadResp as any)?.data?.file_key || (uploadResp as any)?.file_key;
              if (fileKey) {
                const resp = await client.im.message.create({
                  params: { receive_id_type: 'chat_id' },
                  data: {
                    receive_id: chatId,
                    content: JSON.stringify({ file_key: fileKey }),
                    msg_type: 'file',
                  },
                });
                lastMsgId = resp?.data?.message_id;
                log.info('Feishu file sent', { chatId, filename: file.filename, fileKey });
              }
            } catch (err) {
              log.error('Failed to send file via Feishu', { chatId, filename: file.filename, err });
            }
          }
        }

        log.info('Feishu message sent', { platformId, length: text.length });
        return lastMsgId;
      } catch (err) {
        log.error('Failed to send Feishu message', { platformId, err });
        return undefined;
      }
    },

    async setTyping(platformId: string, _threadId: string | null): Promise<void> {
      if (!client) return;

      const card = {
        schema: '2.0',
        body: {
          elements: [{ tag: 'markdown', content: '⏳ 思考中...' }],
        },
      };

      try {
        // If a "thinking" card already exists for this chat, update it instead
        // of creating a new one. This avoids spamming multiple cards during the
        // 4-second typing refresh interval.
        const existingMsgId = typingMessageIds.get(platformId);
        if (existingMsgId) {
          await client.im.message.patch({
            path: { message_id: existingMsgId },
            data: { content: JSON.stringify(card) },
          });
          return;
        }

        // First time: reply to the last inbound message with a "thinking" card
        const replyToId = lastInboundMessageId.get(platformId);
        if (!replyToId) return;

        const resp = await client.im.message.reply({
          path: { message_id: replyToId },
          data: {
            content: JSON.stringify(card),
            msg_type: 'interactive',
          },
        });
        const msgId = resp?.data?.message_id;
        if (msgId) {
          typingMessageIds.set(platformId, msgId);
        }
      } catch (err) {
        log.debug('Failed to send typing indicator', { platformId, err });
      }
    },
  };

  return adapter;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

import os from 'os';
import path from 'path';

/** Write OutboundFile.data to a temp file so lark SDK can stream it. */
function pathFromBuffer(filename: string, data: Buffer): string {
  const tmpDir = os.tmpdir();
  const tmpPath = path.join(tmpDir, `feishu-upload-${Date.now()}-${filename}`);
  fs.writeFileSync(tmpPath, data);
  // Schedule cleanup after upload should be done
  setTimeout(() => {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* best-effort */
    }
  }, 30_000);
  return tmpPath;
}

// ─── Self-registration ────────────────────────────────────────────────────

registerChannelAdapter('feishu', { factory: createAdapter });
