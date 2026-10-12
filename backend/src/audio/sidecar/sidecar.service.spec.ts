import { Test, TestingModule } from '@nestjs/testing';

/** Controllable socket so reconnect tests need no real port. */
type Handler = (...args: any[]) => void;
type FakeSocket = {
  readyState: number;
  sent: Array<Buffer | string>;
  handlers: Map<string, Handler[]>;
  on(event: string, handler: Handler): FakeSocket;
  send(payload: Buffer | string): void;
  close(): void;
  emit(event: string, ...args: any[]): void;
};

// `var` because jest.mock is hoisted above the rest of the module.
var mockSockets: FakeSocket[] = [];

jest.mock('ws', () => {
  class MockWebSocket implements FakeSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    readyState = MockWebSocket.CONNECTING;
    sent: Array<Buffer | string> = [];
    handlers = new Map<string, Handler[]>();

    constructor(_url: string) {
      mockSockets.push(this);
    }

    on(event: string, handler: Handler): this {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
      return this;
    }

    send(payload: Buffer | string): void {
      if (this.readyState !== MockWebSocket.OPEN) throw new Error('not open');
      this.sent.push(payload);
    }

    close(): void {
      if (this.readyState === MockWebSocket.CLOSED) return;
      this.readyState = MockWebSocket.CLOSED;
      this.emit('close');
    }

    emit(event: string, ...args: any[]): void {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
  }

  return { WebSocket: MockWebSocket };
});

import { SidecarService } from './sidecar.service';

function socket(index = mockSockets.length - 1): FakeSocket {
  const value = mockSockets[index];
  if (!value) throw new Error(`missing fake socket ${index}`);
  return value;
}

function open(value = socket()): void {
  value.readyState = 1;
  value.emit('open');
}

function close(value = socket()): void {
  value.readyState = 3;
  value.emit('close');
}

function sentJson(value = socket()): unknown[] {
  return value.sent
    .filter((item): item is string => typeof item === 'string')
    .map((item) => JSON.parse(item) as unknown);
}

describe('SidecarService reconnect', () => {
  let module: TestingModule;
  let service: SidecarService;

  beforeEach(async () => {
    jest.useFakeTimers();
    mockSockets = [];
    module = await Test.createTestingModule({
      providers: [SidecarService],
    }).compile();
    service = module.get(SidecarService);
    service.onModuleInit();
  });

  afterEach(async () => {
    service.onModuleDestroy();
    await module.close();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('opens one socket on module init', () => {
    expect(mockSockets).toHaveLength(1);
    expect(service).toBeDefined();
  });

  it('reconnects with exponential backoff capped at 5 seconds', () => {
    close();
    expect(mockSockets).toHaveLength(1);

    jest.advanceTimersByTime(249);
    expect(mockSockets).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(mockSockets).toHaveLength(2);

    close();
    jest.advanceTimersByTime(500);
    expect(mockSockets).toHaveLength(3);

    close();
    jest.advanceTimersByTime(1_000);
    expect(mockSockets).toHaveLength(4);

    close();
    jest.advanceTimersByTime(2_000);
    expect(mockSockets).toHaveLength(5);

    close();
    jest.advanceTimersByTime(4_000);
    expect(mockSockets).toHaveLength(6);

    close();
    jest.advanceTimersByTime(5_000);
    expect(mockSockets).toHaveLength(7);

    close();
    jest.advanceTimersByTime(5_000);
    expect(mockSockets).toHaveLength(8);
  });

  it('resets backoff after a successful open', () => {
    close();
    jest.advanceTimersByTime(250);
    open();
    close();

    jest.advanceTimersByTime(249);
    expect(mockSockets).toHaveLength(2);
    jest.advanceTimersByTime(1);
    expect(mockSockets).toHaveLength(3);
  });

  it('does not schedule twice for error plus close or repeated close', () => {
    socket().emit('error', new Error('boom'));
    close();
    socket().emit('close');
    jest.advanceTimersByTime(250);
    expect(mockSockets).toHaveLength(2);
  });

  it('drops stale audio and chunk metadata while disconnected', () => {
    expect(service.sendAudio(Buffer.from([1]))).toBe(false);
    expect(service.sendMetadata({ type: 'audio', seq: 1 })).toBe(false);
    open();
    expect(socket().sent).toEqual([]);
  });

  it('coalesces controls and flushes latest source before reset', () => {
    service.sendSourceSwitch('v1');
    service.sendSourceSwitch('v2');
    service.sendReset();
    service.sendReset();

    open();

    expect(sentJson()).toEqual([
      { type: 'source-switch', sourceId: 'v2' },
      { type: 'reset' },
    ]);
  });

  it('lets the open callback replace an older queued source before flush', () => {
    service.sendSourceSwitch('old-source');
    service.sendReset();
    service.setOpenHandler(() => service.sendSourceSwitch('current-source'));

    open();

    expect(sentJson()).toEqual([
      { type: 'source-switch', sourceId: 'current-source' },
      { type: 'reset' },
    ]);
  });

  it('restores latest full scope and language after reconnect and rejects stale controls', () => {
    const scope = { sessionId: 's', generation: 1, sourceId: 'v1' };
    service.sendControl({ ...scope, type: 'source-language', language: 'vi' });
    service.sendControl({
      ...scope,
      generation: 2,
      sourceId: 'v2',
      type: 'source-switch',
    });
    expect(
      service.sendControl({
        ...scope,
        type: 'source-language',
        language: 'en',
      }),
    ).toBe(false);
    open();
    const latest = { ...scope, generation: 2, sourceId: 'v2' };
    expect(sentJson()).toEqual([
      { ...latest, type: 'source-switch' },
      { ...latest, type: 'source-language', language: 'vi' },
      { ...latest, type: 'reset' },
    ]);
    close();
    jest.advanceTimersByTime(250);
    open();
    expect(sentJson()).toEqual([
      { ...latest, type: 'source-switch' },
      { ...latest, type: 'source-language', language: 'vi' },
      { ...latest, type: 'reset' },
    ]);
  });

  it('forwards messages through the persistent handler after reconnect', () => {
    const handler = jest.fn();
    service.setMessageHandler(handler);
    open();
    socket().emit('message', Buffer.from('{"type":"status"}'));
    close();
    jest.advanceTimersByTime(250);
    open();
    socket().emit('message', Buffer.from('{"type":"words"}'));

    expect(handler).toHaveBeenNthCalledWith(1, '{"type":"status"}');
    expect(handler).toHaveBeenNthCalledWith(2, '{"type":"words"}');
  });

  it('cancels reconnect and never reconnects after destroy', () => {
    close();
    service.onModuleDestroy();
    jest.advanceTimersByTime(60_000);
    expect(mockSockets).toHaveLength(1);
  });
});
