#pragma once

#include <stdbool.h>
#include "driver/i2c_master.h"
#include "axp2101_power_manager.h"

#ifdef __cplusplus
extern "C" {
#endif  /* __cplusplus */

typedef enum {
    POWER_MANAGER_FEATURE_MIC,
} power_manager_feature_t;

typedef struct {
    i2c_master_dev_handle_t pm_handle;  /*!< I2C device handle for AXP2101 power management unit */
} power_manager_handle_t;

int power_manager_init(void *config, int cfg_size, void **device_handle);

int power_manager_deinit(void *device_handle);

esp_err_t power_manager_enable(void *device_handle, power_manager_feature_t feature);

/* Power-off / power-button support (#265). Brookesia has no software shutdown
 * path, and the AXP2101 hardware OFFLEVEL long-press was not turning the
 * battery boards off. power_off issues the AXP2101 soft power-off (REG 0x10
 * bit0), which drops DC1 -- the ESP32 rail -- so the board actually powers
 * down on battery. poll/clear consume the PMIC's own latched PWRON long-press
 * event so a held power button drives that off. */
esp_err_t power_manager_power_off(void *device_handle);
esp_err_t power_manager_clear_power_key(void *device_handle);
esp_err_t power_manager_poll_power_key(void *device_handle, bool *long_pressed);

#ifdef __cplusplus
}
#endif  /* __cplusplus */
