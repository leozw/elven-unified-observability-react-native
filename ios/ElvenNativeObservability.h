#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface ElvenNativeTraceContext : NSObject

@property(nonatomic, copy, readonly) NSString *traceId;
@property(nonatomic, copy, readonly) NSString *spanId;

- (instancetype)initWithTraceId:(NSString *)traceId
                         spanId:(NSString *)spanId NS_DESIGNATED_INITIALIZER;
- (instancetype)init NS_UNAVAILABLE;

@end

/** Native entry point for custom Objective-C and Swift modules. */
@interface ElvenNativeObservability : NSObject

+ (nullable NSString *)currentTraceId;
+ (nullable NSString *)currentSpanId;
+ (nullable ElvenNativeTraceContext *)captureTraceContext;
+ (void)recordEventWithType:(NSString *)type
                       name:(NSString *)name
             durationMillis:(nullable NSNumber *)durationMillis
                 attributes:(nullable NSDictionary<NSString *, id> *)attributes;
+ (void)recordEventWithType:(NSString *)type
                       name:(NSString *)name
             durationMillis:(nullable NSNumber *)durationMillis
                 attributes:(nullable NSDictionary<NSString *, id> *)attributes
               traceContext:(ElvenNativeTraceContext *)traceContext;

@end

NS_ASSUME_NONNULL_END
