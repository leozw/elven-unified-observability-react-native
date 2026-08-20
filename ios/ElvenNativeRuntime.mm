#import "ElvenNativeRuntime.h"

#import <QuartzCore/QuartzCore.h>
#import <TargetConditionals.h>
#import <UIKit/UIKit.h>
#import <sys/time.h>
#import <sys/utsname.h>

#if __has_include(<MetricKit/MetricKit.h>)
#import <MetricKit/MetricKit.h>
#define ELVEN_HAS_METRICKIT 1
#else
#define ELVEN_HAS_METRICKIT 0
#endif

static const NSUInteger ELVMaxPersistedQueueBytes = 5 * 1024 * 1024;
static const NSUInteger ELVMaxEventAttributes = 64;
static const NSUInteger ELVMaxAttributeLength = 1024;
static const NSUInteger ELVMaxStackLength = 8192;
static const NSTimeInterval ELVAnrThresholdSeconds = 5.0;
static const NSTimeInterval ELVFrameReportIntervalSeconds = 15.0;
static const double ELVSlowFrameMillis = 32.0;
static const double ELVFrozenFrameMillis = 700.0;
static NSTimeInterval ELVNativeImageLoadUnixMillis = 0;

__attribute__((constructor)) static void ELVCaptureNativeImageLoadTime(void)
{
  struct timeval now;
  if (gettimeofday(&now, NULL) == 0) {
    ELVNativeImageLoadUnixMillis =
        ((NSTimeInterval)now.tv_sec * 1000.0) +
        ((NSTimeInterval)now.tv_usec / 1000.0);
  }
}

#if ELVEN_HAS_METRICKIT
@interface ElvenNativeRuntime () <MXMetricManagerSubscriber>
#else
@interface ElvenNativeRuntime ()
#endif

@property(nonatomic, strong) NSMutableArray<NSString *> *events;
@property(nonatomic, strong) NSMutableArray<id> *notificationTokens;
@property(nonatomic, strong) dispatch_queue_t ioQueue;
@property(nonatomic, strong) dispatch_source_t watchdog;
@property(nonatomic, strong, nullable) NSTimer *heartbeatTimer;
@property(nonatomic, strong, nullable) CADisplayLink *displayLink;
@property(nonatomic, copy, nullable) NSString *traceId;
@property(nonatomic, copy, nullable) NSString *spanId;
@property(atomic, assign) BOOL diagnosticsEnabled;
@property(atomic, assign) BOOL active;
@property(atomic, assign) BOOL hangReported;
@property(nonatomic, assign) BOOL metricKitRegistered;
@property(atomic, assign) BOOL captureMetricKitDiagnostics;
@property(atomic, assign) BOOL captureMetricKitMetrics;
@property(atomic, assign) BOOL initialized;
@property(atomic, assign) NSUInteger maxEventQueueSize;
@property(atomic, assign) NSUInteger generation;
@property(nonatomic, assign) NSTimeInterval processStartUnixMillis;
@property(atomic, assign) NSTimeInterval lastHeartbeat;
@property(nonatomic, assign) CFTimeInterval lastFrameTimestamp;
@property(nonatomic, assign) CFTimeInterval framePeriodStartedAt;
@property(nonatomic, assign) NSTimeInterval framePeriodStartedUnixMillis;
@property(nonatomic, assign) NSUInteger frameCount;
@property(nonatomic, assign) NSUInteger slowFrameCount;
@property(nonatomic, assign) NSUInteger frozenFrameCount;
@property(nonatomic, assign) double maximumFrameMillis;
@property(nonatomic, assign) BOOL firstFrameRecorded;

- (void)recordEventWithType:(NSString *)rawType
                       name:(NSString *)name
             durationMillis:(nullable NSNumber *)durationMillis
                 attributes:(nullable NSDictionary<NSString *, id> *)attributes
        timestampUnixMillis:(nullable NSNumber *)timestampUnixMillis;
- (void)recordEventWithType:(NSString *)rawType
                       name:(NSString *)name
             durationMillis:(nullable NSNumber *)durationMillis
                 attributes:(nullable NSDictionary<NSString *, id> *)attributes
        timestampUnixMillis:(nullable NSNumber *)timestampUnixMillis
            explicitTraceId:(nullable NSString *)explicitTraceId
             explicitSpanId:(nullable NSString *)explicitSpanId;
