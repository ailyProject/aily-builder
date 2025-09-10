#include <lvgl.h>
#include <WiFi.h>

static lv_disp_draw_buf_t draw_buf;
static lv_color_t buf[240 * 10];

void setup() {
  Serial.begin(115200);
  
  // 初始化LVGL
  lv_init();
  
  // 设置显示缓冲区
  lv_disp_draw_buf_init(&draw_buf, buf, NULL, 240 * 10);
  
  // 创建一个简单的标签
  lv_obj_t * label = lv_label_create(lv_scr_act());
  lv_label_set_text(label, "Hello LVGL!");
  lv_obj_align(label, LV_ALIGN_CENTER, 0, 0);
}

void loop() {
  lv_timer_handler();
  delay(5);
}
