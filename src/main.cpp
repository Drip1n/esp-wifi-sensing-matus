#include <Arduino.h>
#include <Adafruit_NeoPixel.h>

#define LED_PIN 48
#define LED_COUNT 1

Adafruit_NeoPixel led(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);

void setup() {
  Serial.begin(115200);

  led.begin();
  led.clear();
  led.show();

  Serial.println("RGB LED test started!");
}

void loop() {
  // RED
  led.setPixelColor(0, led.Color(255, 0, 0));
  led.show();
  Serial.println("RED");
  delay(1000);

  // GREEN
  led.setPixelColor(0, led.Color(0, 255, 0));
  led.show();
  Serial.println("GREEN");
  delay(1000);

  // BLUE
  led.setPixelColor(0, led.Color(0, 0, 255));
  led.show();
  Serial.println("BLUE");
  delay(1000);

  // OFF
  led.clear();
  led.show();
  Serial.println("OFF");
  delay(1000);
}