- (NSString *)redactText:(NSString *)value;

@end

@implementation ElvenNativeRuntime

+ (instancetype)shared
{
  static ElvenNativeRuntime *runtime;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    runtime = [[ElvenNativeRuntime alloc] initPrivate];
  });
  return runtime;
}

- (instancetype)initPrivate
{
  self = [super init];
  if (self) {
    _events = [NSMutableArray array];
    _notificationTokens = [NSMutableArray array];
    _ioQueue = dispatch_queue_create("works.elven.observability.io", DISPATCH_QUEUE_SERIAL);
    _maxEventQueueSize = 128;
    _active = YES;
    _processStartUnixMillis = [self readProcessStartUnixMillis];
  }
  return self;
}

+ (NSString *)initializeWithConfiguration:(NSString *)configurationJson
{
  return [[self shared] initializeWithConfiguration:configurationJson];
}

+ (NSArray<NSString *> *)drainEvents
{
  return [[self shared] drainEventsInternal];
}

+ (void)readPersistedQueue:(void (^)(NSString *))completion
{
  [[self shared] readPersistedQueue:completion];
}

+ (void)writePersistedQueue:(NSString *)value
                 completion:(void (^)(BOOL))completion
{
  [[self shared] writePersistedQueue:value completion:completion];
}

+ (void)clearPersistedQueue:(void (^)(BOOL))completion
{
  [[self shared] clearPersistedQueue:completion];
}

+ (BOOL)shutdown
{
  return [[self shared] shutdownInternal];
}

+ (void)setCurrentTraceId:(NSString *)traceId spanId:(NSString *)spanId
{
  [[self shared] setCurrentTraceId:traceId spanId:spanId];
}

+ (void)setDiagnosticsEnabled:(BOOL)enabled
{
  [self shared].diagnosticsEnabled = enabled;
}

+ (NSString *)currentTraceId
{
  @synchronized([self shared]) {
    return [self shared].traceId;
  }
}

+ (NSString *)currentSpanId
{
  @synchronized([self shared]) {
    return [self shared].spanId;
  }
}

+ (void)recordEventWithType:(NSString *)type
                       name:(NSString *)name
             durationMillis:(NSNumber *)durationMillis
                 attributes:(NSDictionary<NSString *,id> *)attributes
{
  [[self shared] recordEventWithType:type
                               name:name
                     durationMillis:durationMillis
                         attributes:attributes
                timestampUnixMillis:nil];
}

+ (void)recordEventWithType:(NSString *)type
                       name:(NSString *)name
             durationMillis:(NSNumber *)durationMillis
                 attributes:(NSDictionary<NSString *,id> *)attributes
                    traceId:(NSString *)traceId
                     spanId:(NSString *)spanId
{
  [[self shared] recordEventWithType:type
                               name:name
                     durationMillis:durationMillis
                         attributes:attributes
                timestampUnixMillis:nil
                    explicitTraceId:traceId
                     explicitSpanId:spanId];
}

