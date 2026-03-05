import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock registry (registerChannel runs at import time)
vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));

// Mock env reader
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

// Mock logger
vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// --- Lark SDK mock ---

const mockCreate = vi.fn().mockResolvedValue({});
const mockBotInfoGet = vi.fn().mockResolvedValue({
  data: { bot: { open_id: 'ou_bot_123' } },
});
const mockWsStart = vi.fn().mockResolvedValue(undefined);

// Capture the event dispatcher so we can fire events in tests
let capturedEventDispatcher: any = null;

vi.mock('@larksuiteoapi/node-sdk', () => {
  return {
    Client: class MockClient {
      im = {
        message: { create: mockCreate },
      };
      bot = {
        botInfo: { get: mockBotInfoGet },
      };
    },
    WSClient: class MockWSClient {
      async start(opts: any) {
        capturedEventDispatcher = opts.eventDispatcher;
        await mockWsStart(opts);
      }
    },
    EventDispatcher: class MockEventDispatcher {
      private handlers: Record<string, Function> = {};
      register(map: Record<string, Function>) {
        Object.assign(this.handlers, map);
        return this;
      }
      // Expose for tests to call
      async emit(eventType: string, data: any) {
        const handler = this.handlers[eventType];
        if (handler) await handler(data);
      }
    },
    AppType: { SelfBuild: 'SelfBuild' },
    Domain: { Feishu: 'https://open.feishu.cn', Lark: 'https://open.larksuite.com' },
    LoggerLevel: { INFO: 'info' },
  };
});

import { FeishuChannel, FeishuChannelOpts } from './feishu.js';

// --- Test helpers ---

function createTestOpts(
  overrides?: Partial<FeishuChannelOpts>,
): FeishuChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'feishu:oc_test123': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    registerGroup: vi.fn(),
    ...overrides,
  };
}

function createMessageEvent(overrides: {
  chatId?: string;
  chatType?: string;
  messageType?: string;
  content?: string;
  messageId?: string;
  createTime?: string;
  senderOpenId?: string;
  senderUserId?: string;
  senderType?: string;
  mentions?: any[];
  eventId?: string;
}) {
  return {
    header: { event_id: overrides.eventId || `ev_${Date.now()}` },
    sender: {
      sender_id: {
        open_id: overrides.senderOpenId || 'ou_user_456',
        user_id: overrides.senderUserId || 'user_456',
      },
      sender_type: overrides.senderType || 'user',
    },
    message: {
      message_id: overrides.messageId || 'om_msg_001',
      chat_id: overrides.chatId || 'oc_test123',
      chat_type: overrides.chatType || 'group',
      message_type: overrides.messageType || 'text',
      content: overrides.content || '{"text":"Hello"}',
      create_time: overrides.createTime || '1704067200000',
      mentions: overrides.mentions || [],
    },
  };
}

async function fireMessageEvent(data: any) {
  if (capturedEventDispatcher) {
    await capturedEventDispatcher.emit('im.message.receive_v1', data);
  }
}

// --- Tests ---

