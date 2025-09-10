// 使用多个库的复杂示例
// 测试依赖分析功能
#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoJson.h>
#include <EEPROM.h>

const char* ssid = "YourWiFiName";
const char* password = "YourWiFiPassword";

WebServer server(80);
DynamicJsonDocument doc(1024);

void setup() {
  Serial.begin(115200);
  
  // 连接WiFi
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(1000);
    Serial.println("Connecting to WiFi...");
  }
  
  Serial.println("WiFi connected!");
  Serial.print("IP address: ");
  Serial.println(WiFi.localIP());
  
  // 设置Web服务器路由
  server.on("/", handleRoot);
  server.on("/api/data", handleApiData);
  server.begin();
  
  Serial.println("HTTP server started");
}

void loop() {
  server.handleClient();
}

void handleRoot() {
  String html = "<html><body>";
  html += "<h1>ESP32 Web Server</h1>";
  html += "<p><a href='/api/data'>Get JSON Data</a></p>";
  html += "</body></html>";
  
  server.send(200, "text/html", html);
}

void handleApiData() {
  // 创建JSON响应
  doc["timestamp"] = millis();
  doc["heap_free"] = ESP.getFreeHeap();
  doc["wifi_rssi"] = WiFi.RSSI();
  
  String jsonString;
  serializeJson(doc, jsonString);
  
  server.send(200, "application/json", jsonString);
}
