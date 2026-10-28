// SPDX-License-Identifier: GPL-3.0-or-later
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <objc/runtime.h>
#include <dlfcn.h>

static NSString *const FKBindingsKey = @"FeatherKrita.bindings.v1";
static char FKControllerKey;
static char FKRouterKey;
static NSArray<NSString *> *FKShapes(void) {
    return @[@"POINTY", @"RECT", @"CUBE", @"MARKER", @"WIDEBRUSH", @"RIBBON"];
}
static NSArray<NSString *> *FKLabels(void) {
    return @[@"Line · POINTY", @"Round · RECT", @"Square · CUBE", @"Flat · MARKER", @"Wide · WIDEBRUSH", @"Ribbon · RIBBON"];
}
static NSString *FKDirectory(void) {
    NSURL *base = [NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask].firstObject;
    NSString *path = [base.path stringByAppendingPathComponent:@"FeatherKrita"];
    [NSFileManager.defaultManager createDirectoryAtPath:path withIntermediateDirectories:YES attributes:nil error:nil];
    return path;
}
static NSDictionary *FKCall(NSDictionary *request) {
    static char *(*call)(const char *);
    static void (*releaseResponse)(char *);
    static void *library;
    if (!call) {
        NSString *path = [NSBundle.mainBundle.bundlePath stringByAppendingPathComponent:@"Frameworks/FeatherKritaEngine.dylib"];
        library = dlopen(path.fileSystemRepresentation, RTLD_NOW | RTLD_LOCAL);
        if (!library) return @{@"ok": @NO, @"error": [NSString stringWithUTF8String:dlerror()] ?: @"Cannot load the brush engine."};
        call = dlsym(library, "FKRequest"); releaseResponse = dlsym(library, "FKFreeResponse");
        if (!call || !releaseResponse) return @{@"ok": @NO, @"error": @"The brush engine API is incomplete."};
    }
    NSError *error;
    NSData *data = [NSJSONSerialization dataWithJSONObject:request options:0 error:&error];
    if (!data) return @{@"ok": @NO, @"error": error.localizedDescription};
    NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    char *raw = call(json.UTF8String);
    if (!raw) return @{@"ok": @NO, @"error": @"Not enough memory for the brush response."};
    NSData *responseData = [[NSString stringWithUTF8String:raw] dataUsingEncoding:NSUTF8StringEncoding];
    releaseResponse(raw);
    id result = responseData ? [NSJSONSerialization JSONObjectWithData:responseData options:0 error:nil] : nil;
    return [result isKindOfClass:NSDictionary.class] ? result : @{@"ok": @NO, @"error": @"Invalid brush engine response."};
}

@interface FKController : NSObject <WKScriptMessageHandlerWithReply, UIDocumentPickerDelegate>
@property(nonatomic, weak) WKWebView *webView;
@property(nonatomic, strong) UIButton *floatingButton;
@property(nonatomic, strong) UIView *panel;
@property(nonatomic, strong) UILabel *statusLabel;
@property(nonatomic, strong) UIButton *importButton;
@property(nonatomic, strong) UIButton *shapeButton;
@property(nonatomic, strong) UIButton *injectButton;
@property(nonatomic, strong) UIButton *restoreButton;
@property(nonatomic, strong) NSMutableDictionary *bindings;
@property(nonatomic, strong) NSMutableDictionary *presets;
@property(nonatomic, copy) NSString *selectedPreset;
@property(nonatomic, copy) NSString *shape;
@property(nonatomic) BOOL engineReady;
@property(nonatomic) CGPoint dragOrigin;
@end

