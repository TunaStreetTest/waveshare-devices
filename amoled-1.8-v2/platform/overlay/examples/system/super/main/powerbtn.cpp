/*
 * SPDX-License-Identifier: Apache-2.0
 *
 * Power-button power-off (#265). Holding the power button did nothing on the
 * battery boards: Brookesia ships no software shutdown path, and the AXP2101
 * hardware OFFLEVEL long-press was not turning these boards off. That is the
 * one control a battery device most needs.
 *
 * The fix consumes the PMIC's own signal. The AXP2101 latches a "power key
 * long press" event bit in its IRQ-status register when PWRON is held past the
 * configured long-press time (REG 0x27, set in the board's power_manager_init).
 * We poll that latch and, on a long press, issue the AXP2101 soft power-off
 * (REG 0x10 bit0), which drops DC1 -- the ESP32 rail -- so the board actually
 * powers down on battery. On USB the PMU re-powers, so there the same hold
 * reads as a reboot rather than a true off; on battery it is a true off.
 *
 * Same board-driver reuse as battlog.cpp: the AXP2101 register work lives in
 * the board's power_manager.c (CUSTOM_DEVICE_IMPLEMENT), so we resolve its live
 * handle by name via esp_board_manager and forward-declare exactly the
 * prototypes we call rather than fighting the include path.
 */
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_err.h"
#include "esp_board_device.h"

#include "powerbtn.h"

/* Defined in the board's power_manager.c (CUSTOM_DEVICE_IMPLEMENT). */
extern "C" {
esp_err_t power_manager_power_off(void *device_handle);
esp_err_t power_manager_clear_power_key(void *device_handle);
esp_err_t power_manager_poll_power_key(void *device_handle, bool *long_pressed);
}

static const char *TAG = "POWERBTN";

/* Fast enough that a deliberate long-press never feels laggy, cheap enough that
 * it is invisible next to the 15 s battlog / 1 s battery reads on the same bus. */
#define POWERBTN_POLL_MS 150

static void powerbtn_task(void *arg)
{
    (void)arg;

    /* Resolve the AXP2101 handle. The board manager auto-inits devices at boot,
     * but this task may race that, so retry a few seconds before giving up
     * (same pattern as battlog). */
    void *pm = nullptr;
    for (int i = 0; i < 30 && pm == nullptr; i++) {
        if (esp_board_device_get_handle("axp2101_power_manager", &pm) != ESP_OK) {
            pm = nullptr;
            vTaskDelay(pdMS_TO_TICKS(1000));
        }
    }
    if (pm == nullptr) {
        ESP_LOGE(TAG, "AXP2101 handle unavailable; power-button off disabled");
        vTaskDelete(nullptr);
        return;
    }

    /* Drop any press latched during boot so we do not power off immediately. */
    (void)power_manager_clear_power_key(pm);
    ESP_LOGI(TAG, "PWRON long-press power-off armed");

    for (;;) {
        bool long_pressed = false;
        esp_err_t err = power_manager_poll_power_key(pm, &long_pressed);
        if (err == ESP_OK && long_pressed) {
            ESP_LOGW(TAG, "PWRON long press -> powering off");
            (void)power_manager_power_off(pm);
            /* On battery the rail is gone before this returns. On USB the PMU
             * re-powers, so give it a beat and re-arm rather than spinning off
             * commands. */
            vTaskDelay(pdMS_TO_TICKS(1000));
            (void)power_manager_clear_power_key(pm);
        }
        vTaskDelay(pdMS_TO_TICKS(POWERBTN_POLL_MS));
    }
}

void powerbtn_start(void)
{
    xTaskCreate(powerbtn_task, "powerbtn", 3 * 1024, nullptr, 6, nullptr);
}
