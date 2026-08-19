/*
 * Phase 1 display bring-up for Waveshare ESP32-S3-Touch-AMOLED-1.8 V2 (#188).
 * Solid colors + bars via esp_lcd_panel_draw_bitmap ONLY — no LVGL, no WiFi.
 * Init sequence and pin map copied from the proven xiaozhi-esp32 board file
 * main/boards/waveshare/esp32-s3-touch-amoled-1.8-v2/esp32-s3-touch-amoled-1.8-v2.cc
 */
#include <string.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "driver/i2c_master.h"
#include "driver/spi_master.h"
#include "esp_lcd_panel_io.h"
#include "esp_lcd_panel_ops.h"
#include "esp_lcd_co5300.h"
#include "esp_io_expander_tca9554.h"

static const char *TAG = "colorbar";

#define LCD_H_RES 368
#define LCD_V_RES 448
#define LCD_OFFSET_X 16

#define PIN_I2C_SDA 15
#define PIN_I2C_SCL 14
#define PIN_LCD_CS 12
#define PIN_LCD_PCLK 11
#define PIN_LCD_D0 4
#define PIN_LCD_D1 5
#define PIN_LCD_D2 6
#define PIN_LCD_D3 7

#define AXP2101_ADDR 0x34

/* CO5300 vendor init — verbatim from the xiaozhi V2 board file */
static const co5300_lcd_init_cmd_t vendor_specific_init[] = {
    {0x11, (uint8_t[]){0x00}, 0, 600},
    {0xFE, (uint8_t[]){0x20}, 1, 0},
    {0x19, (uint8_t[]){0x10}, 1, 0},
    {0x1C, (uint8_t[]){0xA0}, 1, 0},
    {0xFE, (uint8_t[]){0x00}, 1, 0},
    {0xC4, (uint8_t[]){0x80}, 1, 0},
    {0x3A, (uint8_t[]){0x55}, 1, 0},
    {0x35, (uint8_t[]){0x00}, 1, 0},
    {0x53, (uint8_t[]){0x20}, 1, 0},
    {0x51, (uint8_t[]){0xFF}, 1, 0},
    {0x63, (uint8_t[]){0xFF}, 1, 0},
    {0x2A, (uint8_t[]){0x00, 0x00, 0x01, 0xDF}, 4, 0},
    {0x2B, (uint8_t[]){0x00, 0x00, 0x01, 0xDF}, 4, 0},
    {0x36, (uint8_t[]){0x00}, 1, 0},
    {0x29, (uint8_t[]){0x00}, 0, 600},
};

static i2c_master_bus_handle_t s_i2c_bus;
static i2c_master_dev_handle_t s_axp;

static void axp_write(uint8_t reg, uint8_t val)
{
    uint8_t buf[2] = {reg, val};
    ESP_ERROR_CHECK(i2c_master_transmit(s_axp, buf, 2, 1000));
}

static void init_i2c(void)
{
    i2c_master_bus_config_t cfg = {
        .i2c_port = I2C_NUM_0,
        .sda_io_num = PIN_I2C_SDA,
        .scl_io_num = PIN_I2C_SCL,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags = {.enable_internal_pullup = 1},
    };
    ESP_ERROR_CHECK(i2c_new_master_bus(&cfg, &s_i2c_bus));
}

static void init_tca9554(void)
{
    esp_io_expander_handle_t io_expander = NULL;
    ESP_ERROR_CHECK(esp_io_expander_new_i2c_tca9554(
        s_i2c_bus, ESP_IO_EXPANDER_I2C_TCA9554_ADDRESS_000, &io_expander));
    ESP_ERROR_CHECK(esp_io_expander_set_dir(io_expander,
        IO_EXPANDER_PIN_NUM_0 | IO_EXPANDER_PIN_NUM_1 | IO_EXPANDER_PIN_NUM_2,
        IO_EXPANDER_OUTPUT));
    ESP_ERROR_CHECK(esp_io_expander_set_dir(io_expander, IO_EXPANDER_PIN_NUM_4,
        IO_EXPANDER_INPUT));
    ESP_ERROR_CHECK(esp_io_expander_set_level(io_expander,
        IO_EXPANDER_PIN_NUM_0 | IO_EXPANDER_PIN_NUM_1 | IO_EXPANDER_PIN_NUM_2, 1));
    vTaskDelay(pdMS_TO_TICKS(100));
    ESP_ERROR_CHECK(esp_io_expander_set_level(io_expander,
        IO_EXPANDER_PIN_NUM_0 | IO_EXPANDER_PIN_NUM_1 | IO_EXPANDER_PIN_NUM_2, 0));
    vTaskDelay(pdMS_TO_TICKS(300));
    ESP_ERROR_CHECK(esp_io_expander_set_level(io_expander,
        IO_EXPANDER_PIN_NUM_0 | IO_EXPANDER_PIN_NUM_1 | IO_EXPANDER_PIN_NUM_2, 1));
    ESP_LOGI(TAG, "TCA9554 reset pulse done");
}

static void init_axp2101(void)
{
    i2c_device_config_t dev_cfg = {
        .dev_addr_length = I2C_ADDR_BIT_LEN_7,
        .device_address = AXP2101_ADDR,
        .scl_speed_hz = 400000,
    };
    ESP_ERROR_CHECK(i2c_master_bus_add_device(s_i2c_bus, &dev_cfg, &s_axp));
    /* Register values verbatim from xiaozhi's Pmic constructor */
    axp_write(0x22, 0b110);
    axp_write(0x27, 0x10);
    axp_write(0x80, 0x01);              /* all DCs off but DC1 */
    axp_write(0x90, 0x00);              /* all LDOs off */
    axp_write(0x91, 0x00);
    axp_write(0x82, (3300 - 1500) / 100); /* DC1 = 3.3 V */
    axp_write(0x92, (3300 - 500) / 100);  /* ALDO1 = 3.3 V */
    axp_write(0x90, 0x01);              /* enable ALDO1 */
    ESP_LOGI(TAG, "AXP2101 rails configured");
}

