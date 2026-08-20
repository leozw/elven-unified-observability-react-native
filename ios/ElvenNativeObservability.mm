#import "ElvenNativeObservability.h"
#import "ElvenNativeRuntime.h"

@implementation ElvenNativeTraceContext

- (instancetype)initWithTraceId:(NSString *)traceId spanId:(NSString *)spanId
{
  self = [super init];
  if (self) {
    _traceId = [traceId copy];
    _spanId = [spanId copy];
  }
  return self;
}

@end

@implementation ElvenNativeObservability

+ (NSString *)currentTraceId
{
  return [ElvenNativeRuntime currentTraceId];
}

+ (NSString *)currentSpanId
{
  return [ElvenNativeRuntime currentSpanId];
}

+ (ElvenNativeTraceContext *)captureTraceContext
{
  NSString *traceId = [ElvenNativeRuntime currentTraceId];
  NSString *spanId = [ElvenNativeRuntime currentSpanId];
  if (traceId == nil || spanId == nil) return nil;
  return [[ElvenNativeTraceContext alloc] initWithTraceId:traceId
                                                   spanId:spanId];
}

+ (void)recordEventWithType:(NSString *)type
                       name:(NSString *)name
             durationMillis:(NSNumber *)durationMillis
                 attributes:(NSDictionary<NSString *, id> *)attributes
{
  [ElvenNativeRuntime recordEventWithType:type
                                     name:name
                           durationMillis:durationMillis
                               attributes:attributes];
}

+ (void)recordEventWithType:(NSString *)type
                       name:(NSString *)name
             durationMillis:(NSNumber *)durationMillis
                 attributes:(NSDictionary<NSString *, id> *)attributes
               traceContext:(ElvenNativeTraceContext *)traceContext
{
  [ElvenNativeRuntime recordEventWithType:type
                                     name:name
                           durationMillis:durationMillis
                               attributes:attributes
                                  traceId:traceContext.traceId
                                   spanId:traceContext.spanId];
}

@end
