/*
 * SPDX-License-Identifier: Apache-2.0
 */
#pragma once

#ifdef __cplusplus
extern "C" {
#endif

/* Start the PWRON long-press power-off monitor (#265). Runs on every board --
 * true off on battery boards, reboot on the USB-only board (see main.cpp). */
void powerbtn_start(void);

#ifdef __cplusplus
}
#endif