static esp_lcd_panel_handle_t init_display(void)
{
    spi_bus_config_t buscfg = {
        .sclk_io_num = PIN_LCD_PCLK,
        .data0_io_num = PIN_LCD_D0,
        .data1_io_num = PIN_LCD_D1,
        .data2_io_num = PIN_LCD_D2,
        .data3_io_num = PIN_LCD_D3,
        .max_transfer_sz = LCD_H_RES * LCD_V_RES * sizeof(uint16_t),
        .flags = SPICOMMON_BUSFLAG_QUAD,
    };
    ESP_ERROR_CHECK(spi_bus_initialize(SPI2_HOST, &buscfg, SPI_DMA_CH_AUTO));

    esp_lcd_panel_io_handle_t panel_io = NULL;
    esp_lcd_panel_io_spi_config_t io_config = {
        .cs_gpio_num = PIN_LCD_CS,
        .dc_gpio_num = -1,
        .spi_mode = 0,
        .pclk_hz = 40 * 1000 * 1000,
        .trans_queue_depth = 10,
        .lcd_cmd_bits = 32,
        .lcd_param_bits = 8,
        .flags = {.quad_mode = true},
    };
    ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi(SPI2_HOST, &io_config, &panel_io));

    const co5300_vendor_config_t vendor_config = {
        .init_cmds = vendor_specific_init,
        .init_cmds_size = sizeof(vendor_specific_init) / sizeof(co5300_lcd_init_cmd_t),
        .flags = {.use_qspi_interface = 1},
    };
    esp_lcd_panel_dev_config_t panel_config = {
        .reset_gpio_num = -1,
        .rgb_ele_order = LCD_RGB_ELEMENT_ORDER_RGB,
        .bits_per_pixel = 16,
        .vendor_config = (void *)&vendor_config,
    };
    esp_lcd_panel_handle_t panel = NULL;
    ESP_ERROR_CHECK(esp_lcd_new_panel_co5300(panel_io, &panel_config, &panel));
    ESP_ERROR_CHECK(esp_lcd_panel_reset(panel));
    ESP_ERROR_CHECK(esp_lcd_panel_init(panel));
    ESP_ERROR_CHECK(esp_lcd_panel_invert_color(panel, false));
    ESP_ERROR_CHECK(esp_lcd_panel_mirror(panel, false, false));
    ESP_ERROR_CHECK(esp_lcd_panel_set_gap(panel, LCD_OFFSET_X, 0));
    ESP_ERROR_CHECK(esp_lcd_panel_disp_on_off(panel, true));
    ESP_LOGI(TAG, "CO5300 panel initialized");
    return panel;
}

static void fill_screen(esp_lcd_panel_handle_t panel, uint16_t color)
{
    /* Draw in 32-line strips to keep the DMA buffer small */
    const int strip = 32;
    uint16_t *buf = heap_caps_malloc(LCD_H_RES * strip * sizeof(uint16_t),
                                     MALLOC_CAP_DMA);
    assert(buf);
    for (int i = 0; i < LCD_H_RES * strip; i++) {
        buf[i] = color;
    }
    for (int y = 0; y < LCD_V_RES; y += strip) {
        ESP_ERROR_CHECK(esp_lcd_panel_draw_bitmap(panel, 0, y, LCD_H_RES,
                                                  y + strip, buf));
    }
    free(buf);
}

static void draw_bars(esp_lcd_panel_handle_t panel)
{
    /* RGB565, big-endian on the wire: red F800, green 07E0, blue 001F */
    static const uint16_t bars[] = {0xF800, 0x07E0, 0x001F, 0xFFFF,
                                    0xFFE0, 0x07FF, 0xF81F, 0x0000};
    const int n = sizeof(bars) / sizeof(bars[0]);
    const int strip = 32;
    uint16_t *buf = heap_caps_malloc(LCD_H_RES * strip * sizeof(uint16_t),
                                     MALLOC_CAP_DMA);
    assert(buf);
    for (int y = 0; y < LCD_V_RES; y += strip) {
        uint16_t color = bars[(y * n) / LCD_V_RES];
        for (int i = 0; i < LCD_H_RES * strip; i++) {
            buf[i] = color;
        }
        ESP_ERROR_CHECK(esp_lcd_panel_draw_bitmap(panel, 0, y, LCD_H_RES,
                                                  y + strip, buf));
    }
    free(buf);
}

void app_main(void)
{
    ESP_LOGI(TAG, "Phase 1 bring-up: I2C -> TCA9554 -> AXP2101 -> QSPI CO5300");
    init_i2c();
    init_tca9554();
    init_axp2101();
    esp_lcd_panel_handle_t panel = init_display();

    static const uint16_t solids[] = {0xF800, 0x07E0, 0x001F};
    static const char *names[] = {"RED", "GREEN", "BLUE"};
    while (true) {
        for (int i = 0; i < 3; i++) {
            ESP_LOGI(TAG, "solid %s", names[i]);
            fill_screen(panel, solids[i]);
            vTaskDelay(pdMS_TO_TICKS(2000));
        }
        ESP_LOGI(TAG, "color bars");
        draw_bars(panel);
        vTaskDelay(pdMS_TO_TICKS(4000));
    }
}
