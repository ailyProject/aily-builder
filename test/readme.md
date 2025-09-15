# Arduino编译性能测试工具

这是一个用于对比测试 aily-builder、arduino-cli 和 PlatformIO 三种Arduino编译工具性能的测试脚本。

## 功能特性

- 🚀 同时测试三种主流Arduino编译工具
- ⏱️ 精确测量编译时间对比
- 💾 分析Flash和RAM内存使用量
- 📊 详细的性能分析报告
- 🌐 支持中文本地化输出
- 💻 显示系统硬件信息
- 🔧 支持ESP32构建属性配置

## 环境准备

### 1. 编译 aily-builder

在项目根目录执行以下命令编译 aily-builder：

```bash
npm run bundle:native:minify
```

这将生成用于测试的 aily-builder 编译后文件。

### 2. 安装和配置 arduino-cli

参考官方文档：https://arduino.github.io/arduino-cli/1.3/getting-started/

#### Windows 安装步骤：

1. **下载 arduino-cli**
   ```bash
   # 使用 PowerShell 下载
   Invoke-WebRequest -Uri "https://downloads.arduino.cc/arduino-cli/arduino-cli_latest_Windows_64bit.zip" -OutFile "arduino-cli.zip"
   
   # 解压到程序目录
   Expand-Archive -Path "arduino-cli.zip" -DestinationPath "C:\Program Files\Arduino CLI"
   ```

2. **添加到环境变量**
   - 打开系统环境变量设置
   - 在 PATH 中添加：`C:\Program Files\Arduino CLI`
   - 或者通过 PowerShell 添加：
   ```powershell
   $env:PATH += ";C:\Program Files\Arduino CLI"
   ```

3. **初始化配置**
   ```bash
   arduino-cli config init
   arduino-cli core update-index
   
   # 安装AVR核心（用于Arduino Uno等）
   arduino-cli core install arduino:avr
   
   # 安装ESP32核心（如果需要测试ESP32）
   arduino-cli core install esp32:esp32
   
   # 安装Renesas核心（用于Arduino Uno R4）
   arduino-cli core install arduino:renesas_uno
   ```

4. **安装常用库**
   ```bash
   arduino-cli lib install Servo
   arduino-cli lib install WiFi
   arduino-cli lib install ArduinoJson
   ```

### 3. 安装 PlatformIO

1. **安装 PlatformIO Core**
   ```bash
   # 使用 pip 安装
   pip install platformio
   
   # 或者下载 PlatformIO IDE
   ```

2. **验证安装**
   ```bash
   pio --version
   ```

## 项目结构要求

### aily-builder 和 arduino-cli 项目结构

两者使用相同的项目结构，脚本会自动识别需要编译的 `.ino` 文件：

```
D:\codes\aily-builder\examples\blink_sketch\
├── blink_sketch.ino          # 主文件（文件名必须与目录名相同）
├── additional_file.cpp       # 可选：其他源文件
├── header_file.h            # 可选：头文件
└── libraries\               # 可选：项目特定库
```

**示例 blink_sketch.ino：**
```cpp
// 经典的 LED 闪烁示例
void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(1000);
  digitalWrite(LED_BUILTIN, LOW);
  delay(1000);
}
```

### PlatformIO 项目结构

PlatformIO 需要单独创建项目，然后手动复制相同的代码：

```
D:\platformio\esp32s3\
├── platformio.ini           # PlatformIO配置文件
├── src\
│   └── main.cpp            # 主文件（需要手动复制相同代码）
├── lib\                    # 项目库目录
└── include\                # 头文件目录
```

**创建 PlatformIO 项目：**
```bash
# 创建ESP32S3项目
cd D:\platformio
pio project init --board esp32-s3-devkitc-1 --project-dir esp32s3

# 编辑 src/main.cpp，复制相同的Arduino代码
```

**示例 platformio.ini：**
```ini
[env:esp32-s3-devkitc-1]
platform = espressif32
board = esp32-s3-devkitc-1
framework = arduino
monitor_speed = 115200

# ESP32特定配置
build_flags = 
    -DBOARD_HAS_PSRAM
board_build.flash_mode = dio
board_build.flash_freq = 80m
board_build.flash_size = 16MB
board_build.partitions = app3M_fat9M_16MB
board_build.psram = opi
upload_protocol = esptool
upload_speed = 921600
```

## 使用方法

### 基本用法

```bash
# 基本测试（使用默认参数）
ts-node test/compile-test-platformio.ts

# 指定项目路径
ts-node test/compile-test-platformio.ts --project examples/servo_test

# 完整示例：测试ESP32S3项目
ts-node test/compile-test-platformio.ts \
  --project "D:\codes\aily-builder\examples\blink_sketch" \
  --platformio "D:\platformio\esp32s3" \
  --board esp32:esp32:esp32s3
```

### 命令行参数详解

