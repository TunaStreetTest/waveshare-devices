/*
 * SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
 *
 * SPDX-License-Identifier: Apache-2.0
 */
#include "private/utils.hpp"
#include "boost/chrono.hpp"
#include "boost/thread.hpp"
#include "brookesia/lib_utils/thread_config.hpp"
#include "brookesia/gui_lvgl.hpp"
#include "brookesia/system_super.hpp"
#include "modules/general_services.hpp"
#include "modules/display.hpp"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "brookesia/service_helper/network/wifi.hpp"
#include "microfi/agent.h"

using namespace esp_brookesia;

extern "C" void app_main(void)
{
    BROOKESIA_LOGI("\n\n=== System Example ===\n");

    auto setup_task = []() {
        /* Initialize general services */
        BROOKESIA_CHECK_FALSE_EXIT(
            GeneralServices::get_instance().init(), "Failed to initialize general services"
        );

        /* Start display UI */
        auto &display = Display::get_instance();
        auto display_start_ret = display.start({});
        BROOKESIA_CHECK_FALSE_EXIT(display_start_ret, "Failed to start display");
        /* Start audio services */
        BROOKESIA_CHECK_FALSE_EXIT(
            GeneralServices::get_instance().start_audio_services(), "Failed to start audio services"
        );

        /* Create system instance */
        static std::unique_ptr<system::super::System> system_instance;
        system_instance = std::make_unique<system::super::System>();

        /* Configure system */
        system::super::System::Config config;
        config.core_config.gui_backend = std::make_unique<gui::lvgl::Backend>();
        config.core_config.environment = {
            .width_px = static_cast<int32_t>(display.width()),
            .height_px = static_cast<int32_t>(display.height()),
            .density = 1.0F,
            .font_scale = 1.0F,
            // .language = "zh_CN",
            // .theme_id = "dark",
        };
        // config.core_config.enable_gui_view_debug = true;

        /* Initialize and start system */
        auto init_result = system_instance->init(std::move(config));
        BROOKESIA_CHECK_FALSE_EXIT(init_result, "System init failed: %1%", init_result.error());
        auto start_result = system_instance->start();
        BROOKESIA_CHECK_FALSE_EXIT(start_result, "System start failed: %1%", start_result.error());

        /* Pre-provision WiFi (#188): the on-glass keyboard is unusable for a
         * long PSK, so seed the WiFi service with the LAN credentials from
         * the MicroFi Kconfig. The service persists the AP, so this is a
         * harmless re-set on later boots. Settings can still override. */
        {
            using WifiHelper = service::helper::Wifi;
            if (!WifiHelper::is_available()) {
                BROOKESIA_LOGE("WiFi pre-provision: service not available, skipping");
            } else if (CONFIG_MICROFI_WIFI_SSID[0] == '\0') {
                BROOKESIA_LOGW("WiFi pre-provision: no SSID configured, skipping");
            } else {
                /* A previously saved AP on the wrong subnet wins the boot
                 * reconnect race — evict it before asserting the LAN AP. */
                auto rm = WifiHelper::call_function_sync(
                    WifiHelper::FunctionId::RemoveConnectedAp, "STARLINK");
                BROOKESIA_LOGI("WiFi pre-provision: remove STARLINK -> %1%",
                               rm ? "removed" : rm.error());
                auto set_ap = WifiHelper::call_function_sync(
                    WifiHelper::FunctionId::SetConnectAp,
                    CONFIG_MICROFI_WIFI_SSID, CONFIG_MICROFI_WIFI_PASSWORD);
                BROOKESIA_LOGI("WiFi pre-provision: set '%1%' -> %2%",
                               CONFIG_MICROFI_WIFI_SSID,
                               set_ap ? "ok" : set_ap.error());
                /* Setting the target AP alone does not connect: the service
                 * reaches Started on its own, and an already-Started machine
                 * ignores Start. Connect is the action that joins the
                 * configured AP. */
                auto connect_wifi = WifiHelper::call_function_sync(
                    WifiHelper::FunctionId::TriggerGeneralAction,
                    BROOKESIA_DESCRIBE_TO_STR(WifiHelper::GeneralAction::Connect));
                BROOKESIA_LOGI("WiFi pre-provision: connect -> %1%",
                               connect_wifi ? "ok" : connect_wifi.error());
            }
        }

        /* MicroFi EFM agent (#188 Phase 4): own task so its WiFi-adopt wait
         * never blocks Brookesia setup. Agent tasks outlive this launcher. */
        xTaskCreate([](void*) {
            microfi_agent_start();
            vTaskDelete(nullptr);
        }, "microfi", 8 * 1024, nullptr, 5, nullptr);

        boost::this_thread::sleep_for(boost::chrono::seconds(10));

        BROOKESIA_LOGI("=== System Example Completed ===");
    };
    {
        /* Setup task in a high stack size thread to avoid stack overflow */
        BROOKESIA_THREAD_CONFIG_GUARD({
            .stack_size = 40 * 1024,
        });
        boost::thread(setup_task).detach();
    }
}
