#import "ElvenUnifiedObservabilityReactNative.h"
#import "ElvenNativeRuntime.h"

@implementation ElvenUnifiedObservabilityReactNative

RCT_EXPORT_MODULE()

- (void)initialize:(NSString *)configurationJson
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject
{
  resolve([ElvenNativeRuntime initializeWithConfiguration:configurationJson]);
}

- (void)drainEvents:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject
{
  resolve([ElvenNativeRuntime drainEvents]);
}

- (void)readPersistedQueue:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject
{
  [ElvenNativeRuntime readPersistedQueue:^(NSString *value) {
    resolve(value);
  }];
}

- (void)writePersistedQueue:(NSString *)queueJson
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
  [ElvenNativeRuntime writePersistedQueue:queueJson
                               completion:^(BOOL written) {
    resolve(@(written));
  }];
}

- (void)clearPersistedQueue:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject
{
  [ElvenNativeRuntime clearPersistedQueue:^(BOOL cleared) {
    resolve(@(cleared));
  }];
}

- (void)shutdown:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject
{
  resolve(@([ElvenNativeRuntime shutdown]));
}

- (void)setCurrentTraceContext:(NSString *)traceId spanId:(NSString *)spanId
{
  [ElvenNativeRuntime setCurrentTraceId:traceId spanId:spanId];
}

- (void)setDiagnosticsEnabled:(BOOL)enabled
{
  [ElvenNativeRuntime setDiagnosticsEnabled:enabled];
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
    return std::make_shared<facebook::react::NativeElvenUnifiedObservabilityReactNativeSpecJSI>(params);
}

@end
