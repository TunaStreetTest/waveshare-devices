// agent_status_tile.cpp -- #185: read-only MicroFi agent status tile.
//
// Native ESP-Brookesia v0.8 app. One launcher tile ("Agent"), one screen:
// black background, white text, no controls. Shows the guest MicroFi EFM
// agent's identity and health, refreshed once a second by an app timer.
//
// GUI: GuiRootKind::JsonString -- the whole JSON UI document (one viewScreen
// + one screenFlow) is embedded below, so the app needs no staged resource
// package on the littlefs data partition. Labels are updated through
// AppContext::gui().set_text() by absolute path ("/microfi_status/<id>").
//
// Data sources (all read-only):
//   - microfi::agent_id() / manifest_hash()          identity + manifest
//   - microfi::c2_last_heartbeat_age_ms()/count()    heartbeat (additive
//     getters added to MicroFi's c2_client for this tile)
//   - microfi::FlowEngine::instance()                flow id + graph shape
//   - esp_wifi / esp_netif                           SSID + IP (the agent
//     adopts the Brookesia-owned WiFi on this SKU)
//   - xTaskGetHandle("microfi-c2"/"microfi-engine")  task liveness
//   - CONFIG_MICROFI_AGENT_CLASS / _C2_HEARTBEAT_URL class + EFM URL

#include <cinttypes>
#include <cstdio>
#include <cstring>
#include <memory>
#include <string>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_wifi.h"
#include "esp_netif.h"
#include "sdkconfig.h"

#include "brookesia/system_core.hpp"

#include "microfi/agent_id.h"
#include "microfi/c2_client.h"
#include "microfi/flow_engine.h"
#include "microfi/manifest.h"

namespace esp_brookesia::app::agent_status {

namespace {

constexpr const char *APP_ID = "microfi.agent.status";
constexpr const char *APP_NAME = "Agent";
constexpr const char *SCREEN_ID = "microfi_status";
constexpr const char *FLOW_ID = "microfi_status_flow";
constexpr const char *REFRESH_TIMER_NAME = "microfi.status.refresh";
constexpr int REFRESH_INTERVAL_MS = 1000;

// FlowEngine boots with this until EFM pushes a real flow definition.
constexpr const char *ZERO_UUID = "00000000-0000-0000-0000-000000000000";

// The whole GUI document, embedded-assets form (see
// docs/en/gui/interface/json_ui/document/root.rst): one screen of read-only
// labels in a flex column, plus the single-screen flow the descriptor mounts.
constexpr const char *ROOT_JSON = R"JSON({
    "version": "0.1.1",
    "assets": [
        {
            "type": "viewScreen",
            "id": "microfi_status",
            "commonProps": {"clickable": false, "scrollable": true},
            "style": {"bgColor": "#000000", "padding": "14dp"},
            "layout": {"type": "flex", "flexFlow": "column", "mainAlign": "start", "crossAlign": "start", "gap": "7dp"},
            "children": [
                {"type": "label", "id": "title", "labelProps": {"text": "MicroFi Agent"},
                 "style": {"textColor": "#00d18f", "fontSize": 18},
                 "placement": {"mode": "flow", "width": "match"}},
                {"type": "label", "id": "l_id", "labelProps": {"text": "id: -"},
                 "style": {"textColor": "#ffffff", "fontSize": 14},
                 "placement": {"mode": "flow", "width": "match"}},
                {"type": "label", "id": "l_class", "labelProps": {"text": "class: -"},
                 "style": {"textColor": "#ffffff", "fontSize": 14},
                 "placement": {"mode": "flow", "width": "match"}},
                {"type": "label", "id": "l_wifi", "labelProps": {"text": "wifi: -"},
                 "style": {"textColor": "#ffffff", "fontSize": 14},
                 "placement": {"mode": "flow", "width": "match"}},
                {"type": "label", "id": "l_ip", "labelProps": {"text": "ip: -"},
                 "style": {"textColor": "#ffffff", "fontSize": 14},
                 "placement": {"mode": "flow", "width": "match"}},
                {"type": "label", "id": "l_efm", "labelProps": {"text": "efm: -"},
                 "style": {"textColor": "#ffffff", "fontSize": 14},
                 "placement": {"mode": "flow", "width": "match"}},
                {"type": "label", "id": "l_manifest", "labelProps": {"text": "manifest: -"},
                 "style": {"textColor": "#ffffff", "fontSize": 14},
                 "placement": {"mode": "flow", "width": "match"}},
                {"type": "label", "id": "l_flow", "labelProps": {"text": "flow: -"},
                 "style": {"textColor": "#ffffff", "fontSize": 14},
                 "placement": {"mode": "flow", "width": "match"}},
                {"type": "label", "id": "l_hb", "labelProps": {"text": "heartbeat: -"},
                 "style": {"textColor": "#ffffff", "fontSize": 14},
                 "placement": {"mode": "flow", "width": "match"}},
                {"type": "label", "id": "l_tasks", "labelProps": {"text": "tasks: -"},
                 "style": {"textColor": "#ffffff", "fontSize": 14},
                 "placement": {"mode": "flow", "width": "match"}}
            ]
        },
        {
            "type": "screenFlow",
            "id": "microfi_status_flow",
            "initial": "microfi_status",
            "screens": ["microfi_status"],
            "transitions": []
        }
    ]
})JSON";

