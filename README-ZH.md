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
npm run blink
```

### 基本使用

```bash
# 编译Arduino项目
ts-node main.ts compile sketch.ino

# 指定开发板
ts-node main.ts compile sketch.ino --board arduino:avr:uno

# 并行编译（8个任务）
ts-node main.ts compile sketch.ino --jobs 8

# 启用详细输出
ts-node main.ts compile sketch.ino --verbose
```

### 缓存管理

```bash
# 查看缓存统计
ts-node main.ts cache-stats

# 清理30天前的缓存
ts-node main.ts cache-clean --days 30

# 清理所有缓存
ts-node main.ts cache

# 禁用缓存编译
ts-node main.ts compile sketch.ino --no-cache
```

## 详细文档

### 编译选项

```bash
Arguments:
  sketch                        Path to Arduino sketch (.ino file)

Options:
  -b, --board <board>           Target board (e.g., arduino:avr:uno) (default: "arduino:avr:uno")
  -p, --port <port>             Serial port for upload
  --sdk-path <path>             Path to Arduino SDK
  --tools-path <path>           Path to additional tools
  --build-path <path>           Build output directory
  --libraries-path <path>       Additional libraries path (default: [])
  --build-property <key=value>  Additional build property (default: {})
  -j, --jobs <number>           Number of parallel compilation jobs (default: "33")
  --verbose                     Enable verbose output (default: false)
  --no-cache                    Disable compilation cache
  --clean-cache                 Clean cache before compilation (default: false)
  -h, --help                    display help for command
```

### 缓存命令

```bash
# 缓存统计
aily-builder cache-stats [--verbose]

# 缓存清理
aily-builder cache-clean [options]
  --days <number>    清理N天前的文件 (默认: 30)
  --pattern <pattern> 文件名模式匹配
  --dry-run          预览模式，不实际删除

# 清空所有缓存
aily-builder cache
```

### 缓存配置

缓存默认存储在：
- **Windows**: `%LOCALAPPDATA%\\aily-builder\\cache`
- **macOS**: `~/Library/Caches/aily-builder`
- **Linux**: `~/.cache/aily-builder`



## 贡献
欢迎提交 Issue 和 Pull Request！

## 许可证

GNU GENERAL PUBLIC LICENSE V3

## 致谢

- [Ninja Build System](https://ninja-build.org/) - 高性能构建系统
- [Tree-sitter](https://tree-sitter.github.io/) - 语法解析器
- [Arduino CLI](https://arduino.github.io/arduino-cli/) - Arduino开发工具