- (NSString *)initializeWithConfiguration:(NSString *)configurationJson
{
  [self shutdownInternal];
  NSDictionary *configuration = [self dictionaryFromJson:configurationJson];
  self.diagnosticsEnabled = [configuration[@"diagnosticsEnabled"] boolValue];
  self.maxEventQueueSize = MIN(
      256,
      MAX(8, [configuration[@"maxEventQueueSize"] unsignedIntegerValue] ?: 128));
  self.processStartUnixMillis = [self readProcessStartUnixMillis];
  self.initialized = YES;
  self.active = YES;
  self.generation += 1;
  NSUInteger generation = self.generation;

  BOOL captureLifecycle = configuration[@"captureLifecycle"] == nil ||
      [configuration[@"captureLifecycle"] boolValue];
  BOOL captureNativeCrashes = configuration[@"captureNativeCrashes"] == nil ||
      [configuration[@"captureNativeCrashes"] boolValue];
  BOOL captureAnr = configuration[@"captureAnr"] == nil ||
      [configuration[@"captureAnr"] boolValue];
  BOOL captureFrames = configuration[@"captureFrozenFrames"] == nil ||
      [configuration[@"captureFrozenFrames"] boolValue];
  self.captureMetricKitDiagnostics = captureNativeCrashes;
  self.captureMetricKitMetrics = captureFrames;

  dispatch_async(dispatch_get_main_queue(), ^{
    if (!self.initialized || generation != self.generation) {
      return;
    }
    if (captureLifecycle) {
      [self startLifecycleForGeneration:generation];
    }
    if (captureFrames) {
      [self startFrameMonitor];
    }
    if (captureAnr) {
      [self startAnrMonitorForGeneration:generation];
    }
    if (self.captureMetricKitDiagnostics || self.captureMetricKitMetrics) {
      [self startMetricKit];
    }
  });

  NSData *data = [NSJSONSerialization dataWithJSONObject:[self platformContext]
                                                   options:0
                                                     error:nil];
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @"{}";
}

- (NSArray<NSString *> *)drainEventsInternal
{
  @synchronized(self.events) {
    NSArray<NSString *> *values = [self.events copy];
    [self.events removeAllObjects];
    return values;
  }
}