@implementation FKController
- (instancetype)init {
    if ((self = [super init])) {
        _shape = @"POINTY";
        _presets = NSMutableDictionary.dictionary;
        _bindings = [[NSUserDefaults.standardUserDefaults dictionaryForKey:FKBindingsKey] mutableCopy] ?: NSMutableDictionary.dictionary;
        [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(layout) name:UIDeviceOrientationDidChangeNotification object:nil];
    }
    return self;
}
- (void)dealloc { [NSNotificationCenter.defaultCenter removeObserver:self]; [self.floatingButton removeFromSuperview]; [self.panel removeFromSuperview]; }
- (UIViewController *)presenter {
    UIViewController *controller = self.webView.window.rootViewController;
    while (controller.presentedViewController) controller = controller.presentedViewController;
    return controller;
}
- (void)showError:(NSString *)message {
    self.statusLabel.text = message;
    UIAlertController *alert = [UIAlertController alertControllerWithTitle:@"Krita brushes" message:message preferredStyle:UIAlertControllerStyleAlert];
    [alert addAction:[UIAlertAction actionWithTitle:@"OK" style:UIAlertActionStyleCancel handler:nil]];
    [[self presenter] presentViewController:alert animated:YES completion:nil];
}
- (UIButton *)button:(NSString *)title action:(SEL)action {
    UIButton *button = [UIButton buttonWithType:UIButtonTypeSystem];
    [button setTitle:title forState:UIControlStateNormal];
    button.titleLabel.font = [UIFont systemFontOfSize:15 weight:UIFontWeightSemibold];
    button.titleLabel.numberOfLines = 2;
    button.backgroundColor = UIColor.secondarySystemBackgroundColor;
    button.layer.cornerRadius = 10;
    [button addTarget:self action:action forControlEvents:UIControlEventTouchUpInside];
    return button;
}
- (void)showOverlay {
    UIWindow *window = self.webView.window;
    if (!window || self.floatingButton) return;
    self.floatingButton = [UIButton buttonWithType:UIButtonTypeCustom];
    self.floatingButton.frame = CGRectMake(24, 100, 50, 50);
    self.floatingButton.layer.cornerRadius = 25; self.floatingButton.clipsToBounds = YES;
    self.floatingButton.backgroundColor = UIColor.systemBackgroundColor;
    self.floatingButton.accessibilityLabel = @"Krita brush menu";
    UIImage *icon = [UIImage imageWithContentsOfFile:[NSBundle.mainBundle.bundlePath stringByAppendingPathComponent:@"FeatherKrita/menuIcon.png"]];
    [self.floatingButton setImage:icon forState:UIControlStateNormal];
    self.floatingButton.imageView.contentMode = UIViewContentModeScaleAspectFill;
    [self.floatingButton addTarget:self action:@selector(toggle) forControlEvents:UIControlEventTouchUpInside];
    [self.floatingButton addGestureRecognizer:[[UIPanGestureRecognizer alloc] initWithTarget:self action:@selector(drag:)]];
    [window addSubview:self.floatingButton];
    self.panel = [[UIView alloc] initWithFrame:CGRectMake(20, 160, 310, 300)];
    self.panel.backgroundColor = UIColor.systemBackgroundColor; self.panel.layer.cornerRadius = 16;
    self.panel.layer.shadowOpacity = 0.25; self.panel.layer.shadowRadius = 12;
    self.panel.hidden = YES;
    UILabel *title = [[UILabel alloc] initWithFrame:CGRectMake(16, 10, 278, 25)];
    title.text = @"Krita brushes"; title.font = [UIFont boldSystemFontOfSize:19];
    [self.panel addSubview:title];
    self.importButton = [self button:@"1 · Import brush…" action:@selector(importFile)];
    self.shapeButton = [self button:@"2 · Line · POINTY" action:@selector(selectShape)];
    self.injectButton = [self button:@"3 · Inject" action:@selector(inject)];
    self.restoreButton = [self button:@"4 · Restore" action:@selector(restore)];
    NSArray *buttons = @[self.importButton, self.shapeButton, self.injectButton, self.restoreButton];
    for (NSUInteger i = 0; i < buttons.count; i++) {
        UIButton *button = buttons[i]; button.frame = CGRectMake(12, 43 + i * 48, 286, 42);
        [self.panel addSubview:button];
    }
    self.statusLabel = [[UILabel alloc] initWithFrame:CGRectMake(16, 238, 278, 52)];
    self.statusLabel.font = [UIFont systemFontOfSize:12]; self.statusLabel.numberOfLines = 3;
    self.statusLabel.text = @"Import a preset, then select its Feather brush type.";
    [self.panel addSubview:self.statusLabel]; [window addSubview:self.panel];
    [self updateButtons]; [self layout];
}
- (void)layout {
    UIWindow *window = self.webView.window;
    if (!window || !self.floatingButton) return;
    CGRect safe = UIEdgeInsetsInsetRect(window.bounds, window.safeAreaInsets);
    CGPoint center = self.floatingButton.center;
    center.x = MAX(CGRectGetMinX(safe) + 12, MIN(CGRectGetMaxX(safe) - 12, center.x));
    center.y = MAX(CGRectGetMinY(safe) + 25, MIN(CGRectGetMaxY(safe) - 25, center.y));
    self.floatingButton.center = center;
    BOOL edge = center.x < CGRectGetMinX(safe) + 38 || center.x > CGRectGetMaxX(safe) - 38 || center.y < CGRectGetMinY(safe) + 38 || center.y > CGRectGetMaxY(safe) - 38;
    self.floatingButton.alpha = edge ? 0.45 : 1.0;
    CGRect frame = self.panel.frame;
    frame.origin.x = MAX(CGRectGetMinX(safe) + 8, MIN(CGRectGetMaxX(safe) - frame.size.width - 8, center.x - 25));
    frame.origin.y = MAX(CGRectGetMinY(safe) + 8, MIN(CGRectGetMaxY(safe) - frame.size.height - 8, center.y + 35));
    self.panel.frame = frame;
}
- (void)drag:(UIPanGestureRecognizer *)gesture {
    if (gesture.state == UIGestureRecognizerStateBegan) self.dragOrigin = self.floatingButton.center;
    CGPoint delta = [gesture translationInView:self.webView.window];
    self.floatingButton.center = CGPointMake(self.dragOrigin.x + delta.x, self.dragOrigin.y + delta.y);
    [self layout];
}
- (void)toggle { self.panel.hidden = !self.panel.hidden; [self layout]; }
- (BOOL)initializeEngine {
    if (self.engineReady) return YES;
    NSDictionary *response = FKCall(@{@"command": @"initialize", @"storageRoot": [FKDirectory() stringByAppendingPathComponent:@"Resources"], @"resources": [NSBundle.mainBundle.bundlePath stringByAppendingPathComponent:@"FeatherKrita/resources"]});
    if (![response[@"ok"] boolValue]) { [self showError:response[@"error"]]; return NO; }
    self.engineReady = YES;
    NSString *imports = [FKDirectory() stringByAppendingPathComponent:@"Imports"];
    for (NSString *name in [NSFileManager.defaultManager contentsOfDirectoryAtPath:imports error:nil]) {
        NSDictionary *result = FKCall(@{@"command": @"import", @"path": [imports stringByAppendingPathComponent:name]});
        if ([result[@"ok"] boolValue]) for (NSDictionary *p in result[@"presets"]) self.presets[p[@"id"]] = p;
    }
    return YES;
}
- (void)importFile {
    if (![self initializeEngine]) return;
    UIDocumentPickerViewController *picker = [[UIDocumentPickerViewController alloc] initForOpeningContentTypes:@[UTTypeData, UTTypePackage] asCopy:YES];
    picker.delegate = self; picker.allowsMultipleSelection = NO;
    [[self presenter] presentViewController:picker animated:YES completion:nil];
}
- (void)documentPicker:(UIDocumentPickerViewController *)controller didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls {
    NSURL *source = urls.firstObject; if (!source) return;
    BOOL scoped = [source startAccessingSecurityScopedResource];
    NSString *directory = [FKDirectory() stringByAppendingPathComponent:@"Imports"];
    [NSFileManager.defaultManager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:nil];
    NSString *name = [NSString stringWithFormat:@"%@-%@", NSUUID.UUID.UUIDString, source.lastPathComponent];
    NSURL *target = [NSURL fileURLWithPath:[directory stringByAppendingPathComponent:name]];
    NSError *error; BOOL copied = [NSFileManager.defaultManager copyItemAtURL:source toURL:target error:&error];
    if (scoped) [source stopAccessingSecurityScopedResource];
    if (!copied) { [self showError:error.localizedDescription]; return; }
    NSDictionary *response = FKCall(@{@"command": @"import", @"path": target.path});
    if (![response[@"ok"] boolValue]) { [self showError:response[@"error"]]; return; }
    NSArray *presets = response[@"presets"];
    for (NSDictionary *p in presets) self.presets[p[@"id"]] = p;
    if (presets.count == 1) { self.selectedPreset = presets.firstObject[@"id"]; [self updateButtons]; return; }
    UIAlertController *list = [UIAlertController alertControllerWithTitle:@"Choose a preset" message:nil preferredStyle:UIAlertControllerStyleActionSheet];
    for (NSDictionary *p in presets) [list addAction:[UIAlertAction actionWithTitle:p[@"name"] style:UIAlertActionStyleDefault handler:^(UIAlertAction *action) { self.selectedPreset = p[@"id"]; [self updateButtons]; }]];
    [self presentList:list source:self.importButton];
}
- (void)presentList:(UIAlertController *)list source:(UIView *)source {
    [list addAction:[UIAlertAction actionWithTitle:@"Cancel" style:UIAlertActionStyleCancel handler:nil]];
    list.popoverPresentationController.sourceView = source;
    list.popoverPresentationController.sourceRect = source.bounds;
    [[self presenter] presentViewController:list animated:YES completion:nil];
}
- (void)selectShape {
    UIAlertController *list = [UIAlertController alertControllerWithTitle:@"Feather brush type" message:nil preferredStyle:UIAlertControllerStyleActionSheet];
    [FKShapes() enumerateObjectsUsingBlock:^(NSString *shape, NSUInteger i, BOOL *stop) {
        [list addAction:[UIAlertAction actionWithTitle:FKLabels()[i] style:UIAlertActionStyleDefault handler:^(UIAlertAction *action) { self.shape = shape; [self updateButtons]; }]];
    }];
    [self presentList:list source:self.shapeButton];
}
- (void)updateButtons {
    NSString *name = self.selectedPreset ? self.presets[self.selectedPreset][@"name"] : nil;
    [self.importButton setTitle:name ? [@"1 · " stringByAppendingString:name] : @"1 · Import brush…" forState:UIControlStateNormal];
    NSUInteger i = [FKShapes() indexOfObject:self.shape];
    [self.shapeButton setTitle:[@"2 · " stringByAppendingString:FKLabels()[i]] forState:UIControlStateNormal];
    self.injectButton.enabled = name != nil;
    self.restoreButton.enabled = self.bindings[self.shape] != nil;
}
- (void)publishBindings {
    [NSUserDefaults.standardUserDefaults setObject:self.bindings forKey:FKBindingsKey];
    NSData *json = [NSJSONSerialization dataWithJSONObject:self.bindings options:0 error:nil];
    NSString *payload = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
    [self.webView evaluateJavaScript:[NSString stringWithFormat:@"window.FeatherKrita?.setBindings(%@)", payload] completionHandler:nil];
    [self updateButtons];
}
- (void)inject {
    if (!self.selectedPreset || !self.presets[self.selectedPreset]) return;
    self.bindings[self.shape] = self.selectedPreset; [self publishBindings];
    self.statusLabel.text = @"Native Krita brush connected to this Feather type.";
}
- (void)restore {
    [self.bindings removeObjectForKey:self.shape]; [self publishBindings];
    self.statusLabel.text = @"Original Feather brush restored.";
}
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message replyHandler:(void (^)(id, NSString *))reply {
    NSURL *url = message.frameInfo.request.URL;
    if (!message.frameInfo.mainFrame || ![url.scheme isEqualToString:@"local"] || ![url.host isEqualToString:@"app"] || ![message.body isKindOfClass:NSDictionary.class]) { reply(nil, @"Unsupported page."); return; }
    NSDictionary *body = message.body; NSString *command = body[@"command"];
    if (![command isKindOfClass:NSString.class]) { reply(nil, @"Invalid brush command."); return; }
    if ([command isEqualToString:@"ready"]) {
        [self showOverlay];
        if (self.bindings.count && [self initializeEngine]) [self publishBindings];
        reply(@{@"ok": @YES}, nil);
    } else if ([command isEqualToString:@"error"]) {
        if ([body[@"message"] isKindOfClass:NSString.class]) self.statusLabel.text = body[@"message"];
        reply(@{@"ok": @YES}, nil);
    } else if ([command isEqualToString:@"render"] && self.engineReady) {
        NSString *preset = body[@"preset"];
        if (![self.bindings.allValues containsObject:preset]) { reply(nil, @"Brush binding is no longer active."); return; }
        NSDictionary *response = FKCall(body);
        reply(response, nil);
    } else reply(nil, @"The brush engine is not ready.");
}
@end

