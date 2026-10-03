#include <Arduino.h>
#include <WiFi.h>
#include "esp_wifi.h"

// Funkcia na zachytávanie CSI rámcov
void _wifi_csi_rx_cb(void *ctx, wifi_csi_info_t *data) {
  if (!data || !data->buf) return;

  Serial.printf("CSI_DATA,%d,%d", data->len, data->rx_ctrl.rssi);
  int8_t *csi_raw = (int8_t *)data->buf;
  for (int i = 0; i < data->len; i++) {
    Serial.printf(",%d", csi_raw[i]);
  }
  Serial.println();
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n\n================================");
  Serial.println(">>> ESP32-S3 USPESNE NASTARTOVANE <<<");
  Serial.println("================================");

  // Spustíme Wi-Fi v režime AP (prístupový bod), aby doska sama generovala sieť
  WiFi.mode(WIFI_AP_STA);
  WiFi.softAP("ESP32_RADAR", "12345678", 1); // Vysiela na kanáli 1

  wifi_csi_config_t csi_config = {
    .lltf_en = true,
    .htltf_en = true,
    .stbc_htltf2_en = true,
    .ltf_merge_en = true,
    .channel_filter_en = false,
    .manu_scale = false,
    .shift = false,
  };

  ESP_ERROR_CHECK(esp_wifi_set_csi_config(&csi_config));
  ESP_ERROR_CHECK(esp_wifi_set_csi_rx_cb(_wifi_csi_rx_cb, NULL));
  ESP_ERROR_CHECK(esp_wifi_set_csi(true));

  esp_wifi_set_promiscuous(true);
  esp_wifi_set_channel(1, WIFI_SECOND_CHAN_NONE);

  Serial.println(">>> ESP32-S3 CSI bezi na sieti ESP32_RADAR <<<");
}

void loop() {
  delay(100);
}