#import "ElvenUnifiedObservabilityReactNative.h"
#import "ElvenNativeRuntime.h"
#import "ElvenHttpTransport.h"

@implementation ElvenUnifiedObservabilityReactNative {
  ElvenHttpTransport *_http;
}

@synthesize moduleRegistry = _moduleRegistry;

- (ElvenHttpTransport *)http
{
  @synchronized(self) { if (!_http) _http = [ElvenHttpTransport new]; return _http; }
}

- (void)sendHttp:(NSString *)sessionId requestId:(NSString *)requestId endpoint:(NSString *)endpoint
     headersJson:(NSString *)headersJson body:(NSString *)body timeoutMillis:(double)timeoutMillis
        resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [[self http] sendWithRegistry:_moduleRegistry session:sessionId requestId:requestId endpoint:endpoint
                    headersJson:headersJson body:body timeout:timeoutMillis resolve:resolve reject:reject];
}

- (void)abortHttp:(NSString *)sessionId requestId:(NSString *)requestId
{
  [[self http] abortSession:sessionId requestId:requestId];
}

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
  [[self http] closeAll];
  resolve(@([ElvenNativeRuntime shutdown]));
}

- (void)invalidate { [[self http] closeAll]; }

- (void)setCurrentTraceContext:(NSString *)traceId spanId:(NSString *)spanId
{
  [ElvenNativeRuntime setCurrentTraceId:traceId spanId:spanId];
}

- (void)closeSession:(NSString *)sessionId
               purge:(BOOL)purge
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject
{
  [[self http] closeSession:sessionId];
  [ElvenNativeRuntime closeSession:sessionId purge:purge completion:^(BOOL closed) { resolve(@(closed)); }];
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
