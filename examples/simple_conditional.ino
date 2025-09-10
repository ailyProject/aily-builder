/* 简化的条件编译测试 */

#include <Arduino.h>

// ESP32 平台特定的包含
#if defined(ESP32)
  #include <WiFi.h>
#endif

// 简单的ifdef测试  
#ifdef ENABLE_DEBUG
  #include <Debug.h>
#endif

// ifndef测试
#ifndef DISABLE_SERVO  
  #include <Servo.h>
#endif

// 复杂条件：ESP32 AND WIFI
#if defined(ESP32) && defined(ENABLE_WIFI)
  #include <AsyncWebServer.h>
#endif

// 否定条件
#if !defined(NO_DISPLAY)
  #include <Display.h>
#endif

void setup() {}
void loop() {}
