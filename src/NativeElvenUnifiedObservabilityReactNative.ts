import { TurboModuleRegistry, type TurboModule } from 'react-native';

export interface Spec extends TurboModule {
  initialize(configurationJson: string): Promise<string>;
  drainEvents(): Promise<ReadonlyArray<string>>;
  readPersistedQueue(): Promise<string>;
  writePersistedQueue(queueJson: string): Promise<boolean>;
  clearPersistedQueue(): Promise<boolean>;
  shutdown(): Promise<boolean>;
  setCurrentTraceContext(traceId: string, spanId: string): void;
  setDiagnosticsEnabled(enabled: boolean): void;
}

export default TurboModuleRegistry.get<Spec>(
  'ElvenUnifiedObservabilityReactNative'
);