- (void)readPersistedQueue:(void (^)(NSString *))completion
{
  dispatch_async(self.ioQueue, ^{
    NSURL *fileUrl = [self queueFileUrl];
    NSData *data = [NSData dataWithContentsOfURL:fileUrl
                                         options:NSDataReadingMappedIfSafe
                                           error:nil];
    if (data.length > ELVMaxPersistedQueueBytes) {
      [[NSFileManager defaultManager] removeItemAtURL:fileUrl error:nil];
      completion(@"");
      return;
    }
    completion(data == nil ? @"" :
      ([[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding] ?: @""));
  });
}

- (void)writePersistedQueue:(NSString *)value
                 completion:(void (^)(BOOL))completion
{
  dispatch_async(self.ioQueue, ^{
    NSData *data = [value dataUsingEncoding:NSUTF8StringEncoding];
    if (data.length == 0 || data.length > ELVMaxPersistedQueueBytes) {
      completion(NO);
      return;
    }
    NSError *error = nil;
    BOOL written = [data writeToURL:[self queueFileUrl]
                            options:(NSDataWritingAtomic |
                                     NSDataWritingFileProtectionCompleteUntilFirstUserAuthentication)
                              error:&error];
    if (!written) {
      [self diagnostic:[NSString stringWithFormat:@"Queue write failed: %@",
                                                  error.domain ?: @"unknown"]];
    }
    completion(written);
  });
}

- (void)clearPersistedQueue:(void (^)(BOOL))completion
{
  dispatch_async(self.ioQueue, ^{
    NSURL *fileUrl = [self queueFileUrl];
    if (![[NSFileManager defaultManager] fileExistsAtPath:fileUrl.path]) {
      completion(YES);
      return;
    }
    completion([[NSFileManager defaultManager] removeItemAtURL:fileUrl error:nil]);
  });
}

- (BOOL)shutdownInternal
{
  self.initialized = NO;
  self.generation += 1;
  NSUInteger shutdownGeneration = self.generation;
  void (^cleanup)(void) = ^{
    NSNotificationCenter *center = [NSNotificationCenter defaultCenter];
    for (id token in self.notificationTokens) {
      [center removeObserver:token];
    }
    [self.notificationTokens removeAllObjects];
    [self.displayLink invalidate];
    self.displayLink = nil;
    [self.heartbeatTimer invalidate];
    self.heartbeatTimer = nil;
    if (self.watchdog != nil) {
      dispatch_source_cancel(self.watchdog);
      self.watchdog = nil;
    }
#if ELVEN_HAS_METRICKIT
    if (self.metricKitRegistered) {
      [[MXMetricManager sharedManager] removeSubscriber:self];
      self.metricKitRegistered = NO;
    }
#endif
    if (self.generation == shutdownGeneration) {
      self.captureMetricKitDiagnostics = NO;
      self.captureMetricKitMetrics = NO;
    }
    self.lastFrameTimestamp = 0;
    self.frameCount = 0;
    self.slowFrameCount = 0;
    self.frozenFrameCount = 0;
    self.maximumFrameMillis = 0;
    self.firstFrameRecorded = NO;
  };
  if ([NSThread isMainThread]) {
    cleanup();
  } else {
    dispatch_async(dispatch_get_main_queue(), cleanup);
  }
  @synchronized(self) {
    self.traceId = nil;
    self.spanId = nil;
  }
  return YES;
}

- (void)setCurrentTraceId:(NSString *)traceId spanId:(NSString *)spanId
{
  @synchronized(self) {
    if ([self isValidHexId:traceId length:32] &&
        [self isValidHexId:spanId length:16]) {
      self.traceId = [traceId copy];
      self.spanId = [spanId copy];
    } else {
      self.traceId = nil;
      self.spanId = nil;
    }
  }
}

- (void)startLifecycleForGeneration:(NSUInteger)generation
{
  NSNotificationCenter *center = [NSNotificationCenter defaultCenter];
  id activeToken = [center
      addObserverForName:UIApplicationDidBecomeActiveNotification
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(__unused NSNotification *notification) {
    if (![self isGenerationActive:generation]) return;
    BOOL wasInactive = !self.active;
    self.active = YES;
    if (wasInactive) {
      self.lastFrameTimestamp = 0;
      self.framePeriodStartedAt = CACurrentMediaTime();
      self.framePeriodStartedUnixMillis =
          [NSDate date].timeIntervalSince1970 * 1000.0;
    }
    self.displayLink.paused = NO;
    [self recordEventWithType:@"lifecycle"
                         name:@"app.foreground"
               durationMillis:nil
                   attributes:nil
          timestampUnixMillis:nil];
  }];
  id inactiveToken = [center
      addObserverForName:UIApplicationWillResignActiveNotification
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(__unused NSNotification *notification) {
    if (![self isGenerationActive:generation]) return;
    self.active = NO;
    [self flushFrameMetrics];
    self.displayLink.paused = YES;
    [self recordEventWithType:@"lifecycle"
                         name:@"app.inactive"
               durationMillis:nil
                   attributes:nil
          timestampUnixMillis:nil];
  }];
  id backgroundToken = [center
      addObserverForName:UIApplicationDidEnterBackgroundNotification
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(__unused NSNotification *notification) {
    if (![self isGenerationActive:generation]) return;
    self.active = NO;
    [self recordEventWithType:@"lifecycle"
                         name:@"app.background"
               durationMillis:nil
                   attributes:nil
          timestampUnixMillis:nil];
  }];
  id memoryToken = [center
      addObserverForName:UIApplicationDidReceiveMemoryWarningNotification
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(__unused NSNotification *notification) {
    if (![self isGenerationActive:generation]) return;
    [self recordEventWithType:@"memory"
                         name:@"app.memory.warning"
               durationMillis:nil
                   attributes:nil
          timestampUnixMillis:nil];
  }];
  [self.notificationTokens addObjectsFromArray:@[
    activeToken, inactiveToken, backgroundToken, memoryToken
  ]];
}

- (void)startFrameMonitor
{
  self.framePeriodStartedAt = CACurrentMediaTime();
  self.framePeriodStartedUnixMillis = [NSDate date].timeIntervalSince1970 * 1000.0;
  self.displayLink = [CADisplayLink displayLinkWithTarget:self
                                                 selector:@selector(onDisplayLink:)];
  [self.displayLink addToRunLoop:[NSRunLoop mainRunLoop]
                         forMode:NSRunLoopCommonModes];
}

- (void)onDisplayLink:(CADisplayLink *)displayLink
{
  if (!self.initialized || displayLink != self.displayLink) return;
  if (self.lastFrameTimestamp == 0) {
    if (!self.firstFrameRecorded) {
      self.firstFrameRecorded = YES;
      NSTimeInterval nowMillis = [NSDate date].timeIntervalSince1970 * 1000.0;
      NSNumber *duration = @(MAX(0, nowMillis - self.processStartUnixMillis));
      [self recordEventWithType:@"performance"
                           name:@"app.first_frame"
                 durationMillis:duration
                     attributes:nil
            timestampUnixMillis:@(self.processStartUnixMillis)];
    }
  } else {
    double frameMillis = (displayLink.timestamp - self.lastFrameTimestamp) * 1000.0;
    self.frameCount += 1;
    if (frameMillis >= ELVSlowFrameMillis) self.slowFrameCount += 1;
    if (frameMillis >= ELVFrozenFrameMillis) self.frozenFrameCount += 1;
    self.maximumFrameMillis = MAX(self.maximumFrameMillis, frameMillis);
  }
  self.lastFrameTimestamp = displayLink.timestamp;
  if (CACurrentMediaTime() - self.framePeriodStartedAt >=
      ELVFrameReportIntervalSeconds) {
    [self flushFrameMetrics];
  }
}

- (void)flushFrameMetrics
{
  NSTimeInterval elapsed = MAX(
      0,
      (CACurrentMediaTime() - self.framePeriodStartedAt) * 1000.0);
  if (self.frameCount > 0 &&
      (self.slowFrameCount > 0 || self.frozenFrameCount > 0)) {
    [self recordEventWithType:@"performance"
                         name:@"app.frames"
               durationMillis:@(elapsed)
                   attributes:@{
      @"frame.count": @(self.frameCount),
      @"frame.slow.count": @(self.slowFrameCount),
      @"frame.frozen.count": @(self.frozenFrameCount),
      @"frame.duration.max_ms": @(self.maximumFrameMillis)
    }
          timestampUnixMillis:@(self.framePeriodStartedUnixMillis)];
  }
  self.framePeriodStartedAt = CACurrentMediaTime();
  self.framePeriodStartedUnixMillis = [NSDate date].timeIntervalSince1970 * 1000.0;
  self.frameCount = 0;
  self.slowFrameCount = 0;
  self.frozenFrameCount = 0;
  self.maximumFrameMillis = 0;
}

- (void)startAnrMonitorForGeneration:(NSUInteger)generation
{
  self.lastHeartbeat = CACurrentMediaTime();
  self.hangReported = NO;
  __weak typeof(self) weakSelf = self;
  self.heartbeatTimer = [NSTimer
      scheduledTimerWithTimeInterval:0.5
                             repeats:YES
                               block:^(NSTimer *timer) {
    ElvenNativeRuntime *strongSelf = weakSelf;
    if (strongSelf == nil ||
        timer != strongSelf.heartbeatTimer ||
        ![strongSelf isGenerationActive:generation]) {
      return;
    }
    strongSelf.lastHeartbeat = CACurrentMediaTime();
    strongSelf.hangReported = NO;
  }];
  dispatch_queue_t queue = dispatch_queue_create(
      "works.elven.observability.anr",
      DISPATCH_QUEUE_SERIAL);
  self.watchdog = dispatch_source_create(
      DISPATCH_SOURCE_TYPE_TIMER,
      0,
      0,
      queue);
  dispatch_source_set_timer(
      self.watchdog,
      dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC),
      NSEC_PER_SEC,
      NSEC_PER_MSEC * 100);
  dispatch_source_set_event_handler(self.watchdog, ^{
    if (![self isGenerationActive:generation]) return;
    NSTimeInterval blocked = CACurrentMediaTime() - self.lastHeartbeat;
    if (self.active && blocked >= ELVAnrThresholdSeconds && !self.hangReported) {
      self.hangReported = YES;
      [self recordEventWithType:@"error"
                           name:@"app.hang.realtime"
                 durationMillis:@(blocked * 1000.0)
                     attributes:nil
            timestampUnixMillis:nil];
    }
  });
  dispatch_resume(self.watchdog);
}

