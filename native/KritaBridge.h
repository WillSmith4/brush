// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#ifdef __cplusplus
extern "C" {
#endif
// Request entry points run on the host UI thread. The result is UTF-8 JSON allocated by
// this library. The caller releases it with FKFreeResponse, including errors.
__attribute__((visibility("default"))) char *FKRequest(const char *json);
// Completion runs once on the UI thread; its JSON is borrowed for that call.
typedef void (*FKRenderCompletion)(const char *json, void *context);
__attribute__((visibility("default"))) void FKRenderAsync(const char *json, FKRenderCompletion completion, void *context);
__attribute__((visibility("default"))) void FKFreeResponse(char *response);
#ifdef __cplusplus
}
#endif
