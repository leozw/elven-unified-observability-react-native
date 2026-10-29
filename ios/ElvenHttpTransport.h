#import <React/RCTBridgeModule.h>

@interface ElvenHttpTransport : NSObject
- (void)sendWithRegistry:(RCTModuleRegistry *)registry session:(NSString *)session requestId:(NSString *)requestId
               endpoint:(NSString *)endpoint headersJson:(NSString *)headersJson body:(NSString *)body
                timeout:(double)timeout resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)abortSession:(NSString *)session requestId:(NSString *)requestId;
- (void)closeSession:(NSString *)session;
- (void)closeAll;
@end