std::string label_path(const char *label_id)
{
    return std::string("/") + SCREEN_ID + "/" + label_id;
}

} // namespace

class AgentStatusApp final : public system::core::IApp {
public:
    system::core::AppManifest get_manifest() const override
    {
        return {
            .id = APP_ID,
            .name = APP_NAME,
            .localized_names = {{"en", APP_NAME}},
            .version = "0.1.0",
            .kind = system::core::AppKind::Native,
            // Was true, which put a SECOND "Agent" entry in the launcher: this
            // native tile (drawn as a text-fallback square, since it ships no
            // icon) sitting next to the real tunastreet.agent runtime app. Two
            // tiles with the same name, one of them a stub -- "remove the old
            // agent". The tile keeps working as a debug surface for anything
            // that needs the in-process microfi:: symbols; it just no longer
            // claims a slot on the home screen.
            .visible = false,
            .preload_dom = false,
            // No image icon: with icon_id and icon_path both empty the core
            // skips icon-resource registration and the super launcher renders
            // its built-in text-fallback tile from the app name ("Agent").
            .icon_id = "",
            .supported_systems = {},
            .icon_path = "",
            .runtime_type = runtime::BackendType::Unknown,
            .app_path = {},
            .entry = {},
            .resource_dir = {},
            .arguments = {},
        };
    }

    system::core::AppGuiDescriptor get_gui_descriptor() const override
    {
        return {
            .root_kind = system::core::GuiRootKind::JsonString,
            .root = ROOT_JSON,
            .resources = {},
            .screen_flows = {
                system::core::GuiScreenFlowEntry{
                    .screen_flow = FLOW_ID,
                    .layer = system::core::GuiAppLayer::AppDefault,
                },
            },
        };
    }

    std::expected<void, std::string> on_start(system::core::AppContext &context) override
    {
        refresh(context);
        auto timer = context.timer().start_periodic(REFRESH_TIMER_NAME, REFRESH_INTERVAL_MS);
        if (timer) {
            refresh_timer_id_ = *timer;
        }
        // A failed timer only freezes the numbers; the snapshot is still useful.
        return {};
    }

    std::expected<void, std::string> on_stop(system::core::AppContext &context) override
    {
        if (refresh_timer_id_ != system::core::INVALID_TIMER_ID) {
            (void)context.timer().stop(refresh_timer_id_);
            refresh_timer_id_ = system::core::INVALID_TIMER_ID;
        }
        return {};
    }

    std::expected<void, std::string> on_timer(
        system::core::AppContext &context,
        system::core::TimerId timer_id,
        std::string_view /*name*/
    ) override
    {
        if (timer_id == refresh_timer_id_) {
            refresh(context);
        }
        return {};
    }

private:
    static void set_line(system::core::AppContext &context, const char *label_id, const std::string &text)
    {
        (void)context.gui().set_text(label_path(label_id), text);
    }

