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

RCT_EXPORT_METHOD(sendHttp:(NSString *)sessionId requestId:(NSString *)requestId endpoint:(NSString *)endpoint
     headersJson:(NSString *)headersJson body:(NSString *)body timeoutMillis:(double)timeoutMillis
        resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject)
{
  [[self http] sendWithRegistry:_moduleRegistry session:sessionId requestId:requestId endpoint:endpoint
                    headersJson:headersJson body:body timeout:timeoutMillis resolve:resolve reject:reject];
}

RCT_EXPORT_METHOD(abortHttp:(NSString *)sessionId requestId:(NSString *)requestId)
{
  [[self http] abortSession:sessionId requestId:requestId];
}

RCT_EXPORT_MODULE()

RCT_EXPORT_METHOD(initialize:(NSString *)configurationJson
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject)
{
  resolve([ElvenNativeRuntime initializeWithConfiguration:configurationJson]);
}

RCT_EXPORT_METHOD(drainEvents:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject)
{
  resolve([ElvenNativeRuntime drainEvents]);
}

RCT_EXPORT_METHOD(readPersistedQueue:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject)
{
  [ElvenNativeRuntime readPersistedQueue:^(NSString *value) {
    resolve(value);
  }];
}

RCT_EXPORT_METHOD(writePersistedQueue:(NSString *)queueJson
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject)
{
  [ElvenNativeRuntime writePersistedQueue:queueJson
                               completion:^(BOOL written) {
    resolve(@(written));
  }];
}

RCT_EXPORT_METHOD(clearPersistedQueue:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject)
{
  [ElvenNativeRuntime clearPersistedQueue:^(BOOL cleared) {
    resolve(@(cleared));
  }];
}

RCT_EXPORT_METHOD(shutdown:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject)
{
  [[self http] closeAll];
  resolve(@([ElvenNativeRuntime shutdown]));
}

- (void)invalidate { [[self http] closeAll]; }

RCT_EXPORT_METHOD(setCurrentTraceContext:(NSString *)traceId spanId:(NSString *)spanId)
{
  [ElvenNativeRuntime setCurrentTraceId:traceId spanId:spanId];
}

RCT_EXPORT_METHOD(closeSession:(NSString *)sessionId
               purge:(BOOL)purge
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject)
{
  [[self http] closeSession:sessionId];
  [ElvenNativeRuntime closeSession:sessionId purge:purge completion:^(BOOL closed) { resolve(@(closed)); }];
}

RCT_EXPORT_METHOD(setDiagnosticsEnabled:(BOOL)enabled)
{
  [ElvenNativeRuntime setDiagnosticsEnabled:enabled];
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
    return std::make_shared<facebook::react::NativeElvenUnifiedObservabilityReactNativeSpecJSI>(params);
}

@end
