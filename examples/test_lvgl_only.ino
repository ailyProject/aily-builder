#include <lvgl.h>

void setup() {
  Serial.begin(115200);
  
  // 初始化LVGL
  lv_init();
  Serial.println("LVGL initialized");
}

void loop() {
  lv_timer_handler(); 
  delay(5);
}