    static void refresh(system::core::AppContext &context)
    {
        char buf[128];

        // Identity. agent_id()/manifest_hash() return "" until the agent
        // task has run its init path; show a placeholder until then.
        const char *id = microfi::agent_id();
        set_line(context, "l_id", std::string("id: ") + ((id != nullptr && id[0] != '\0') ? id : "(starting)"));
        set_line(context, "l_class", "class: " CONFIG_MICROFI_AGENT_CLASS);

        // WiFi SSID + IP: the agent adopts the Brookesia-owned station, so
        // read esp_wifi/esp_netif directly instead of going through MicroFi.
        std::string wifi_line = "wifi: down";
        wifi_ap_record_t ap = {};
        if (esp_wifi_sta_get_ap_info(&ap) == ESP_OK) {
            wifi_line = std::string("wifi: ") + reinterpret_cast<const char *>(ap.ssid);
        }
        set_line(context, "l_wifi", wifi_line);

        std::string ip_line = "ip: -";
        esp_netif_t *sta_netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
        if (sta_netif != nullptr) {
            esp_netif_ip_info_t ip = {};
            if (esp_netif_get_ip_info(sta_netif, &ip) == ESP_OK && ip.ip.addr != 0) {
                std::snprintf(buf, sizeof(buf), "ip: " IPSTR, IP2STR(&ip.ip));
                ip_line = buf;
            }
        }
        set_line(context, "l_ip", ip_line);

        set_line(context, "l_efm", "efm: " CONFIG_MICROFI_C2_HEARTBEAT_URL);

        // Manifest hash (first 16 of the 64 hex chars; enough to compare
        // against EFM's agent-manifest view without wrapping three lines).
        const char *hash = microfi::manifest_hash();
        if (hash != nullptr && hash[0] != '\0') {
            std::snprintf(buf, sizeof(buf), "manifest: %.16s", hash);
            set_line(context, "l_manifest", buf);
        } else {
            set_line(context, "l_manifest", "manifest: (pending)");
        }

        // Flow: FlowDef carries no display name, only the UUID EFM assigned,
        // so show the short id plus the graph shape. Zero UUID = nothing
        // pushed yet (boot-default GenerateFlowFile -> LogAttribute graph).
        auto &engine = microfi::FlowEngine::instance();
        const char *flow_id = engine.flow_id();
        if (flow_id == nullptr || std::strcmp(flow_id, ZERO_UUID) == 0) {
            set_line(context, "l_flow", "flow: none");
        } else {
            std::snprintf(
                buf, sizeof(buf), "flow: %.8s (%u nodes, %u conns)",
                flow_id,
                static_cast<unsigned>(engine.node_count()),
                static_cast<unsigned>(engine.conn_count())
            );
            set_line(context, "l_flow", buf);
        }

        // Heartbeat age (additive getters in MicroFi's c2_client, #185).
        const int64_t age_ms = microfi::c2_last_heartbeat_age_ms();
        if (age_ms < 0) {
            set_line(context, "l_hb", "heartbeat: none yet");
        } else {
            std::snprintf(
                buf, sizeof(buf), "heartbeat: %llds ago (#%llu)",
                static_cast<long long>(age_ms / 1000),
                static_cast<unsigned long long>(microfi::c2_heartbeat_count())
            );
            set_line(context, "l_hb", buf);
        }

        // Task liveness by FreeRTOS task name (names from c2_client.cpp /
        // flow_engine.cpp xTaskCreate calls). O(tasks) walk, fine at 1 Hz.
        const bool c2_alive = xTaskGetHandle("microfi-c2") != nullptr;
        const bool engine_alive = xTaskGetHandle("microfi-engine") != nullptr;
        std::snprintf(
            buf, sizeof(buf), "tasks: c2 %s / engine %s",
            c2_alive ? "yes" : "no",
            engine_alive ? "yes" : "no"
        );
        set_line(context, "l_tasks", buf);
    }

    system::core::TimerId refresh_timer_id_ = system::core::INVALID_TIMER_ID;
};

class AgentStatusAppProvider final : public system::core::IAppProvider {
public:
    system::core::AppManifest get_manifest() const override
    {
        return AgentStatusApp().get_manifest();
    }

    std::shared_ptr<system::core::IApp> create_app() override
    {
        return std::make_shared<AgentStatusApp>();
    }
};

BROOKESIA_SYSTEM_CORE_APP_PROVIDER_REGISTER_WITH_SYMBOL(
    AgentStatusAppProvider,
    APP_ID,
    agent_status_tile_provider_symbol
);

} // namespace esp_brookesia::app::agent_status
