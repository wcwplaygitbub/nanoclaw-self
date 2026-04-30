import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

// Mock env reader — provide credentials so factory returns a real adapter
vi.mock('../env.js', () => ({
  readEnvFile: vi.fn(() => ({
    FEISHU_APP_ID: 'cli_test_app_id',
    FEISHU_APP_SECRET: 'test_app_secret',
    FEISHU_DOMAIN: 'feishu',
    FEISHU_ALLOWED_USERS: '',
  })),
}));

// Mock config
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

// Mock logger (v2 uses 'log' from '../log.js')
vi.mock('../log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock registry — use inline vi.fn() to avoid TDZ issues with hoisted vi.mock
vi.mock('./channel-registry.js', () => ({
  registerChannelAdapter: vi.fn(),
}));

// --- Lark SDK mock ---

const mockCreate = vi.fn().mockResolvedValue({});
const mockPatch = vi.fn().mockResolvedValue({});
const mockReply = vi.fn().mockResolvedValue({});
const mockRequest = vi.fn().mockResolvedValue({
  bot: { open_id: 'ou_bot_123' },
});
const mockWsStart = vi.fn().mockResolvedValue(undefined);

let capturedEventDispatcher: any = null;

vi.mock('@larksuiteoapi/node-sdk', () => {
  return {
    Client: class MockClient {
      im = {
        message: { create: mockCreate, patch: mockPatch, reply: mockReply },
      };
      request = mockRequest;
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
      async emit(eventType: string, data: any) {
        const handler = this.handlers[eventType];
        if (handler) await handler(data);
      }
    },
    AppType: { SelfBuild: 'SelfBuild' },
    Domain: {
      Feishu: 'https://open.feishu.cn',
      Lark: 'https://open.larksuite.com',
    },
    LoggerLevel: { info: 'info' },
  };
});

// --- Import after mocks (triggers registerChannelAdapter) ---

import './feishu.js';
import { registerChannelAdapter } from './channel-registry.js';

// --- Test helpers ---

function getAdapterFactory(): () => any {
  const mockFn = registerChannelAdapter as unknown as vi.Mock;
  const call = mockFn.mock.calls.find((c: any[]) => c[0] === 'feishu');
  if (!call) return () => null;
  return call[1].factory;
}

function createTestSetup() {
  return {
    onInbound: vi.fn(),
    onInboundEvent: vi.fn(),
    onMetadata: vi.fn(),
    onAction: vi.fn(),
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

describe('Feishu ChannelAdapter', () => {
  let adapter: any;
  let testSetup: ReturnType<typeof createTestSetup>;
  let savedFactory: (() => any) | null = null;

  beforeEach(() => {
    // Capture the factory before clearAllMocks wipes the call record
    const mockFn = registerChannelAdapter as unknown as vi.Mock;
    const call = mockFn.mock.calls.find((c: any[]) => c[0] === 'feishu');
    if (call) {
      savedFactory = call[1].factory;
    }

    vi.clearAllMocks();
    capturedEventDispatcher = null;

    // Create a fresh adapter from the saved factory
    adapter = savedFactory ? savedFactory() : null;
    testSetup = createTestSetup();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Registration ---

  describe('registration', () => {
    it('registers with correct channel name', () => {
      // The factory was captured during import, which means registerChannelAdapter was called
      expect(savedFactory).not.toBeNull();
      expect(typeof savedFactory).toBe('function');
    });

    it('factory returns an adapter with correct properties', () => {
      expect(adapter).not.toBeNull();
      expect(adapter.channelType).toBe('feishu');
      expect(adapter.name).toBe('feishu');
      expect(adapter.supportsThreads).toBe(false);
    });
  });

  // --- Setup / lifecycle ---

  describe('setup lifecycle', () => {
    it('connects via WebSocket on setup', async () => {
      await adapter.setup(testSetup);
      expect(mockWsStart).toHaveBeenCalled();
      expect(adapter.isConnected()).toBe(true);
    });

    it('resolves bot identity on setup', async () => {
      await adapter.setup(testSetup);
      expect(mockRequest).toHaveBeenCalled();
    });

    it('tears down cleanly', async () => {
      await adapter.setup(testSetup);
      expect(adapter.isConnected()).toBe(true);

      await adapter.teardown();
      expect(adapter.isConnected()).toBe(false);
    });

    it('isConnected() returns false before setup', () => {
      expect(adapter.isConnected()).toBe(false);
    });
  });

  // --- Inbound message handling ---

  describe('inbound message handling', () => {
    beforeEach(async () => {
      await adapter.setup(testSetup);
    });

    it('delivers message for registered group', async () => {
      const event = createMessageEvent({
        content: '{"text":"Hello everyone"}',
      });
      await fireMessageEvent(event);

      expect(testSetup.onInbound).toHaveBeenCalledWith(
        'oc_test123',
        null,
        expect.objectContaining({
          id: 'om_msg_001',
          kind: 'chat',
          isGroup: true,
        }),
      );
    });

    it('reports metadata for inbound messages', async () => {
      const event = createMessageEvent({});
      await fireMessageEvent(event);

      expect(testSetup.onMetadata).toHaveBeenCalledWith('oc_test123', undefined, true);
    });

    it('skips bot (app) messages', async () => {
      const event = createMessageEvent({ senderType: 'app' });
      await fireMessageEvent(event);

      expect(testSetup.onInbound).not.toHaveBeenCalled();
    });

    it('deduplicates retried events', async () => {
      const event = createMessageEvent({ eventId: 'ev_duplicate_1' });
      await fireMessageEvent(event);
      await fireMessageEvent(event); // same event ID

      expect(testSetup.onInbound).toHaveBeenCalledTimes(1);
    });

    it('sets isMention when bot is mentioned in group', async () => {
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

      expect(testSetup.onInbound).toHaveBeenCalledWith(
        'oc_test123',
        null,
        expect.objectContaining({
          isMention: true,
        }),
      );
    });

    it('does not set isMention when other user is mentioned', async () => {
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

      const call = testSetup.onInbound.mock.calls[0];
      const inboundMsg = call[2];
      expect(inboundMsg.isMention).toBeFalsy();
    });

    it('marks p2p chats as non-group in metadata', async () => {
      const event = createMessageEvent({
        chatId: 'oc_dm456',
        chatType: 'p2p',
      });
      await fireMessageEvent(event);

      expect(testSetup.onMetadata).toHaveBeenCalledWith('oc_dm456', undefined, false);
    });
  });

  // --- Deliver (outbound) ---

  describe('deliver', () => {
    beforeEach(async () => {
      await adapter.setup(testSetup);
    });

    it('sends text message via Lark API', async () => {
      await adapter.deliver('oc_test123', null, {
        kind: 'chat',
        content: { text: 'Hello' },
      });

      expect(mockCreate).toHaveBeenCalledWith({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: 'oc_test123',
          content: JSON.stringify({
            schema: '2.0',
            body: { elements: [{ tag: 'markdown', content: 'Hello' }] },
          }),
          msg_type: 'interactive',
        },
      });
    });

    it('handles string content', async () => {
      await adapter.deliver('oc_test123', null, {
        kind: 'chat',
        content: 'Plain text',
      });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            receive_id: 'oc_test123',
          }),
        }),
      );
    });

    it('returns undefined when client is not initialized', async () => {
      await adapter.teardown();

      const result = await adapter.deliver('oc_test123', null, {
        kind: 'chat',
        content: 'No client',
      });

      expect(result).toBeUndefined();
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('splits messages exceeding 4000 characters', async () => {
      const longText = 'x'.repeat(5000);
      await adapter.deliver('oc_test123', null, {
        kind: 'chat',
        content: { text: longText },
      });

      expect(mockCreate).toHaveBeenCalledTimes(2);
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    beforeEach(async () => {
      await adapter.setup(testSetup);
    });

    it('sends typing indicator by replying to last inbound message', async () => {
      // First, receive a message so there's a lastInboundMessageId
      const event = createMessageEvent({ chatId: 'oc_test123' });
      await fireMessageEvent(event);

      mockReply.mockResolvedValueOnce({ data: { message_id: 'typing_001' } });

      await adapter.setTyping('oc_test123', null);

      expect(mockReply).toHaveBeenCalled();
    });

    it('does not send typing when no prior inbound message', async () => {
      await adapter.setTyping('oc_noprior', null);

      expect(mockReply).not.toHaveBeenCalled();
    });
  });
});
