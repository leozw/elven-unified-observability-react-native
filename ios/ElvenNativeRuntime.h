#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface ElvenNativeRuntime : NSObject

+ (NSString *)initializeWithConfiguration:(NSString *)configurationJson;
+ (NSArray<NSString *> *)drainEvents;
+ (void)readPersistedQueue:(void (^)(NSString *value))completion;
+ (void)writePersistedQueue:(NSString *)value
                 completion:(void (^)(BOOL written))completion;
+ (void)clearPersistedQueue:(void (^)(BOOL cleared))completion;
+ (BOOL)shutdown;
+ (void)setCurrentTraceId:(NSString *)traceId spanId:(NSString *)spanId;
+ (void)setDiagnosticsEnabled:(BOOL)enabled;
+ (nullable NSString *)currentTraceId;
+ (nullable NSString *)currentSpanId;
+ (void)recordEventWithType:(NSString *)type
                       name:(NSString *)name
             durationMillis:(nullable NSNumber *)durationMillis
                 attributes:(nullable NSDictionary<NSString *, id> *)attributes;
+ (void)recordEventWithType:(NSString *)type
                       name:(NSString *)name
             durationMillis:(nullable NSNumber *)durationMillis
                 attributes:(nullable NSDictionary<NSString *, id> *)attributes
                    traceId:(NSString *)traceId
                     spanId:(NSString *)spanId;

@end

NS_ASSUME_NONNULL_END
