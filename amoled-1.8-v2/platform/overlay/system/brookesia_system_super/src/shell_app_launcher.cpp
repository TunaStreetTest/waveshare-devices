/*
 * SPDX-FileCopyrightText: 2026 Espressif Systems (Shanghai) CO LTD
 *
 * SPDX-License-Identifier: Apache-2.0
 */
/*
 * Overlay of esp-brookesia's shell launcher for the Waveshare
 * ESP32-S3-Touch-AMOLED-1.8 V2.
 *
 * THREE DELTAS FROM UPSTREAM (#220 -- "scrolling the launcher scrambles the
 * tiles", plus Steven's "make 3 tiles wide"). Everything else is verbatim.
 *
 * 1. ONE source of truth for the grid metrics. Upstream hardcodes
 *    LAUNCHER_ITEM_WIDTH/HEIGHT = 112 and LAUNCHER_ITEM_GAP = 18 here and
 *    computes every tile's x/y from them, while the tile RENDERS at whatever
 *    constants/portrait.json declares. Two independent sources of truth that
 *    agree only by coincidence -- and the reason portrait.json carries a
 *    "DO NOT change launcherItemWidth/Height/Gap here" warning. They are now
 *    READ from the shell constants (ui.content.metric.launcherItem*), with
 *    the upstream numbers as the fallback if the lookup ever fails, so the
 *    column count is a one-line JSON change forever after.
 *
 * 2. content_height is seeded from the SCROLL VIEWPORT, not the content
 *    container. Upstream seeds it from `content` (406px tall) and hands it to
 *    a grid_stage whose viewport is 388px, so the launcher was scrollable by
 *    ~18px even when every tile fitted. Now it is max(viewport, tile extent).
 *
 * 3. grid_stage's `scrollable` is bound and set only on a real overflow.
 *    Combined with 3 columns (portrait.json), 9 tiles fit without scrolling
 *    and the panel currently shows 7 -- so on this device the launcher does
 *    not scroll at all, which is the deliberate answer to the scramble: its
 *    root cause is still unidentified, and this removes the container it
 *    lives in rather than claiming a diagnosis nobody has. A 10th app puts
 *    the scroll (and the unexplained scramble) back.
 *
 * NOT changed, and worth knowing: launcher ORDER is `System::list_apps()`,
 * which walks `std::map<AppId, AppRecord>` -- ascending app id, i.e. install
 * order. It is deterministic, it is not alphabetical, and no manifest field
 * influences it.
 */
#include <algorithm>
#include <cstdlib>

#include "brookesia/system_super/macro_configs.h"
#if !BROOKESIA_SYSTEM_SUPER_ENABLE_DEBUG_LOG
#   define BROOKESIA_LOG_DISABLE_DEBUG_TRACE 1
#endif

#include <algorithm>
#include <array>
#include <chrono>
#include <cctype>
#include <cstdlib>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "private/shell_app.hpp"
#include "private/system_constants.hpp"
#include "private/utils.hpp"

#if BROOKESIA_SYSTEM_SUPER_ENABLE_PROFILE_LOG
#   define SYSTEM_SUPER_PROFILE_LOGI(...) BROOKESIA_LOGI(__VA_ARGS__)
#else
#   define SYSTEM_SUPER_PROFILE_LOGI(...) do { if (false) { BROOKESIA_LOGI(__VA_ARGS__); } } while (0)
#endif

