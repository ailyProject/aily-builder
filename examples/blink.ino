// 简单的Arduino Blink示例
// 用于测试aily编译器
#include <Arduino.h>1112
void setup() {12
  // 初始化内置LED引脚为输出模式
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  // 点亮LED
  digitalWrite(LED_BUILTIN, HIGH);
  delay(1000);  // 等待1秒
  
  // 熄灭LED
  digitalWrite(LED_BUILTIN, LOW);
  delay(1000);  // 等待1秒
}
