#import "ElvenHttpTransport.h"
#import "ElvenNativeRuntime.h"
#import <React/RCTNetworking.h>
#import <React/RCTURLRequestDelegate.h>
#import <React/RCTURLRequestHandler.h>
#include <cmath>

// Version-qualified RN selector: preserve the host's actual URL request handler.
@interface RCTNetworking (ElvenHandlerSelection)
- (id<RCTURLRequestHandler>)handlerForRequest:(NSURLRequest *)request;
@end

@interface ElvenStatusRequest : NSObject <RCTURLRequestDelegate>
@property(nonatomic, copy) NSString *session;
@property(nonatomic, strong) id<RCTURLRequestHandler> handler;
@property(nonatomic, strong) id token;
@property(nonatomic, copy) void (^complete)(NSString *);
@end

@implementation ElvenStatusRequest
- (void)finish:(NSString *)result
{
  void (^complete)(NSString *);
  id<RCTURLRequestHandler> handler;
  id token;
  @synchronized(self) {
    complete = self.complete;
    if (!complete) return;
    self.complete = nil;
    handler = self.handler;
    token = self.token;
    self.token = nil;
    self.handler = nil;
  }
  if (token) [handler cancelRequest:token];
  complete(result);
}
- (void)URLRequest:(id)requestToken didReceiveResponse:(NSURLResponse *)response
{
  // The delegate receives headers natively. No RCTNetworkTask body accumulator is used.
  @synchronized(self) { if (!self.token) self.token = requestToken; }
  if (![response isKindOfClass:NSHTTPURLResponse.class]) { [self finish:nil]; return; }
  NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
  NSMutableDictionary *result = [@{@"status": @(http.statusCode)} mutableCopy];
  for (NSString *key in http.allHeaderFields) {
    if ([key caseInsensitiveCompare:@"Retry-After"] == NSOrderedSame) {
      NSString *value = [http.allHeaderFields[key] description];
      result[@"retryAfter"] = value.length > 256 ? [@"" stringByPaddingToLength:257 withString:@"9" startingAtIndex:0] : value;
      break;
    }
  }
  NSData *data = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
  [self finish:[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding]];
}
- (void)URLRequest:(id)requestToken didReceiveData:(NSData *)data { /* Discard late chunks; never accumulate response data. */ }
- (void)URLRequest:(id)requestToken didSendDataWithProgress:(int64_t)bytesSent {}
- (void)URLRequest:(id)requestToken didCompleteWithError:(NSError *)error { [self finish:nil]; }
@end

@implementation ElvenHttpTransport {
  NSMutableDictionary<NSString *, ElvenStatusRequest *> *_pending;
  NSMutableOrderedSet<NSString *> *_closed;
}
- (instancetype)init
{
  if ((self = [super init])) { _pending = [NSMutableDictionary new]; _closed = [NSMutableOrderedSet new]; }
  return self;
}
- (void)sendWithRegistry:(RCTModuleRegistry *)registry session:(NSString *)session requestId:(NSString *)requestId
               endpoint:(NSString *)endpoint headersJson:(NSString *)headersJson body:(NSString *)body
                timeout:(double)timeout resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  RCTNetworking *networking = [registry moduleForName:"Networking"];
  dispatch_queue_t queue = [networking requestQueue];
  if (!queue || ![networking respondsToSelector:@selector(handlerForRequest:)] ||
      endpoint.length > 16384 || headersJson.length > 65536 || body.length > 4194304 ||
      !isfinite(timeout) || timeout < 1 || timeout > 30000 || requestId.length > 128) {
    reject(@"ELVEN_HTTP_UNAVAILABLE", @"Bounded native HTTP unavailable; no fallback request was sent.", nil); return;
  }
  dispatch_async(queue, ^{
    @synchronized(self) {
      if ([self->_closed containsObject:session] || ![ElvenNativeRuntime isSessionActive:session] ||
          self->_pending.count >= 4 || self->_pending[requestId]) {
        reject(@"ELVEN_HTTP_CLOSED", @"Telemetry HTTP owner is closed or at capacity.", nil); return;
      }
      NSURL *url = [NSURL URLWithString:endpoint];
      NSDictionary *headers = [NSJSONSerialization JSONObjectWithData:[headersJson dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
      if (!([url.scheme isEqualToString:@"https"] || [url.scheme isEqualToString:@"http"]) ||
          ![headers isKindOfClass:NSDictionary.class] || headers.count > 128) {
        reject(@"ELVEN_HTTP_INVALID", @"Invalid telemetry request.", nil); return;
      }
      NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:timeout / 1000.0];
      request.HTTPMethod = @"POST";
      request.HTTPShouldHandleCookies = NO;
      request.HTTPBody = [body dataUsingEncoding:NSUTF8StringEncoding];
      request.allHTTPHeaderFields = headers;
      id<RCTURLRequestHandler> handler = [networking handlerForRequest:request];
      if (!handler || ![handler respondsToSelector:@selector(cancelRequest:)]) {
        reject(@"ELVEN_HTTP_UNAVAILABLE", @"RN HTTP handler cannot acknowledge cancellation.", nil); return;
      }
      ElvenStatusRequest *owned = [ElvenStatusRequest new];
      owned.session = session;
      owned.handler = handler;
      __weak ElvenHttpTransport *weakSelf = self;
      owned.complete = ^(NSString *result) {
        ElvenHttpTransport *strongSelf = weakSelf;
        if (strongSelf) { @synchronized(strongSelf) { [strongSelf->_pending removeObjectForKey:requestId]; } }
        if (result && [ElvenNativeRuntime isSessionActive:session]) resolve(result);
        else reject(@"ELVEN_HTTP_CLOSED", @"Telemetry HTTP failed or was cancelled.", nil);
      };
      self->_pending[requestId] = owned;
      owned.token = [handler sendRequest:request withDelegate:owned];
      if (!owned.token) [owned finish:nil];
    }
  });
}
- (void)abortSession:(NSString *)session requestId:(NSString *)requestId
{
  ElvenStatusRequest *owned;
  @synchronized(self) { owned = _pending[requestId]; }
  if ([owned.session isEqualToString:session]) [owned finish:nil];
}
- (void)closeSession:(NSString *)session
{
  NSArray<ElvenStatusRequest *> *requests;
  @synchronized(self) {
    [_closed addObject:session];
    while (_closed.count > 64) [_closed removeObjectAtIndex:0];
    requests = _pending.allValues;
  }
  for (ElvenStatusRequest *owned in requests) if ([owned.session isEqualToString:session]) [owned finish:nil];
}
- (void)closeAll
{
  NSArray<ElvenStatusRequest *> *requests;
  @synchronized(self) { requests = _pending.allValues; }
  for (ElvenStatusRequest *owned in requests) [self closeSession:owned.session];
}
@end
