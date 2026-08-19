# Agent status tile (#185): read-only native Brookesia app that shows the
# MicroFi guest agent's identity and health on a single black screen.
#
# Registration is compile-time: the source registers an IAppProvider via
# BROOKESIA_SYSTEM_CORE_APP_PROVIDER_REGISTER_WITH_SYMBOL, and
# System::install_registered_apps() (Config default: true, runs during
# System::init) installs everything in that registry -- same path the
# stock Settings/Files apps take. No explicit install call in main.cpp.

idf_component_register(
    SRCS "agent_status_tile.cpp"
    REQUIRES
        brookesia_system_core
        microfi_agent
        esp_wifi
        esp_netif
        freertos
)

target_compile_features(${COMPONENT_LIB} PUBLIC cxx_std_23)

# The provider registers from a static-init side effect inside a static
# library; -u keeps that object alive in the final link (Files/Settings do
# the same with their *_provider_symbol).
target_link_libraries(${COMPONENT_LIB} PUBLIC "-u agent_status_tile_provider_symbol")