namespace esp_brookesia::system::super {
namespace {

// Fallbacks only -- the live values come from the shell constants (delta 1).
// These are upstream's numbers, kept so a failed lookup degrades to upstream
// behaviour instead of a zero-width grid.
inline constexpr int32_t LAUNCHER_ITEM_WIDTH_DEFAULT = 112;
inline constexpr int32_t LAUNCHER_ITEM_HEIGHT_DEFAULT = 112;
inline constexpr int32_t LAUNCHER_ITEM_GAP_DEFAULT = 18;

inline constexpr const char *LAUNCHER_ITEM_WIDTH_CONSTANT = "ui.content.metric.launcherItemWidth";
inline constexpr const char *LAUNCHER_ITEM_HEIGHT_CONSTANT = "ui.content.metric.launcherItemHeight";
inline constexpr const char *LAUNCHER_ITEM_GAP_CONSTANT = "ui.content.metric.launcherItemGap";
inline constexpr const char *LAUNCHER_CONTENT_Y_CONSTANT = "ui.content.metric.y";
inline constexpr const char *LAUNCHER_GRID_TOP_CONSTANT = "ui.content.metric.launcherGridTop";
inline constexpr int32_t LAUNCHER_CONTENT_Y_DEFAULT = 42;
inline constexpr int32_t LAUNCHER_GRID_TOP_DEFAULT = 18;

// Paging gesture thresholds (px, delta 4). A press that drifts DRIFT px
// sideways is a swipe, not a tap -- its tile click is dropped. A release at
// least FLIP px from its press point flips the page.
inline constexpr int32_t LAUNCHER_SWIPE_DRIFT_PX = 18;
inline constexpr int32_t LAUNCHER_SWIPE_FLIP_PX = 60;

/* Read a length constant out of the shell resource.
 *
 * The constants tree holds whatever portrait.json wrote -- a bare number, or
 * the usual "112dp" / "16dp" unit string (parser.cpp merges each constant
 * asset's `data` object verbatim after substituting ${...} references). Both
 * shapes are accepted; anything else falls back. */
int32_t launcher_metric(core::AppContext &context, const char *constant_path, int32_t fallback)
{
    auto value = context.gui().get_constant_value(constant_path);
    if (!value) {
        BROOKESIA_LOGW(
            "Launcher metric '%1%' unavailable (%2%), using %3%", constant_path, value.error(), fallback
        );
        return fallback;
    }
    if (value->is_int64()) {
        return static_cast<int32_t>(value->get_int64());
    }
    if (value->is_double()) {
        return static_cast<int32_t>(value->get_double());
    }
    if (value->is_string()) {
        const std::string text(value->get_string().c_str());
        char *end = nullptr;
        const auto parsed = std::strtol(text.c_str(), &end, 10);
        // Accept a trailing unit ("112dp"), reject a leading one ("dp112").
        if (end != text.c_str()) {
            return static_cast<int32_t>(parsed);
        }
    }
    BROOKESIA_LOGW("Launcher metric '%1%' is not a length, using %2%", constant_path, fallback);
    return fallback;
}
using SteadyClock = std::chrono::steady_clock;
using SteadyTimePoint = SteadyClock::time_point;

int64_t elapsed_ms_since(SteadyTimePoint started_at, SteadyTimePoint ended_at = SteadyClock::now())
{
    return std::chrono::duration_cast<std::chrono::milliseconds>(ended_at - started_at).count();
}

std::optional<std::string> get_launcher_instance_id(const gui::Event &event)
{
    if (!event.path.starts_with(SUPER_LAUNCHER_PATH_PREFIX)) {
        return std::nullopt;
    }
    auto instance_id = event.path.substr(std::string_view(SUPER_LAUNCHER_PATH_PREFIX).size());
    auto child_separator = instance_id.find('/');
    if (child_separator != std::string::npos) {
        instance_id.resize(child_separator);
    }
    if (instance_id.empty()) {
        return std::nullopt;
    }
    return std::string(SUPER_LAUNCHER_INSTANCE_PREFIX) + instance_id;
}

std::string make_launcher_slot_path(size_t index)
{
    return std::string(SUPER_LAUNCHER_SLOT_PATH_PREFIX) + std::to_string(index);
}

std::string make_launcher_item_instance_id(core::AppId app_id)
{
    return std::string(SUPER_LAUNCHER_INSTANCE_PREFIX) + std::to_string(app_id);
}

std::string make_launcher_item_path(core::AppId app_id)
{
    return std::string(SUPER_LAUNCHER_PATH_PREFIX) + std::to_string(app_id);
}

std::string make_launcher_icon_text(std::string_view name)
{
    for (char ch : name) {
        const auto unsigned_ch = static_cast<unsigned char>(ch);
        if (std::isalnum(unsigned_ch) != 0) {
            return std::string(1, static_cast<char>(std::toupper(unsigned_ch)));
        }
    }
    if (!name.empty()) {
        const auto first = static_cast<unsigned char>(name.front());
        size_t char_length = 1;
        if ((first & 0xE0U) == 0xC0U) {
            char_length = 2;
        } else if ((first & 0xF0U) == 0xE0U) {
            char_length = 3;
        } else if ((first & 0xF8U) == 0xF0U) {
            char_length = 4;
        }
        return std::string(name.substr(0, std::min(char_length, name.size())));
    }
    return "?";
}

std::string normalize_theme_id(std::string_view theme_id)
{
    if (theme_id == "shell.light") {
        return SUPER_LIGHT_THEME_ID;
    }
    if (theme_id == "shell.dark") {
        return SUPER_DARK_THEME_ID;
    }
    return std::string(theme_id);
}

std::optional<gui::ViewFrame> get_absolute_view_frame(core::AppContext &context, std::string_view absolute_path)
{
    if (absolute_path.empty() || absolute_path.front() != '/') {
        return std::nullopt;
    }

    gui::ViewFrame result;
    std::string current_path;
    size_t start = 1;
    while (start <= absolute_path.size()) {
        const auto slash = absolute_path.find('/', start);
        const auto part_length = slash == std::string_view::npos ? std::string_view::npos : slash - start;
        const auto part = absolute_path.substr(start, part_length);
        if (part.empty()) {
            break;
        }

        current_path += "/";
        current_path += part;
        auto frame = context.gui().get_view_frame(current_path);
        if (!frame.has_value()) {
            return std::nullopt;
        }
        result.x += frame->x;
        result.y += frame->y;
        result.width = frame->width;
        result.height = frame->height;

        if (slash == std::string_view::npos) {
            break;
        }
        start = slash + 1;
    }

    return result.width > 0 && result.height > 0 ? std::optional<gui::ViewFrame>(result) : std::nullopt;
}

} // namespace

std::string ShellApp::get_app_icon_text(std::string_view name) const
{
    return make_launcher_icon_text(name);
}

std::expected<void, std::string> ShellApp::populate_launcher(core::AppContext &context)
{
    disconnect_launcher_actions();
    for (const auto &[instance_id, app_id] : launcher_instance_to_app_) {
        (void)instance_id;
        const auto instance_path = make_launcher_item_path(app_id);
        if (!context.gui().destroy_view(instance_path)) {
            BROOKESIA_LOGW("Failed to destroy launcher item before refresh: path(%1%)", instance_path);
        }
    }
    for (size_t i = 0; i < launcher_slot_count_; ++i) {
        const auto slot_path = make_launcher_slot_path(i);
        if (!context.gui().destroy_view(slot_path)) {
            BROOKESIA_LOGW("Failed to destroy launcher slot before refresh: path(%1%)", slot_path);
        }
    }
    launcher_slot_count_ = 0;
    launcher_order_.clear();
    launcher_instance_to_app_.clear();
    launcher_tiles_.clear();
    launcher_page_ = 0;
    launcher_page_count_ = 1;
    launcher_page_stride_ = 0;
    launcher_swipe_active_ = false;
    launcher_populated_ = false;

    std::vector<core::AppInfo> visible_apps;
    for (const auto &app : owner_.list_apps()) {
        if (!app.manifest.visible) {
            continue;
        }
        // Per-board (#260): boards that run a clean 2x2 (cloudera, tuna-starlink)
        // hide the stock Files tile so their four tiles fill one non-scrolling
        // page. Gated by BOARD_HIDE_FILES, a compile definition from the board
        // profile (undefined -> shown, the generic tuna-street default). Files
        // stays installed either way; it just claims no home slot when hidden.
#if defined(BOARD_HIDE_FILES) && BOARD_HIDE_FILES
        if (app.manifest.id == "brookesia.general.files") {
            continue;
        }
#endif
        visible_apps.push_back(app);
        launcher_order_.push_back(app.app_id);
    }

    const auto environment = owner_.get_environment();
    const auto density = std::max(environment.density, 0.001F);
    const auto fallback_width = static_cast<int32_t>(
                                    std::max(1.0F, static_cast<float>(environment.width_px) / density)
                                );
    // Delta 1: the grid metrics the tiles are POSITIONED by are now the same
    // numbers they are DRAWN at.
    const auto item_width = launcher_metric(context, LAUNCHER_ITEM_WIDTH_CONSTANT, LAUNCHER_ITEM_WIDTH_DEFAULT);
    const auto item_height = launcher_metric(context, LAUNCHER_ITEM_HEIGHT_CONSTANT, LAUNCHER_ITEM_HEIGHT_DEFAULT);
    const auto item_gap = launcher_metric(context, LAUNCHER_ITEM_GAP_CONSTANT, LAUNCHER_ITEM_GAP_DEFAULT);

    const auto content_frame = context.gui().get_view_frame(SUPER_LAUNCHER_CONTENT_PATH);
    const auto available_width = content_frame.has_value() ?
                                 std::max<int32_t>(content_frame->width, item_width) :
                                 std::max<int32_t>(fallback_width, item_width);
    const auto launcher_columns = std::max<int32_t>(
                                      1,
                                      (available_width + item_gap) / (item_width + item_gap)
                                  );
    const auto launcher_grid_width =
        launcher_columns * item_width + (launcher_columns - 1) * item_gap;
    const auto launcher_grid_x = std::max<int32_t>(0, (available_width - launcher_grid_width) / 2);
    std::vector<gui::BindingValueUpdate> binding_updates;
    add_binding_update(binding_updates, SUPER_LAUNCHER_GRID_STAGE_PATH, "grid_x", std::to_string(launcher_grid_x));
    add_binding_update(
        binding_updates,
        SUPER_LAUNCHER_GRID_STAGE_PATH,
        "grid_width",
        std::to_string(launcher_grid_width)
    );

    launcher_slot_count_ = 0;

    // Delta 2: the scroll viewport is grid_stage, NOT the content container.
    // Its runtime frame is not laid out yet when populate runs (it read back
    // as 1px and produced 1-row pages -- X-Viewer landed on a third page), so
    // the height is derived from the same constants app_launcher.json sizes
    // it with: heightDp - content.y - launcherGridTop. A sane frame wins.
    const auto fallback_height = static_cast<int32_t>(
                                     std::max(1.0F, static_cast<float>(environment.height_px) / density)
                                 );
    const auto content_y = launcher_metric(context, LAUNCHER_CONTENT_Y_CONSTANT, LAUNCHER_CONTENT_Y_DEFAULT);
    const auto grid_top = launcher_metric(context, LAUNCHER_GRID_TOP_CONSTANT, LAUNCHER_GRID_TOP_DEFAULT);
    const int32_t computed_viewport_height =
        std::max<int32_t>(fallback_height - content_y - grid_top, item_height);
    const auto grid_stage_frame = context.gui().get_view_frame(SUPER_LAUNCHER_GRID_STAGE_PATH);
    const int32_t viewport_height =
        (grid_stage_frame.has_value() && grid_stage_frame->height >= item_height) ?
        grid_stage_frame->height : computed_viewport_height;

    // Delta 4 (#262/#263): HORIZONTAL paging. rows_per_page whole rows fit the
    // viewport; columns x rows tiles fill a page; every further page sits one
    // stride to the right of the grid stage, outside its bounds, where LVGL
    // neither draws nor hit-tests it. set_launcher_page() slides the set by
    // rebinding each tile's x. The grid never scrolls, and a sideways swipe is
    // a gesture -- not a scroll -- so a drift can no longer land as a click.
    const int32_t rows_per_page = std::max<int32_t>(1, (viewport_height + item_gap) / (item_height + item_gap));
    const int32_t tiles_per_page = std::max<int32_t>(1, launcher_columns * rows_per_page);
    launcher_page_stride_ = launcher_grid_width + item_gap;
    launcher_page_count_ = std::max<int32_t>(
                               1,
                               static_cast<int32_t>(
                                   (visible_apps.size() + static_cast<size_t>(tiles_per_page) - 1) /
                                   static_cast<size_t>(tiles_per_page)
                               )
                           );
    launcher_page_ = 0;
    int32_t grid_extent = 0;
    for (size_t i = 0; i < visible_apps.size(); ++i) {
        const auto &app = visible_apps[i];
        const auto page = static_cast<int32_t>(i / static_cast<size_t>(tiles_per_page));
        const auto local = static_cast<int32_t>(i % static_cast<size_t>(tiles_per_page));
        const auto column = local % launcher_columns;
        const auto row = local / launcher_columns;
        const auto local_x = column * (item_width + item_gap);
        const auto item_x = page * launcher_page_stride_ + local_x;
        const auto item_y = row * (item_height + item_gap);
        grid_extent = std::max(grid_extent, item_y + item_height);

        const auto instance_id = make_launcher_item_instance_id(app.app_id);
        const auto instance_path = make_launcher_item_path(app.app_id);
        const auto label_path = instance_path + "/" + SUPER_LAUNCHER_LABEL_ID;
        const auto fallback_icon_path = instance_path + "/" + SUPER_LAUNCHER_FALLBACK_ICON_ID;
        const auto image_icon_path = instance_path + "/" + SUPER_LAUNCHER_IMAGE_ICON_ID;
        const auto has_image_icon = core::has_app_icon_image(app.manifest);
        const auto display_name = get_app_display_name(app);

        auto create_result = context.gui().create_view(
                                 SUPER_LAUNCHER_BUTTON_TEMPLATE_ID,
                                 SUPER_LAUNCHER_ITEM_LAYER_PATH,
                                 instance_id
                             );
        if (!create_result) {
            return std::unexpected(create_result.error());
        }

        add_binding_update(binding_updates, instance_path, "x", std::to_string(item_x));
        add_binding_update(binding_updates, instance_path, "y", std::to_string(item_y));
        add_binding_update(binding_updates, label_path, "name", display_name);
        if (has_image_icon) {
            add_binding_update(
                binding_updates,
                image_icon_path,
                "src",
                core::resolve_app_icon_resource_id(app.manifest)
            );
            add_binding_update(binding_updates, image_icon_path, "hidden", "false");
            add_binding_update(binding_updates, fallback_icon_path, "hidden", "true");
            add_binding_update(binding_updates, fallback_icon_path, "text", "");
        } else {
            add_binding_update(binding_updates, image_icon_path, "hidden", "true");
            add_binding_update(binding_updates, fallback_icon_path, "hidden", "false");
            add_binding_update(binding_updates, fallback_icon_path, "text", make_launcher_icon_text(display_name));
        }

        launcher_instance_to_app_.emplace(instance_id, app.app_id);
        launcher_tiles_.push_back(LauncherTile{
            .path = instance_path,
            .page = page,
            .x = local_x,
            .y = item_y,
        });
    }

    static constexpr std::array launcher_actions = {
        SUPER_ACTION_LAUNCH_APP,
    };
    for (const auto *action : launcher_actions) {
        auto launcher_handler = [this](const gui::Event & event) {
            handle_launcher_event(event);
        };
        auto connection = context.gui().subscribe_action(action, launcher_handler);
        if (!connection.connected()) {
            disconnect_launcher_actions();
            return std::unexpected(std::string("Failed to subscribe launcher action: ") + action);
        }
        launcher_action_connections_.push_back(std::move(connection));
    }

    // The layers cover the viewport. Each page's rows fit it by construction
    // (delta 4), so the grid is NEVER scrollable -- delta 3's answer to the
    // #220 scramble stays in force, and no sideways drift can become a scroll.
    const int32_t content_height = std::max(viewport_height, grid_extent);
    add_binding_update(binding_updates, SUPER_LAUNCHER_GRID_STAGE_PATH, "grid_scrollable", "false");
    BROOKESIA_LOGI(
        "Launcher grid: columns(%1%), rows/page(%2%), pages(%3%), item(%4%x%5% gap %6%), extent(%7%), viewport(%8%)",
        launcher_columns, rows_per_page, launcher_page_count_, item_width, item_height, item_gap,
        grid_extent, viewport_height
    );
    add_binding_update(
        binding_updates,
        SUPER_LAUNCHER_SLOT_GRID_PATH,
        "content_height",
        std::to_string(content_height)
    );
    add_binding_update(
        binding_updates,
        SUPER_LAUNCHER_ITEM_LAYER_PATH,
        "content_height",
        std::to_string(content_height)
    );
    add_binding_update(
        binding_updates,
        SUPER_LAUNCHER_DRAG_LAYER_PATH,
        "content_height",
        std::to_string(content_height)
    );
    auto binding_result = context.gui().set_binding_values(binding_updates);
    if (!binding_result) {
        disconnect_launcher_actions();
        return binding_result;
    }

    launcher_populated_ = true;
    return {};
}

std::expected<void, std::string> ShellApp::set_launcher_page(int32_t page)
{
    if (context_ == nullptr || !launcher_populated_) {
        return {};
    }
    page = std::clamp<int32_t>(page, 0, launcher_page_count_ - 1);
    if (page == launcher_page_) {
        return {};
    }
    launcher_page_ = page;
    // Slide the whole tile set: a tile on page p sits (p - current) strides to
    // the right of the grid stage. Off-stage tiles are outside their parent's
    // bounds, so LVGL neither draws nor hit-tests them.
    std::vector<gui::BindingValueUpdate> updates;
    updates.reserve(launcher_tiles_.size());
    for (const auto &tile : launcher_tiles_) {
        const auto x = tile.x + (tile.page - launcher_page_) * launcher_page_stride_;
        add_binding_update(updates, tile.path, "x", std::to_string(x));
    }
    auto result = context_->gui().set_binding_values(updates);
    if (!result) {
        BROOKESIA_LOGW("Failed to flip launcher page to %1%: %2%", launcher_page_, result.error());
        return result;
    }
    BROOKESIA_LOGI("Launcher page %1%/%2%", launcher_page_ + 1, launcher_page_count_);
    return {};
}

void ShellApp::handle_launcher_page_gesture(const service::Display::TouchGestureInfo &info)
{
    using EventType = service::Display::TouchGestureEventType;
    using Direction = service::Display::TouchGestureDirection;

    if (!launcher_populated_ || launch_overlay_active_ || message_dialog_mounted_ || message_dialog_closing_) {
        launcher_swipe_active_ = false;
        return;
    }
    const int32_t dx = info.stop_x - info.start_x;
    switch (info.event_type) {
    case EventType::Press:
        launcher_swipe_active_ = false;
        return;
    case EventType::Pressing:
        // Direction lock is on for this output: a locked Left/Right, or a raw
        // sideways drift before the lock lands, marks this press as a swipe.
        if (std::abs(dx) >= LAUNCHER_SWIPE_DRIFT_PX &&
                (info.direction == Direction::Left || info.direction == Direction::Right ||
                 info.direction == Direction::None)) {
            launcher_swipe_active_ = true;
        }
        return;
    case EventType::Release:
        if (launcher_page_count_ > 1 && std::abs(dx) >= LAUNCHER_SWIPE_FLIP_PX &&
                (info.direction == Direction::Left || info.direction == Direction::Right)) {
            // Finger moves left -> content follows -> next page; right -> back.
            (void)set_launcher_page(launcher_page_ + (dx < 0 ? 1 : -1));
        }
        // Keep the flag up through the release so the tile click that reaches
        // the GUI task after this callback is still swallowed; the next Press
        // clears it.
        return;
    }
}

std::expected<void, std::string> ShellApp::refresh_launcher()
{
    if (context_ == nullptr) {
        return {};
    }
    return populate_launcher(*context_);
}

std::expected<void, std::string> ShellApp::refresh_environment()
{
    if (context_ == nullptr) {
        return {};
    }
    current_theme_id_ = normalize_theme_id(context_->gui().get_theme());
    auto i18n_result = apply_i18n_updates();
    if (!i18n_result) {
        return i18n_result;
    }
    if (!launcher_populated_) {
        return {};
    }

    std::vector<gui::BindingValueUpdate> updates;
    for (const auto &app : owner_.list_apps()) {
        if (!app.manifest.visible) {
            continue;
        }
        // Per-board (#260): boards that run a clean 2x2 (cloudera, tuna-starlink)
        // hide the stock Files tile so their four tiles fill one non-scrolling
        // page. Gated by BOARD_HIDE_FILES, a compile definition from the board
        // profile (undefined -> shown, the generic tuna-street default). Files
        // stays installed either way; it just claims no home slot when hidden.
#if defined(BOARD_HIDE_FILES) && BOARD_HIDE_FILES
        if (app.manifest.id == "brookesia.general.files") {
            continue;
        }
#endif

        const auto instance_path = std::string(SUPER_LAUNCHER_PATH_PREFIX) + std::to_string(app.app_id);
        const auto label_path = instance_path + "/" + SUPER_LAUNCHER_LABEL_ID;
        const auto fallback_icon_path = instance_path + "/" + SUPER_LAUNCHER_FALLBACK_ICON_ID;
        const auto image_icon_path = instance_path + "/" + SUPER_LAUNCHER_IMAGE_ICON_ID;
        const auto has_image_icon = core::has_app_icon_image(app.manifest);
        const auto display_name = get_app_display_name(app);
        const auto fallback_text = has_image_icon ? std::string() : get_app_icon_text(display_name);

        add_binding_update(updates, label_path, "name", display_name);
        if (has_image_icon) {
            add_binding_update(
                updates,
                image_icon_path,
                "src",
                core::resolve_app_icon_resource_id(app.manifest)
            );
            add_binding_update(updates, image_icon_path, "hidden", "false");
            add_binding_update(updates, fallback_icon_path, "hidden", "true");
            add_binding_update(updates, fallback_icon_path, "text", "");
        } else {
            add_binding_update(updates, image_icon_path, "hidden", "true");
            add_binding_update(updates, fallback_icon_path, "hidden", "false");
            add_binding_update(updates, fallback_icon_path, "text", fallback_text);
        }
    }

    if (!updates.empty()) {
        auto binding_result = context_->gui().set_binding_values(updates);
        if (!binding_result) {
            return binding_result;
        }
    }

    return {};
}

void ShellApp::disconnect_launcher_actions()
{
    for (auto &connection : launcher_action_connections_) {
        connection.disconnect();
    }
    launcher_action_connections_.clear();
}

void ShellApp::handle_launcher_event(const gui::Event &event)
{
    if (launch_overlay_active_) {
        BROOKESIA_LOGW("Ignore launcher action while app launch overlay is active");
        return;
    }
    // A sideways swipe over a tile still ends in an LVGL `clicked`: the tile
    // template dropped requireValidPress (#205) and the grid does not scroll,
    // so nothing steals the press. The gesture path flagged the drift -- that
    // click is the page flip's side effect, not a launch (delta 4).
    if (launcher_swipe_active_.load()) {
        BROOKESIA_LOGD("Ignore launcher click: press drifted into a page swipe");
        return;
    }

    auto instance_id = get_launcher_instance_id(event);
    if (!instance_id) {
        BROOKESIA_LOGW("Launcher action from unknown path: %1%", event.path);
        return;
    }
    auto app_it = launcher_instance_to_app_.find(*instance_id);
    if (app_it == launcher_instance_to_app_.end()) {
        BROOKESIA_LOGW("Launcher action from unknown instance: %1%", *instance_id);
        return;
    }

    std::optional<gui::ViewFrame> launch_origin_frame;
    if (context_ != nullptr) {
        const auto icon_box_path =
            std::string(SUPER_LAUNCHER_ITEM_LAYER_PATH) + "/" + *instance_id + "/" + SUPER_LAUNCHER_ICON_BOX_ID;
        launch_origin_frame = get_absolute_view_frame(*context_, icon_box_path);
        if (!launch_origin_frame.has_value()) {
            BROOKESIA_LOGW("Launcher icon frame not available: path(%1%)", icon_box_path);
        }
    }

    const auto app_id = app_it->second;
    launch_request_started_at_ = SteadyClock::now();
    auto start_app = [this, app_id]() {
        const auto request_started_at = launch_request_started_at_;
        const auto app_start_started_at = SteadyClock::now();
        auto result = owner_.start_app(app_id, core::System::AppStartOptions{});
        const auto now = SteadyClock::now();
        SYSTEM_SUPER_PROFILE_LOGI(
            "Shell app launch profile: app_id(%1%), start_app_ms(%2%), total_ms(%3%)",
            app_id,
            elapsed_ms_since(app_start_started_at, now),
            request_started_at.has_value() ? elapsed_ms_since(*request_started_at, now) : 0
        );
        launch_request_started_at_.reset();
        if (!result) {
            BROOKESIA_LOGW("Failed to launch app: app_id(%1%), error(%2%)", app_id, result.error());
        }
    };
    auto app = owner_.get_app(app_id);
    if (!app.has_value()) {
        start_app();
        return;
    }

    auto collapse_result = set_system_ui_expanded(false);
    if (!collapse_result) {
        BROOKESIA_LOGW("Failed to collapse system UI before app launch: %1%", collapse_result.error());
    }

    auto overlay_result = show_launch_overlay(*app, launch_origin_frame, [this, app_id]() {
        schedule_app_start_after_launch(app_id);
    });
    if (!overlay_result) {
        BROOKESIA_LOGW("Failed to show app launch overlay: %1%", overlay_result.error());
        start_app();
    }
}

} // namespace esp_brookesia::system::super