@interface FKMessageRouter : NSObject <WKScriptMessageHandlerWithReply>
@end
@implementation FKMessageRouter
- (void)userContentController:(WKUserContentController *)content didReceiveScriptMessage:(WKScriptMessage *)message replyHandler:(void (^)(id, NSString *))reply {
    FKController *controller = objc_getAssociatedObject(message.webView, &FKControllerKey);
    if (!controller) { reply(nil, @"The drawing window is no longer available."); return; }
    [controller userContentController:content didReceiveScriptMessage:message replyHandler:reply];
}
@end

static IMP originalInit;
static id FKWebViewInit(id object, SEL selector, CGRect frame, WKWebViewConfiguration *configuration) {
    FKController *controller = [FKController new];
    if (!objc_getAssociatedObject(configuration.userContentController, &FKRouterKey)) {
        FKMessageRouter *router = [FKMessageRouter new];
        [configuration.userContentController addScriptMessageHandlerWithReply:router contentWorld:WKContentWorld.pageWorld name:@"FeatherKrita"];
        objc_setAssociatedObject(configuration.userContentController, &FKRouterKey, router, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    }
    WKWebView *view = ((id (*)(id, SEL, CGRect, WKWebViewConfiguration *))originalInit)(object, selector, frame, configuration);
    controller.webView = view;
    objc_setAssociatedObject(view, &FKControllerKey, controller, OBJC_ASSOCIATION_RETAIN_NONATOMIC);
    return view;
}
__attribute__((constructor)) static void FKInstall(void) {
    dispatch_async(dispatch_get_main_queue(), ^{
        Class cls = NSClassFromString(@"FeatherPro.FullScreenWebView");
        Method method = cls ? class_getInstanceMethod(cls, @selector(initWithFrame:configuration:)) : NULL;
        if (method) originalInit = method_setImplementation(method, (IMP)FKWebViewInit);
    });
}
