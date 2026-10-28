// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#ifdef __cplusplus
extern "C" {
#endif
// All calls run on the host UI thread. The result is UTF-8 JSON allocated by
// this library. The caller releases it with FKFreeResponse, including errors.
__attribute__((visibility("default"))) char *FKRequest(const char *json);
__attribute__((visibility("default"))) void FKFreeResponse(char *response);
#ifdef __cplusplus
}
#endif
