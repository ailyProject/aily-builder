# Aily Builder - Arduino 闪电编译工具

> Arduino闪电编译工具  
> 编译速度远超arduino cli，更优于platformIO  
> 让Arduino再次伟大！  

如果这个工具对你有帮助，请给个 ⭐️ 支持一下！

## 核心特性

### 极速编译
- **超快分析**: 使用Tree-sitter语法解析，精确进行依赖检测
- **构建系统**: 使用Ninja构建系统，并行编译，最大化CPU利用率
- **智能缓存**: 避免重复编译，显著减少构建时间
- **增量构建**: 只编译修改过的文件


## 快速开始

```
npm i -g ts-node
git clone https://github.com/ailyProject/aily-builder
cd aily-builder
npm i
```

### 基本使用

```bash
# 编译Arduino项目
ts-node main.ts compile sketch.ino

# 指定开发板
ts-node main.ts compile sketch.ino --board arduino:avr:uno

# 并行编译（8个任务）
ts-node main.ts compile sketch.ino --jobs 8

# 使用外部库
ts-node main.ts compile sketch.ino --libraries-path "C:\Arduino\libraries"

# 启用详细输出
ts-node main.ts compile sketch.ino --verbose
```

### 预处理与编译分离

该工具支持将预处理与编译分离，适用于以下场景：
- **CI/CD 流水线**: 执行一次预处理，多次编译
- **并行构建**: 在构建节点之间共享预处理结果
- **调试**: 在编译前检查预处理结果
- **性能优化**: 当依赖未变化时跳过预处理

#### 仅预处理

执行预处理但不编译（依赖分析、配置生成、prebuild 钩子）：

```bash
# 基本预处理
ts-node main.ts preprocess sketch.ino --board arduino:avr:uno

# 使用外部库
ts-node main.ts preprocess sketch.ino --board esp32:esp32:esp32 --libraries-path "C:\Arduino\libraries"

# 以JSON格式输出（用于程序化调用）
ts-node main.ts preprocess sketch.ino --output-json

# 保存预处理结果供后续编译使用（适用于CI/CD）
ts-node main.ts preprocess sketch.ino --save-result ./preprocess.json
```

#### 使用预处理结果编译

使用已保存的预处理结果跳过预处理阶段：

```bash
# 使用保存的预处理结果编译（跳过预处理）
ts-node main.ts compile sketch.ino --preprocess-result ./preprocess.json

# 完整工作流示例
ts-node main.ts preprocess sketch.ino --board arduino:avr:uno --save-result ./preprocess.json
ts-node main.ts compile sketch.ino --board arduino:avr:uno --preprocess-result ./preprocess.json
```

**预处理步骤：**
1. 验证 sketch 文件
2. 从 sketch 中提取宏
3. 解析开发板和平台配置
4. 准备构建目录
5. 分析依赖
6. 生成编译配置
7. 运行 prebuild 钩子（如配置）

### 语法检查 (Lint)

多模式语法分析，支持快速静态检查或精确的编译器验证：

```bash
# 快速模式 - 快速语法检查（约3-5毫秒，默认）
ts-node main.ts lint sketch.ino --board arduino:avr:uno

# 精确模式 - 基于编译器的分析（约3-5秒，高精度）
ts-node main.ts lint sketch.ino --mode accurate

# 自动模式 - 先快速检查，发现问题再精确验证
ts-node main.ts lint sketch.ino --mode auto

# 不同输出格式（human、vscode、json）
ts-node main.ts lint sketch.ino --format json
```

### 上传固件

```bash
# 上传固件到Arduino开发板
ts-node main.ts upload -p COM3 -f firmware.hex --board arduino:avr:uno

# 启用详细输出
ts-node main.ts upload -p /dev/ttyUSB0 -f firmware.bin --board esp32:esp32:esp32 --verbose
```

### 缓存管理

```bash
# 查看缓存统计
ts-node main.ts cache-stats

# 清理30天前的缓存
ts-node main.ts cache-clean --days 30

# 预览将被删除的文件（dry run）
ts-node main.ts cache-clean --days 7 --dry-run

# 清理所有缓存
ts-node main.ts cache clear --all

# 禁用缓存编译
ts-node main.ts compile sketch.ino --no-cache
```

## 详细文档

### 编译命令选项