| 参数 | 简写 | 说明 | 默认值 |
|------|------|------|--------|
| `--project` | `-s` | Arduino项目路径 | `examples/blink_sketch` |
| `--platformio` | `-p` | PlatformIO项目路径 | `D:\platformio\blink_sketch` |
| `--board` | `-b` | 开发板FQBN | `arduino:avr:uno` |
| `--jobs` | `-j` | 并行任务数 | `4` |
| `--libraries` | `-l` | 库文件路径 | Arduino默认库路径 |
| `--build-property` | - | 构建属性（可多次使用） | 无 |
| `--verbose` | `-v` | 启用详细输出 | 否 |
| `--help` | `-h` | 显示帮助信息 | - |

### 常用开发板FQBN

| 开发板 | FQBN |
|--------|------|
| Arduino Uno | `arduino:avr:uno` |
| Arduino Nano | `arduino:avr:nano` |
| Arduino Uno R4 WiFi | `arduino:renesas_uno:unor4wifi` |
| ESP32 | `esp32:esp32:esp32` |
| ESP32-S3 | `esp32:esp32:esp32s3` |
| ESP32-C3 | `esp32:esp32:esp32c3` |

### ESP32构建属性示例

```bash
# ESP32 with specific build properties
ts-node test/compile-test-platformio.ts \
  --board esp32:esp32:esp32s3 \
  --build-property build.flash_mode=dio \
  --build-property build.flash_freq=80m \
  --build-property build.flash_size=16MB \
  --build-property build.partitions=app3M_fat9M_16MB \
  --build-property build.PSRAM=opi \
  --build-property upload.maximum_size=3145728
```

## 测试流程

1. **aily-builder 测试**
   - 自动切换到Node.js 18环境
   - 使用aily-builder编译指定项目
   - 记录编译时间和内存使用量

2. **arduino-cli 测试**
   - 使用相同的项目目录
   - 执行arduino-cli编译
   - 解析编译输出获取性能数据

3. **PlatformIO 测试**
   - 切换到PlatformIO项目目录
   - 执行pio run命令
   - 分析编译结果

4. **结果对比**
   - 编译时间对比
   - Flash/RAM使用量对比
   - 二进制文件大小对比
   - 系统硬件信息显示

## 输出示例

```
🧪 Arduino编译性能测试
==================================================

📁 项目路径: D:\codes\aily-builder\examples\blink_sketch
🔧 PlatformIO项目: D:\platformio\esp32s3
🎯 目标板: esp32:esp32:esp32s3
⚙️ 并行任务数: 4

🔧 编译状态
aily-builder:  ✅ 成功
arduino-cli:   ✅ 成功
platformio:    ✅ 成功

⏱️ 编译时间
aily-builder:  6.58 秒
arduino-cli:   5.72 秒
platformio:    3.85 秒
⚡ 相比Arduino-CLI: arduino-cli快 1.15倍
⚡ 相比PlatformIO: platformio快 1.71倍

💾 内存使用量
Flash存储器(程序空间):
  aily-builder:  53.46 KB / 256.00 KB (21%)
  arduino-cli:   53.50 KB / 256.00 KB (20%)
  platformio:    36.53 KB / 256.00 KB (14.3%)
RAM内存(动态内存):
  aily-builder:  6.98 KB / 32.00 KB (22%)
  arduino-cli:   6.98 KB / 32.00 KB (22%)
  platformio:    2.81 KB / 32.00 KB (8.8%)

💻 系统硬件信息
处理器: Intel(R) Core(TM) i7-12700H CPU @ 2.30GHz (24 核心)
系统内存: 16107.87 MB (可用: 2816.59 MB)
操作系统: win32 x64
```

## 故障排除

### 常见问题

1. **找不到arduino-cli命令**
   - 确认arduino-cli已正确安装并添加到PATH
   - 重启终端或命令提示符

2. **aily-builder编译失败**
   - 确认已执行`npm run bundle:native:minify`
   - 检查Node.js版本是否为18.x

3. **PlatformIO项目未找到**
   - 确认PlatformIO项目路径正确
   - 检查platformio.ini文件是否存在

4. **权限错误**
   - 以管理员身份运行命令提示符
   - 检查文件夹权限设置

### 调试选项

```bash
# 启用详细输出查看详细的编译过程
ts-node test/compile-test-platformio.ts --verbose

# 查看帮助信息
ts-node test/compile-test-platformio.ts --help
```

## 注意事项

1. **项目代码一致性**：确保aily-builder、arduino-cli和PlatformIO使用的是相同的源代码，以保证测试结果的准确性。

2. **环境隔离**：测试过程中会顺序执行三个编译工具，避免并行执行导致的资源冲突。

3. **构建缓存**：每次测试会自动清理构建缓存，确保测试结果的一致性。

4. **超时设置**：为防止编译卡死，设置了合理的超时时间（aily-builder 3.3分钟，arduino-cli 30分钟，PlatformIO 5分钟）。

## 扩展用法

### 批量测试不同项目

```bash
# 测试多个示例项目
for project in blink_sketch servo_test wifi_example; do
  echo "Testing $project..."
  ts-node test/compile-test-platformio.ts --project "examples/$project"
done
```

### 性能基准测试

```bash
# 记录测试结果到文件
ts-node test/compile-test-platformio.ts --verbose > test_results_$(date +%Y%m%d_%H%M%S).log 2>&1
```

---

如有任何问题或建议，请查看项目文档或提交Issue。
