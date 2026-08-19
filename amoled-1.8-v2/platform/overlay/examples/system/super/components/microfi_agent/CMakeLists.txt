# MicroFi EFM agent as a Brookesia guest component (#188 Phase 4).
#
# Sources come straight from the MicroFi tree (single source of truth) —
# minus main.cpp (Brookesia owns app_main; the host calls microfi_agent_start()
# from its own startup) and minus the three processors trimmed for this SKU:
# CaptureImage (no OV2640 — drops the esp32-camera dependency) and
# GetGPIO/SetGPIO (control lines are behind the TCA9554).
#
# WHOLE_ARCHIVE keeps the processor auto-registration (static-constructor
# side effects) from being dropped by the linker.

if(DEFINED ENV{MICROFI_ROOT})
  set(MICROFI_ROOT "$ENV{MICROFI_ROOT}")
else()
  set(MICROFI_ROOT "/mnt/c/Users/tunas/MicroFi")
endif()

set(MICROFI_CJSON_SRCS
  "${MICROFI_ROOT}/vendor/cjson/cJSON.cpp"
  "${MICROFI_ROOT}/vendor/cjson/cJSON_Utils.cpp"
)

idf_component_register(
  SRCS
    "${MICROFI_ROOT}/src/flowfile.cpp"
    "${MICROFI_ROOT}/src/queue.cpp"
    "${MICROFI_ROOT}/src/registry.cpp"
    "${MICROFI_ROOT}/src/session.cpp"
    "${MICROFI_ROOT}/src/flow_engine.cpp"
    "${MICROFI_ROOT}/src/flow_parser.cpp"
    "${MICROFI_ROOT}/src/flow_yaml_parser.cpp"
    "${MICROFI_ROOT}/src/wifi.cpp"
    "${MICROFI_ROOT}/src/agent_id.cpp"
    "${MICROFI_ROOT}/src/manifest.cpp"
    "${MICROFI_ROOT}/src/c2_client.cpp"
    "${MICROFI_ROOT}/src/liveness_led.cpp"
    "${MICROFI_ROOT}/src/storage.cpp"
    "${MICROFI_ROOT}/src/littlefs_repository.cpp"
    "${MICROFI_ROOT}/src/flow_store.cpp"
    "${MICROFI_ROOT}/src/flowfile_store.cpp"
    "${MICROFI_ROOT}/src/agent.cpp"
    "${MICROFI_ROOT}/src/processors/generate_flowfile.cpp"
    "${MICROFI_ROOT}/src/processors/log_attribute.cpp"
    "${MICROFI_ROOT}/src/processors/publish_mqtt.cpp"
    "${MICROFI_ROOT}/src/processors/update_attribute.cpp"
    "${MICROFI_ROOT}/src/processors/listen_http.cpp"
    "${MICROFI_ROOT}/src/processors/publish_sparkplug.cpp"
    ${MICROFI_CJSON_SRCS}
  INCLUDE_DIRS
    "${MICROFI_ROOT}/src"
    "${MICROFI_ROOT}/include"
    "${MICROFI_ROOT}/vendor/cjson"
  REQUIRES
    esp_wifi
    esp_event
    esp_netif
    nvs_flash
    esp_http_client
    mqtt
    mbedtls
    esp-tls
    freertos
    log
    littlefs
    driver
    esp_driver_gpio
    esp_driver_tsens
    esp_http_server
    sparkplug
  LDFRAGMENTS "linker.lf"
  WHOLE_ARCHIVE
)

target_compile_definitions(
  ${COMPONENT_LIB}
  PRIVATE
    CJSON_NESTING_LIMIT=1000
    CJSON_CIRCULAR_LIMIT=10000
)