```bash
参数:
  sketch                           Arduino sketch 文件路径 (.ino 文件)

选项:
  -b, --board <board>              目标开发板 (默认: "arduino:avr:uno")
  -p, --port <port>                上传用串口
  --sdk-path <path>                Arduino SDK 路径
  --tools-path <path>              附加工具路径
  --build-path <path>              构建输出目录
  --libraries-path <path>          附加库路径（可多次使用）
  --build-property <key=value>     附加构建属性（可多次使用）
  --build-macros <macro[=value]>   自定义宏定义 (如 DEBUG, VERSION=1.0.0)
  --board-options <key=value>      开发板菜单选项 (如 flash=2097152_0)
  --tool-versions <versions>       指定工具版本 (格式: tool1@version1,tool2@version2)
  --preprocess-result <path>       使用预处理结果 JSON 文件（跳过预处理）
  -j, --jobs <number>              并行编译任务数 (默认: "4")
  --verbose                        启用详细输出
  --no-cache                       禁用编译缓存
  --clean-cache                    编译前清理缓存
  --log-file                       将日志写入构建目录
  -h, --help                       显示帮助信息
```

### 预处理命令选项

```bash
参数:
  sketch                           Arduino sketch 文件路径 (.ino 文件)

选项:
  -b, --board <board>              目标开发板 (默认: "arduino:avr:uno")
  --sdk-path <path>                Arduino SDK 路径
  --tools-path <path>              附加工具路径
  --build-path <path>              构建输出目录
  --libraries-path <path>          附加库路径（可多次使用）
  --build-property <key=value>     附加构建属性
  --build-macros <macro[=value]>   自定义宏定义
  --board-options <key=value>      开发板菜单选项
  --tool-versions <versions>       指定工具版本
  --output-json                    以 JSON 格式输出预处理结果
  --save-result <path>             保存完整预处理结果到 JSON 文件
  --verbose                        启用详细输出
  --log-file                       将日志写入构建目录
  -h, --help                       显示帮助信息
```

### 语法检查命令选项

```bash
参数:
  sketch                           Arduino sketch 文件路径 (.ino 文件)

选项:
  -b, --board <board>              目标开发板 (默认: "arduino:avr:uno")
  --build-path <path>              构建输出目录
  --sdk-path <path>                Arduino SDK 路径
  --tools-path <path>              附加工具路径
  --libraries-path <path>          附加库路径（可多次使用）
  --build-property <key=value>     附加构建属性
  --build-macros <macro[=value]>   自定义宏定义
  --board-options <key=value>      开发板菜单选项
  --tool-versions <versions>       指定工具版本
  --format <format>                输出格式: human, vscode, json (默认: "human")
  --mode <mode>                    分析模式: fast, accurate, auto (默认: "fast")
  --verbose                        启用详细输出
  -h, --help                       显示帮助信息
```

### 上传命令选项

```bash
选项:
  -b, --board <board>              目标开发板 (默认: "arduino:avr:uno")
  -p, --port <port>                上传用串口（必需）
  -f, --file <file>                固件文件路径 (.hex 或 .bin)（必需）
  --build-property <key=value>     附加构建属性
  --verbose                        启用详细输出
  --log-file                       将日志写入文件
  -h, --help                       显示帮助信息
```

### 缓存命令

```bash
# 缓存统计
ts-node main.ts cache-stats [--verbose]

# 缓存清理
ts-node main.ts cache-clean [options]
  --days <number>     清理N天前的文件 (默认: 30)
  --pattern <pattern> 文件名模式匹配
  --dry-run           预览模式，不实际删除

# 清空所有缓存
ts-node main.ts cache clear --all
```

### 构建路径配置

构建输出默认存储在：
- **Windows**: `%LOCALAPPDATA%\aily-builder\project\<sketchname>_<hash>`
- **macOS**: `~/Library/aily-builder/project/<sketchname>_<hash>`



## 贡献
欢迎提交 Issue 和 Pull Request！

## 许可证

GNU GENERAL PUBLIC LICENSE V3

## 致谢

- [Ninja Build System](https://ninja-build.org/) - 高性能构建系统
- [Tree-sitter](https://tree-sitter.github.io/) - 语法解析器
- [Arduino CLI](https://arduino.github.io/arduino-cli/) - Arduino开发工具
