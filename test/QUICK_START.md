# 快速开始指南

## 1. 环境准备（5分钟）

```bash
# 1. 编译 aily-builder
npm run bundle:native:minify

# 2. 安装 arduino-cli
winget install ArduinoSA.CLI
# 或下载: https://github.com/arduino/arduino-cli/releases

# 3. 初始化 arduino-cli
arduino-cli config init
arduino-cli core update-index
arduino-cli core install arduino:avr
arduino-cli core install esp32:esp32
arduino-cli lib install Servo
```

## 2. 创建测试项目

### Arduino项目（aily-builder + arduino-cli共用）
```
examples/blink_sketch/
└── blink_sketch.ino
```

### PlatformIO项目
```bash
cd D:\platformio
pio project init --board esp32-s3-devkitc-1 --project-dir esp32s3
# 然后将相同代码复制到 src/main.cpp
```

## 3. 运行测试

```bash
# 基本测试
ts-node test/compile-test-platformio.ts

# ESP32测试
ts-node test/compile-test-platformio.ts \
  --project "examples/blink_sketch" \
  --platformio "D:\platformio\esp32s3" \
  --board esp32:esp32:esp32s3 \
  --build-property build.flash_mode=dio \
  --build-property build.flash_freq=80m
```

就这么简单！详细文档请参考 [README.md](README.md)。