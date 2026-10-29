import { TurboModuleRegistry, type TurboModule } from 'react-native';

export interface Spec extends TurboModule {
  initialize(configurationJson: string): Promise<string>;
  drainEvents(): Promise<ReadonlyArray<string>>;
  readPersistedQueue(): Promise<string>;
  writePersistedQueue(queueJson: string): Promise<boolean>;
  clearPersistedQueue(): Promise<boolean>;
  shutdown(): Promise<boolean>;
  closeSession(sessionId: string, purge: boolean): Promise<boolean>;
  sendHttp(
    sessionId: string,
    requestId: string,
    endpoint: string,
    headersJson: string,
    body: string,
    timeoutMillis: number
  ): Promise<string>;
  abortHttp(sessionId: string, requestId: string): void;
  setCurrentTraceContext(traceId: string, spanId: string): void;
  setDiagnosticsEnabled(enabled: boolean): void;
}

export default TurboModuleRegistry.get<Spec>(
  'ElvenUnifiedObservabilityReactNative'
);