- (void)startMetricKit
{
#if ELVEN_HAS_METRICKIT
  if (!self.metricKitRegistered) {
    [[MXMetricManager sharedManager] addSubscriber:self];
    self.metricKitRegistered = YES;
  }
#endif
}

- (BOOL)isGenerationActive:(NSUInteger)generation
{
  return self.initialized && generation == self.generation;
}

#if ELVEN_HAS_METRICKIT
- (void)didReceiveMetricPayloads:(NSArray<MXMetricPayload *> *)payloads
{
  if (!self.captureMetricKitMetrics) return;
  for (MXMetricPayload *payload in payloads) {
    [self recordMetricKitData:[payload JSONRepresentation]
                         type:@"performance"
                         name:@"ios.metrickit.metrics"];
  }
}

- (void)didReceiveDiagnosticPayloads:(NSArray<MXDiagnosticPayload *> *)payloads
{
  if (!self.captureMetricKitDiagnostics) return;
  for (MXDiagnosticPayload *payload in payloads) {
    [self recordMetricKitData:[payload JSONRepresentation]
                         type:@"error"
                         name:@"ios.metrickit.diagnostics"];
  }
}
#endif

- (void)recordMetricKitData:(NSData *)data
                       type:(NSString *)type
                       name:(NSString *)name
{
  NSMutableDictionary *attributes = [@{
    @"metrickit.payload.bytes": @(data.length)
  } mutableCopy];
  if (data.length <= 32 * 1024) {
    id payload = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    if (payload != nil) attributes[@"metrickit.payload"] = payload;
  } else {
    attributes[@"metrickit.payload.truncated"] = @YES;
  }
  [self recordEventWithType:type
                       name:name
             durationMillis:nil
                 attributes:attributes
        timestampUnixMillis:nil];
}

