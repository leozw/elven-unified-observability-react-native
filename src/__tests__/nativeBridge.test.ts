jest.mock('../NativeElvenUnifiedObservabilityReactNative', () => ({
  __esModule: true,
  default: {
    initialize: jest.fn(),
    drainEvents: jest.fn(),
    readPersistedQueue: jest.fn(),
    writePersistedQueue: jest.fn(),
    clearPersistedQueue: jest.fn(),
    shutdown: jest.fn(),
    setCurrentTraceContext: jest.fn(),
    setDiagnosticsEnabled: jest.fn(),
  },
}));

import { Diagnostics } from '../core/diagnostics';
import NativeModule from '../NativeElvenUnifiedObservabilityReactNative';
import { NativeBridge } from '../native/bridge';
import { NativeQueueStore } from '../transport/storage';
import { resolvedConfiguration } from '../__fixtures__/testConfig';

const mockNativeModule = NativeModule as unknown as {
  initialize: jest.Mock;
  drainEvents: jest.Mock;
  readPersistedQueue: jest.Mock;
  writePersistedQueue: jest.Mock;
  clearPersistedQueue: jest.Mock;
  shutdown: jest.Mock;
  setCurrentTraceContext: jest.Mock;
  setDiagnosticsEnabled: jest.Mock;
};

function createBridge(messages: string[] = []): NativeBridge {
  return new NativeBridge(
    new Diagnostics({
      enabled: true,
      verbose: true,
      sink: (message) => messages.push(message),
    })
  );
}