describe('FeishuChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedEventDispatcher = null;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('resolves connect() when WebSocket starts', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', opts);

      await channel.connect();

      expect(channel.isConnected()).toBe(true);
    });

    it('fetches bot identity on connect', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', opts);

      await channel.connect();

      expect(mockBotInfoGet).toHaveBeenCalled();
    });

    it('starts WebSocket client on connect', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', opts);

      await channel.connect();

      expect(mockWsStart).toHaveBeenCalled();
    });

    it('disconnects cleanly', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', opts);

      await channel.connect();
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected() returns false before connect', () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', opts);

      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- Text message handling ---

  describe('text message handling', () => {
    it('delivers message for registered group', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', opts);
      await channel.connect();

      const event = createMessageEvent({
        content: '{"text":"Hello everyone"}',
      });
      await fireMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.any(String),
        undefined,
        'feishu',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({
          id: 'om_msg_001',
          chat_jid: 'feishu:oc_test123',
          sender: 'ou_user_456',
          sender_name: 'user_456',
          content: 'Hello everyone',
          is_from_me: false,
        }),
      );
    });

    it('only emits metadata for unregistered chats', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', opts);
      await channel.connect();

      const event = createMessageEvent({ chatId: 'oc_unknown999' });
      await fireMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'feishu:oc_unknown999',
        expect.any(String),
        undefined,
        'feishu',
        true,
      );
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips bot (app) messages', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', opts);
      await channel.connect();

      const event = createMessageEvent({ senderType: 'app' });
      await fireMessageEvent(event);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('converts create_time to ISO timestamp', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', opts);
      await channel.connect();

      const event = createMessageEvent({
        createTime: '1704067200000', // 2024-01-01T00:00:00.000Z
      });
      await fireMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({
          timestamp: '2024-01-01T00:00:00.000Z',
        }),
      );
    });

    it('marks p2p chats as non-group', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'feishu:oc_dm456': {
            name: 'DM',
            folder: 'dm',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', opts);
      await channel.connect();

      const event = createMessageEvent({
        chatId: 'oc_dm456',
        chatType: 'p2p',
      });
      await fireMessageEvent(event);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'feishu:oc_dm456',
        expect.any(String),
        undefined,
        'feishu',
        false, // not a group
      );
    });

    it('deduplicates retried events', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', opts);
      await channel.connect();

      const event = createMessageEvent({ eventId: 'ev_duplicate_1' });
      await fireMessageEvent(event);
      await fireMessageEvent(event); // same event ID

      expect(opts.onMessage).toHaveBeenCalledTimes(1);
    });
  });

  // --- @mention translation ---

  describe('@mention translation', () => {
    it('translates @bot mention to trigger format in group', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', opts);
      await channel.connect();

      // When bot name does NOT start with the trigger pattern, prepend is needed
      const event = createMessageEvent({
        content: '{"text":"hey @_user_1 what time is it?"}',
        mentions: [
          {
            key: '@_user_1',
            id: { open_id: 'ou_bot_123' },
            name: 'FeishuBot',
          },
        ],
      });
      await fireMessageEvent(event);

      // Bot mentioned but content doesn't start with @Andy → prepend trigger
      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({
          content: '@Andy hey @FeishuBot what time is it?',
        }),
      );
    });

    it('does not prepend trigger when bot name already matches pattern', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', opts);
      await channel.connect();

      // Bot named "Andy Bot" → after replacement, "@Andy Bot ..." already matches TRIGGER_PATTERN
      const event = createMessageEvent({
        content: '{"text":"@_user_1 what time is it?"}',
        mentions: [
          {
            key: '@_user_1',
            id: { open_id: 'ou_bot_123' },
            name: 'Andy Bot',
          },
        ],
      });
      await fireMessageEvent(event);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({
          content: '@Andy Bot what time is it?',
        }),
      );
    });

    it('does not translate if message already matches trigger', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', opts);
      await channel.connect();

      const event = createMessageEvent({
        content: '{"text":"@Andy @_user_1 hello"}',
        mentions: [
          {
            key: '@_user_1',
            id: { open_id: 'ou_bot_123' },
            name: 'Andy Bot',
          },
        ],
      });
      await fireMessageEvent(event);

      // Should NOT double-prepend
      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({
          content: '@Andy @Andy Bot hello',
        }),
      );
    });

    it('does not translate mentions of other users', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', opts);
      await channel.connect();

      const event = createMessageEvent({
        content: '{"text":"@_user_1 hello"}',
        mentions: [
          {
            key: '@_user_1',
            id: { open_id: 'ou_other_user' },
            name: 'Some User',
          },
        ],
      });
      await fireMessageEvent(event);

      // Not bot mentioned → no trigger prepend
      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_test123',
        expect.objectContaining({
          content: '@Some User hello',
        }),
      );
    });

    it('does not add trigger for p2p messages', async () => {
      const opts = createTestOpts({
        registeredGroups: vi.fn(() => ({
          'feishu:oc_dm456': {
            name: 'DM',
            folder: 'dm',
            trigger: '@Andy',
            added_at: '2024-01-01T00:00:00.000Z',
          },
        })),
      });
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', opts);
      await channel.connect();

      const event = createMessageEvent({
        chatId: 'oc_dm456',
        chatType: 'p2p',
        content: '{"text":"hello bot"}',
      });
      await fireMessageEvent(event);

      // p2p — no trigger prepend even though bot is not mentioned
      expect(opts.onMessage).toHaveBeenCalledWith(
        'feishu:oc_dm456',
        expect.objectContaining({
          content: 'hello bot',
        }),
      );
    });
  });

  // --- Content extraction ---

  describe('content extraction', () => {
    it('extracts text with mention placeholder replacement', async () => {
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', createTestOpts());
      const result = channel.extractContent({
        message_type: 'text',
        content: '{"text":"@_user_1 hi @_user_2"}',
        mentions: [
          { key: '@_user_1', name: 'Alice' },
          { key: '@_user_2', name: 'Bob' },
        ],
      });
      expect(result).toBe('@Alice hi @Bob');
    });

    it('returns placeholder for image messages', () => {
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', createTestOpts());
      const result = channel.extractContent({
        message_type: 'image',
        content: '{"image_key":"img_v3_xxx"}',
        mentions: [],
      });
      expect(result).toBe('[Image]');
    });

    it('returns file name for file messages', () => {
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', createTestOpts());
      const result = channel.extractContent({
        message_type: 'file',
        content: '{"file_key":"file_v3_xxx","file_name":"report.pdf"}',
        mentions: [],
      });
      expect(result).toBe('[File: report.pdf]');
    });

    it('returns fallback for file without name', () => {
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', createTestOpts());
      const result = channel.extractContent({
        message_type: 'file',
        content: '{"file_key":"file_v3_xxx"}',
        mentions: [],
      });
      expect(result).toBe('[File: unknown]');
    });

    it('returns placeholder for audio', () => {
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', createTestOpts());
      const result = channel.extractContent({
        message_type: 'audio',
        content: '{"file_key":"file_v3_xxx"}',
        mentions: [],
      });
      expect(result).toBe('[Audio]');
    });

    it('returns placeholder for sticker', () => {
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', createTestOpts());
      const result = channel.extractContent({
        message_type: 'sticker',
        content: '{"file_key":"file_v3_xxx"}',
        mentions: [],
      });
      expect(result).toBe('[Sticker]');
    });

    it('returns placeholder for interactive card', () => {
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', createTestOpts());
      const result = channel.extractContent({
        message_type: 'interactive',
        content: '{"header":{}}',
        mentions: [],
      });
      expect(result).toBe('[Card]');
    });

    it('returns placeholder for unknown message types', () => {
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', createTestOpts());
      const result = channel.extractContent({
        message_type: 'merge_forward',
        content: '{}',
        mentions: [],
      });
      expect(result).toBe('[merge_forward]');
    });

    it('parses rich text (post) messages', () => {
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', createTestOpts());
      const postContent = JSON.stringify({
        zh_cn: {
          title: 'Test Title',
          content: [
            [
              { tag: 'text', text: 'Hello ' },
              { tag: 'a', text: 'link', href: 'https://example.com' },
            ],
            [
              { tag: 'text', text: 'Second line' },
              { tag: 'at', user_name: 'Alice' },
            ],
          ],
        },
      });
      const result = channel.extractContent({
        message_type: 'post',
        content: postContent,
        mentions: [],
      });
      expect(result).toBe('Test Title\nHello link\nSecond line@Alice');
    });

    it('handles post with only en_us locale', () => {
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', createTestOpts());
      const postContent = JSON.stringify({
        en_us: {
          title: 'English Post',
          content: [[{ tag: 'text', text: 'Hello world' }]],
        },
      });
      const result = channel.extractContent({
        message_type: 'post',
        content: postContent,
        mentions: [],
      });
      expect(result).toBe('English Post\nHello world');
    });

    it('handles malformed JSON content gracefully', () => {
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', createTestOpts());
      const result = channel.extractContent({
        message_type: 'text',
        content: 'not-json',
        mentions: [],
      });
      expect(result).toBe('not-json');
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    it('sends message via Lark API', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', opts);
      await channel.connect();

      await channel.sendMessage('feishu:oc_test123', 'Hello');

      expect(mockCreate).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_test123',
          content: JSON.stringify({ text: 'Hello' }),
          msg_type: 'text',
        },
      });
    });

    it('strips feishu: prefix from JID', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', opts);
      await channel.connect();

      await channel.sendMessage('feishu:oc_abc_xyz', 'Test');

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            receive_id: 'oc_abc_xyz',
          }),
        }),
      );
    });

    it('splits messages exceeding 4000 characters', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', opts);
      await channel.connect();

      const longText = 'x'.repeat(5000);
      await channel.sendMessage('feishu:oc_test123', longText);

      expect(mockCreate).toHaveBeenCalledTimes(2);
      // First chunk: 4000 chars
      expect(mockCreate).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          data: expect.objectContaining({
            content: JSON.stringify({ text: 'x'.repeat(4000) }),
          }),
        }),
      );
      // Second chunk: 1000 chars
      expect(mockCreate).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          data: expect.objectContaining({
            content: JSON.stringify({ text: 'x'.repeat(1000) }),
          }),
        }),
      );
    });

    it('sends exactly one message at 4000 characters', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', opts);
      await channel.connect();

      await channel.sendMessage('feishu:oc_test123', 'y'.repeat(4000));

      expect(mockCreate).toHaveBeenCalledTimes(1);
    });

    it('handles send failure gracefully', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', opts);
      await channel.connect();

      mockCreate.mockRejectedValueOnce(new Error('Network error'));

      // Should not throw
      await expect(
        channel.sendMessage('feishu:oc_test123', 'Will fail'),
      ).resolves.toBeUndefined();
    });

    it('does nothing when client is not initialized', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('app_id', 'app_secret', 'feishu', opts);

      // Don't connect
      await channel.sendMessage('feishu:oc_test123', 'No client');

      expect(mockCreate).not.toHaveBeenCalled();
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns feishu: JIDs', () => {
      const channel = new FeishuChannel('a', 'b', 'feishu', createTestOpts());
      expect(channel.ownsJid('feishu:oc_test123')).toBe(true);
    });

    it('does not own Telegram JIDs', () => {
      const channel = new FeishuChannel('a', 'b', 'feishu', createTestOpts());
      expect(channel.ownsJid('tg:123456')).toBe(false);
    });

    it('does not own WhatsApp JIDs', () => {
      const channel = new FeishuChannel('a', 'b', 'feishu', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });

    it('does not own unknown JID formats', () => {
      const channel = new FeishuChannel('a', 'b', 'feishu', createTestOpts());
      expect(channel.ownsJid('random-string')).toBe(false);
    });
  });

  // --- Channel properties ---

  describe('channel properties', () => {
    it('has name "feishu"', () => {
      const channel = new FeishuChannel('a', 'b', 'feishu', createTestOpts());
      expect(channel.name).toBe('feishu');
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('does not throw (no-op since Feishu has no typing API)', async () => {
      const opts = createTestOpts();
      const channel = new FeishuChannel('a', 'b', 'feishu', opts);
      await expect(
        channel.setTyping('feishu:oc_test123', true),
      ).resolves.toBeUndefined();
    });
  });
});