- (void)recordEventWithType:(NSString *)rawType
                       name:(NSString *)name
             durationMillis:(NSNumber *)durationMillis
                 attributes:(NSDictionary<NSString *, id> *)attributes
        timestampUnixMillis:(NSNumber *)timestampUnixMillis
{
  [self recordEventWithType:rawType
                       name:name
             durationMillis:durationMillis
                 attributes:attributes
        timestampUnixMillis:timestampUnixMillis
            explicitTraceId:nil
             explicitSpanId:nil];
}

- (void)recordEventWithType:(NSString *)rawType
                       name:(NSString *)name
             durationMillis:(NSNumber *)durationMillis
                 attributes:(NSDictionary<NSString *, id> *)attributes
        timestampUnixMillis:(NSNumber *)timestampUnixMillis
            explicitTraceId:(NSString *)explicitTraceId
             explicitSpanId:(NSString *)explicitSpanId
{
  if (!self.initialized) return;
  static NSSet<NSString *> *allowedTypes;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    allowedTypes = [NSSet setWithArray:@[
      @"crash", @"error", @"lifecycle", @"performance", @"memory"
    ]];
  });
  NSString *type = [rawType lowercaseString];
  if (![allowedTypes containsObject:type]) type = @"error";
  NSMutableDictionary *event = [@{
    @"id": [NSUUID UUID].UUIDString,
    @"type": type,
    @"name": [self truncate:[self redactText:name ?: @"native.event"] length:128],
    @"timestampUnixMillis": timestampUnixMillis ?:
      @([NSDate date].timeIntervalSince1970 * 1000.0)
  } mutableCopy];
  if (durationMillis != nil) {
    event[@"durationMillis"] = @(MAX(0, durationMillis.doubleValue));
  }
  NSInteger budget = ELVMaxEventAttributes;
  id sanitized = [self sanitizeValue:attributes ?: @{}
                                  key:@"attributes"
                                depth:0
                               budget:&budget];
  if ([sanitized isKindOfClass:[NSDictionary class]] &&
      [sanitized count] > 0) {
    event[@"attributes"] = sanitized;
  }
  if (explicitTraceId != nil || explicitSpanId != nil) {
    if ([self isValidHexId:explicitTraceId length:32] &&
        [self isValidHexId:explicitSpanId length:16]) {
      event[@"traceId"] = explicitTraceId;
      event[@"spanId"] = explicitSpanId;
    }
  } else {
    @synchronized(self) {
      if (self.traceId != nil && self.spanId != nil) {
        event[@"traceId"] = self.traceId;
        event[@"spanId"] = self.spanId;
      }
    }
  }
  if (![NSJSONSerialization isValidJSONObject:event]) return;
  NSData *data = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
  NSString *serialized = [[NSString alloc] initWithData:data
                                                encoding:NSUTF8StringEncoding];
  if (serialized == nil) return;
  @synchronized(self.events) {
    while (self.events.count >= self.maxEventQueueSize) {
      [self.events removeObjectAtIndex:0];
    }
    [self.events addObject:serialized];
  }
}