describe('NativeBridge', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockNativeModule.initialize.mockResolvedValue(
      JSON.stringify({
        platform: 'android',
        osVersion: '16',
        deviceModel: 'sdk_gphone64',
        appVersion: '4.2.0',
        appBuild: '42',
        appBundleId: 'works.elven.example',
        isEmulator: true,
        processStartUnixMillis: 1_725_000_000_000,
      })
    );
    mockNativeModule.drainEvents.mockResolvedValue([]);
    mockNativeModule.readPersistedQueue.mockResolvedValue('');
    mockNativeModule.writePersistedQueue.mockResolvedValue(true);
    mockNativeModule.clearPersistedQueue.mockResolvedValue(true);
    mockNativeModule.shutdown.mockResolvedValue(true);
  });

  it('initializes only native-safe settings and parses platform context', async () => {
    const bridge = createBridge();
    const config = resolvedConfiguration({
      collector: {
        endpoint: 'https://collector.example.test',
        headers: { authorization: 'Bearer never-cross-native-boundary' },
      },
      instrumentations: {
        console: false,
        network: false,
        errors: { enabled: true, nativeCrashes: true },
        lifecycle: {
          enabled: true,
          nativeEvents: true,
          anr: true,
          frozenFrames: true,
        },
      },
    });
    const platform = await bridge.initialize(config);

    expect(bridge.available).toBe(true);
    expect(platform).toEqual({
      platform: 'android',
      osVersion: '16',
      deviceModel: 'sdk_gphone64',
      appVersion: '4.2.0',
      appBuild: '42',
      appBundleId: 'works.elven.example',
      isEmulator: true,
      processStartUnixMillis: 1_725_000_000_000,
    });
    const nativeConfiguration = String(
      mockNativeModule.initialize.mock.calls[0]?.[0]
    );
    expect(nativeConfiguration).toContain('captureNativeCrashes');
    expect(nativeConfiguration).toContain('captureFrozenFrames');
    expect(nativeConfiguration).not.toContain('authorization');
    expect(nativeConfiguration).not.toContain('never-cross-native-boundary');
  });

  it('filters malformed events and proxies queue and trace operations', async () => {
    mockNativeModule.drainEvents.mockResolvedValue([
      JSON.stringify({
        id: 'event-1',
        type: 'performance',
        name: 'app.first_frame',
        timestampUnixMillis: 1_725_000_000_000,
        durationMillis: 400,
        attributes: { source: 'native' },
        traceId: '0123456789abcdef0123456789abcdef',
        spanId: '0123456789abcdef',
      }),
      '{bad-json',
      JSON.stringify({ id: 'missing-fields' }),
    ]);
    mockNativeModule.readPersistedQueue.mockResolvedValue(
      '{"schemaVersion":1}'
    );
    const bridge = createBridge();

    await expect(bridge.drainEvents()).resolves.toEqual([
      expect.objectContaining({
        id: 'event-1',
        type: 'performance',
        durationMillis: 400,
      }),
    ]);
    await expect(bridge.readPersistedQueue()).resolves.toBe(
      '{"schemaVersion":1}'
    );
    await expect(bridge.writePersistedQueue('{"safe":true}')).resolves.toBe(
      true
    );
    await expect(bridge.clearPersistedQueue()).resolves.toBe(true);
    bridge.setCurrentTraceContext({
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: '0123456789abcdef',
      traceFlags: 1,
    });
    bridge.setCurrentTraceContext(undefined);
    bridge.setDiagnosticsEnabled(true);
    expect(mockNativeModule.setCurrentTraceContext).toHaveBeenNthCalledWith(
      1,
      '0123456789abcdef0123456789abcdef',
      '0123456789abcdef'
    );
    expect(mockNativeModule.setCurrentTraceContext).toHaveBeenNthCalledWith(
      2,
      '',
      ''
    );
    expect(mockNativeModule.setDiagnosticsEnabled).toHaveBeenCalledWith(true);
    await expect(bridge.shutdown()).resolves.toBe(true);
  });

  it('uses nativeEvents as the lifecycle master switch without disabling native crashes', async () => {
    const bridge = createBridge();
    const config = resolvedConfiguration({
      instrumentations: {
        errors: { enabled: true, nativeCrashes: true },
        lifecycle: {
          enabled: true,
          nativeEvents: false,
          anr: true,
          frozenFrames: true,
        },
      },
    });

    await bridge.initialize(config);
    const nativeConfiguration = JSON.parse(
      String(mockNativeModule.initialize.mock.calls[0]?.[0])
    ) as Record<string, unknown>;

    expect(nativeConfiguration).toEqual(
      expect.objectContaining({
        captureLifecycle: false,
        captureAnr: false,
        captureFrozenFrames: false,
        captureNativeCrashes: true,
      })
    );
  });

  it('degrades every native rejection to safe JS defaults', async () => {
    const messages: string[] = [];
    const bridge = createBridge(messages);
    mockNativeModule.initialize.mockRejectedValue(new Error('native init'));
    mockNativeModule.drainEvents.mockRejectedValue(new Error('native events'));
    mockNativeModule.readPersistedQueue.mockRejectedValue(new Error('read'));
    mockNativeModule.writePersistedQueue.mockRejectedValue(new Error('write'));
    mockNativeModule.clearPersistedQueue.mockRejectedValue(new Error('clear'));
    mockNativeModule.shutdown.mockRejectedValue(new Error('shutdown'));
    mockNativeModule.setCurrentTraceContext.mockImplementation(() => {
      throw new Error('context');
    });
    mockNativeModule.setDiagnosticsEnabled.mockImplementation(() => {
      throw new Error('diagnostics');
    });

    await expect(bridge.initialize(resolvedConfiguration())).resolves.toEqual({
      platform: 'unknown',
    });
    await expect(bridge.drainEvents()).resolves.toEqual([]);
    await expect(bridge.readPersistedQueue()).resolves.toBeUndefined();
    await expect(bridge.writePersistedQueue('safe')).resolves.toBe(false);
    await expect(bridge.clearPersistedQueue()).resolves.toBe(false);
    await expect(bridge.shutdown()).resolves.toBe(false);
    expect(() => bridge.setCurrentTraceContext(undefined)).not.toThrow();
    expect(() => bridge.setDiagnosticsEnabled(true)).not.toThrow();
    expect(messages.length).toBeGreaterThanOrEqual(6);
  });
});

describe('NativeQueueStore', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockNativeModule.readPersistedQueue.mockResolvedValue('queue');
    mockNativeModule.writePersistedQueue.mockResolvedValue(true);
    mockNativeModule.clearPersistedQueue.mockResolvedValue(true);
  });

  it('persists only when both queue and native bridge are enabled', async () => {
    const bridge = createBridge();
    const store = new NativeQueueStore(
      bridge,
      true,
      new Diagnostics({ enabled: false, verbose: false })
    );
    expect(store.persistent).toBe(true);
    await expect(store.write('queue')).resolves.toBe(true);
    await expect(store.read()).resolves.toBe('queue');
    await expect(store.clear()).resolves.toBe(true);
    expect(mockNativeModule.writePersistedQueue).toHaveBeenCalledWith('queue');

    const disabled = new NativeQueueStore(
      bridge,
      false,
      new Diagnostics({ enabled: false, verbose: false })
    );
    expect(disabled.persistent).toBe(false);
    await expect(disabled.read()).resolves.toBeUndefined();
    await expect(disabled.write('queue')).resolves.toBe(false);
    await expect(disabled.clear()).resolves.toBe(false);
  });
});
