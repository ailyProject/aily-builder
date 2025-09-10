/* 条件编译测试文件 */

#include <Arduino.h>

// 平台特定的包含
#if defined(ESP32)
  #include <WiFi.h>
  #include <ESP32_specific.h>
#elif defined(ARDUINO_ARCH_AVR)
  #include <SoftwareSerial.h>
  #include <AVR_specific.h>
#endif

// 简单的ifdef测试
#ifdef ENABLE_DEBUG
  #include <Debug.h>
#endif

// ifndef测试
#ifndef DISABLE_SERVO
  #include <Servo.h>
#endif

// 复杂条件测试
#if defined(ESP32) && defined(ENABLE_WIFI)
  #include <AsyncWebServer.h>
#endif

// 否定条件测试
#if !defined(NO_DISPLAY)
  #include <Display.h>
#endif

void setup() {
  // setup code
}

void loop() {
  // loop code
}