- (id)sanitizeValue:(id)value
                 key:(NSString *)key
               depth:(NSUInteger)depth
              budget:(NSInteger *)budget
{
  if (value == nil || value == [NSNull null] || *budget <= 0) return nil;
  *budget -= 1;
  if ([self isSensitiveKey:key]) return @"[REDACTED]";
  if ([value isKindOfClass:[NSNumber class]]) return value;
  if ([value isKindOfClass:[NSString class]]) {
    NSUInteger limit = [[key lowercaseString] containsString:@"stack"] ?
        ELVMaxStackLength : ELVMaxAttributeLength;
    return [self truncate:[self redactText:value] length:limit];
  }
  if (depth >= 4) {
    return [self truncate:[self redactText:[value description]]
                   length:ELVMaxAttributeLength];
  }
  if ([value isKindOfClass:[NSDictionary class]]) {
    NSDictionary *dictionary = (NSDictionary *)value;
    NSMutableDictionary *output = [NSMutableDictionary dictionary];
    for (id rawKey in dictionary) {
      if (*budget <= 0 || output.count >= 32) break;
      NSString *childKey = [self truncate:[rawKey description] length:128];
      id child = [self sanitizeValue:dictionary[rawKey]
                                key:childKey
                              depth:depth + 1
                             budget:budget];
      if (child != nil) output[childKey] = child;
    }
    return output;
  }
  if ([value isKindOfClass:[NSArray class]]) {
    NSArray *array = (NSArray *)value;
    NSMutableArray *output = [NSMutableArray array];
    NSUInteger count = MIN((NSUInteger)16, array.count);
    for (id item in [array subarrayWithRange:NSMakeRange(0, count)]) {
      id child = [self sanitizeValue:item key:key depth:depth + 1 budget:budget];
      if (child != nil) [output addObject:child];
      if (*budget <= 0) break;
    }
    return output;
  }
  if ([value isKindOfClass:[NSDate class]]) {
    return @([(NSDate *)value timeIntervalSince1970] * 1000.0);
  }
  return [self truncate:[self redactText:[value description]]
                 length:ELVMaxAttributeLength];
}

- (NSDictionary *)platformContext
{
  NSBundle *bundle = [NSBundle mainBundle];
  return @{
    @"platform": @"ios",
    @"osVersion": [UIDevice currentDevice].systemVersion ?: @"unknown",
    @"deviceModel": [self machineIdentifier],
    @"appVersion": [bundle objectForInfoDictionaryKey:@"CFBundleShortVersionString"] ?: @"0.0.0",
    @"appBuild": [bundle objectForInfoDictionaryKey:@"CFBundleVersion"] ?: @"0",
    @"appBundleId": bundle.bundleIdentifier ?: @"unknown",
    @"isEmulator": @(TARGET_OS_SIMULATOR != 0),
    @"processStartUnixMillis": @(self.processStartUnixMillis)
  };
}

