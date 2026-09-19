#include <Arduino.h>
#include <Adafruit_NeoPixel.h>

// Väčšina ESP32-S3 N16R8 má RGB LED na pine 48 (ak by nesvietila, skús zmeniť na 38)
#define RGB_PIN    48
#define NUM_PIXELS 1

Adafruit_NeoPixel rgb(NUM_PIXELS, RGB_PIN, NEO_GRB + NEO_KHZ800);

void setColor(uint8_t r, uint8_t g, uint8_t b) {
  rgb.setPixelColor(0, rgb.Color(r, g, b));
  rgb.show();
}

void setup() {
  Serial.begin(115200);
  delay(2000); // Čas na inicializáciu USB

  Serial.println("--- ESP32-S3 RGB LED Test ---");

  rgb.begin();
  rgb.setBrightness(40); // Jas (0 až 255) – 40 je dosť silné, aby to neoslepovalo
  rgb.clear();
  rgb.show();
}

void loop() {
  // 1. Červená
  Serial.println("Farba: CERVENA");
  setColor(255, 0, 0);
  delay(1000);

  // 2. Zelená
  Serial.println("Farba: ZELENA");
  setColor(0, 255, 0);
  delay(1000);

  // 3. Modrá
  Serial.println("Farba: MODRA");
  setColor(0, 0, 255);
  delay(1000);

  // 4. Biela
  Serial.println("Farba: BIELA");
  setColor(255, 255, 255);
  delay(1000);

  // 5. Plynulý dúhový prechod (Rainbow)
  Serial.println("Efekt: DUHA (Rainbow)");
  for (long firstPixelHue = 0; firstPixelHue < 65536; firstPixelHue += 256) {
    rgb.rainbow(firstPixelHue);
    rgb.show();
    delay(10);
  }

  // Krátke zhasnutie pred novým cyklom
  rgb.clear();
  rgb.show();
  delay(500);
}