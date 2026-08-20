#import "ElvenUnifiedObservabilityReactNative.h"

@implementation ElvenUnifiedObservabilityReactNative
- (NSNumber *)multiply:(double)a b:(double)b {
    NSNumber *result = @(a * b);

    return result;
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
    return std::make_shared<facebook::react::NativeElvenUnifiedObservabilityReactNativeSpecJSI>(params);
}

+ (NSString *)moduleName
{
  return @"ElvenUnifiedObservabilityReactNative";
}

@end