- (NSDictionary *)dictionaryFromJson:(NSString *)value
{
  NSData *data = [value dataUsingEncoding:NSUTF8StringEncoding];
  id object = data == nil ? nil :
      [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  return [object isKindOfClass:[NSDictionary class]] ? object : @{};
}

- (NSURL *)queueFileUrl
{
  NSFileManager *manager = [NSFileManager defaultManager];
  NSURL *base = [[manager URLsForDirectory:NSApplicationSupportDirectory
                                 inDomains:NSUserDomainMask] firstObject] ?:
      [NSURL fileURLWithPath:NSTemporaryDirectory() isDirectory:YES];
  NSURL *directory = [base URLByAppendingPathComponent:@"ElvenObservability"
                                           isDirectory:YES];
  [manager createDirectoryAtURL:directory
    withIntermediateDirectories:YES
                     attributes:@{
    NSFileProtectionKey: NSFileProtectionCompleteUntilFirstUserAuthentication
  }
                          error:nil];
  [directory setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
  return [directory URLByAppendingPathComponent:@"queue-v1.json"];
}

- (NSTimeInterval)readProcessStartUnixMillis
{
  return ELVNativeImageLoadUnixMillis > 0 ?
      ELVNativeImageLoadUnixMillis :
      [NSDate date].timeIntervalSince1970 * 1000.0;
}

- (NSString *)machineIdentifier
{
  struct utsname systemInfo;
  uname(&systemInfo);
  NSString *machine = [NSString stringWithCString:systemInfo.machine
                                          encoding:NSUTF8StringEncoding];
  return [self truncate:machine ?: [UIDevice currentDevice].model length:128];
}

- (BOOL)isValidHexId:(NSString *)value length:(NSUInteger)length
{
  if (value.length != length ||
      [value stringByTrimmingCharactersInSet:[NSCharacterSet characterSetWithCharactersInString:@"0"]].length == 0) {
    return NO;
  }
  NSCharacterSet *invalid = [[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"] invertedSet];
  return [value rangeOfCharacterFromSet:invalid].location == NSNotFound;
}

- (BOOL)isSensitiveKey:(NSString *)key
{
  NSString *normalized = [key lowercaseString];
  for (NSString *candidate in @[
    @"authorization", @"cookie", @"password", @"secret", @"token",
    @"api_key", @"apikey", @"client_secret", @"credit_card", @"card.number",
    @"request.body", @"response.body", @"email", @"phone", @"cpf", @"cnpj"
  ]) {
    if ([normalized containsString:candidate]) return YES;
  }
  return NO;
}

- (NSString *)redactText:(NSString *)value
{
  static NSArray<NSRegularExpression *> *expressions;
  static NSArray<NSString *> *replacements;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{
    NSRegularExpressionOptions options = NSRegularExpressionCaseInsensitive;
    expressions = @[
      [NSRegularExpression regularExpressionWithPattern:
          @"\\b([a-z][a-z0-9+.-]*://)[^@\\s/:]+:[^@\\s]+@"
                                                options:options
                                                  error:nil],
      [NSRegularExpression regularExpressionWithPattern:
          @"\\b(bearer|basic)\\s+[a-z0-9._~+/=-]+"
                                                options:options
                                                  error:nil],
      [NSRegularExpression regularExpressionWithPattern:
          @"\\beyJ[a-z0-9_-]{8,}\\.[a-z0-9_-]{8,}\\.[a-z0-9_-]{8,}\\b"
                                                options:options
                                                  error:nil],
      [NSRegularExpression regularExpressionWithPattern:
          @"\\b(password|passwd|pwd|secret|token|api[-_]?key|authorization|cookie|set-cookie)\\b\\s*[:=]\\s*(?:\"[^\"]*\"|'[^']*'|[^\\s,;&]+)"
                                                options:options
                                                  error:nil],
      [NSRegularExpression regularExpressionWithPattern:
          @"\\b[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\\b"
                                                options:options
                                                  error:nil]
    ];
    replacements = @[
      @"$1[REDACTED]@",
      @"$1 [REDACTED]",
      @"[REDACTED]",
      @"$1=[REDACTED]",
      @"[REDACTED]"
    ];
  });

  NSString *redacted = value ?: @"";
  for (NSUInteger index = 0; index < expressions.count; index += 1) {
    NSRegularExpression *expression = expressions[index];
    redacted = [expression stringByReplacingMatchesInString:redacted
                                                    options:0
                                                      range:NSMakeRange(0, redacted.length)
                                               withTemplate:replacements[index]];
  }
  return redacted;
}

- (NSString *)truncate:(NSString *)value length:(NSUInteger)length
{
  if (value.length <= length) return value;
  NSUInteger markerLength = @"[TRUNCATED]".length;
  NSUInteger contentLength = length > markerLength ? length - markerLength : 0;
  return [[value substringToIndex:contentLength] stringByAppendingString:@"[TRUNCATED]"];
}

- (void)diagnostic:(NSString *)message
{
  if (self.diagnosticsEnabled) {
    NSLog(@"[ElvenObservability] %@", message);
  }
}

@end
