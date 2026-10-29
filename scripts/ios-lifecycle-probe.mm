#import <Foundation/Foundation.h>
#import "../ios/ElvenNativeRuntime.h"

static void Check(BOOL passed, NSString *message) {
  if (!passed) { fprintf(stderr, "%s\n", message.UTF8String); exit(1); }
}

static void Pump(BOOL (^finished)(void)) {
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:5];
  while (!finished() && deadline.timeIntervalSinceNow > 0) {
    [[NSRunLoop currentRunLoop] runMode:NSDefaultRunLoopMode beforeDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
  }
  Check(finished(), @"Native lifecycle probe timed out");
}

static void Open(NSString *session) {
  NSString *config = [NSString stringWithFormat:@"{\"sessionId\":\"%@\",\"captureLifecycle\":false,\"captureNativeCrashes\":false,\"captureAnr\":false,\"captureFrozenFrames\":false}", session];
  Check(![[ElvenNativeRuntime initializeWithConfiguration:config] isEqualToString:@"{}"], @"Native session was rejected");
}

static BOOL Write(NSString *session) {
  __block BOOL done = NO, accepted = NO;
  [ElvenNativeRuntime writePersistedQueue:[NSString stringWithFormat:@"{\"ownerGeneration\":\"%@\",\"schemaVersion\":2,\"provenance\":\"probe\",\"items\":[]}", session]
                              completion:^(BOOL result) { dispatch_async(dispatch_get_main_queue(), ^{ accepted = result; done = YES; }); }];
  Pump(^BOOL { return done; });
  return accepted;
}

static NSString *Read(void) {
  __block NSString *value = nil;
  [ElvenNativeRuntime readPersistedQueue:^(NSString *result) { dispatch_async(dispatch_get_main_queue(), ^{ value = result; }); }];
  Pump(^BOOL { return value != nil; });
  return value;
}

static BOOL Close(NSString *session) {
  __block BOOL done = NO, purged = NO;
  [ElvenNativeRuntime closeSession:session purge:YES completion:^(BOOL result) { dispatch_async(dispatch_get_main_queue(), ^{ purged = result; done = YES; }); }];
  Pump(^BOOL { return done; });
  return purged;
}

int main(void) {
  @autoreleasepool {
    Open(@"ios-probe-a");
    Check(Write(@"ios-probe-a"), @"Current write rejected");
    Check(Read().length > 0, @"Persisted queue missing");
    Check(Close(@"ios-probe-a"), @"Purge not acknowledged");
    Check(!Write(@"ios-probe-a"), @"Closed session wrote after purge");
    Open(@"ios-probe-b");
    Check(Read().length == 0, @"Purged queue was restored");
    Check(Write(@"ios-probe-b"), @"Replacement write rejected");
    Check(!Close(@"ios-probe-a"), @"Old cleanup closed the new owner");
    Check(Read().length > 0, @"Old cleanup erased the new queue");
    Check(Close(@"ios-probe-b"), @"Replacement purge failed");
    puts("ELVEN_IOS_NATIVE_LIFECYCLE_STORAGE_OK");
  }
  return 0;
}
