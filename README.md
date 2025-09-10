# Aily Builder - Arduino 快速编译工具

> 🚀 基于 Ninja + 智能缓存的高性能 Arduino 编译工具

## ✨ 核心特性

### 🔥 极速编译
- **Ninja构建系统**: 并行编译，最大化CPU利用率
- **智能缓存**: 避免重复编译，显著减少构建时间
- **增量构建**: 只编译修改过的文件
- **多核优化**: 自动检测并利用多核处理器

### 📊 性能提升

| 场景 | 速度提升 | 说明 |
|------|----------|------|
| 首次编译 | 1.0x | 建立缓存基线 |
| 小幅修改 | 3-5x | 大部分文件从缓存恢复 |
| 仅修改主文件 | 5-10x | 只重编译主文件和链接 |
| 完全缓存命中 | 10x+ | 所有文件从缓存恢复 |

### 🎯 智能特性
- **自动依赖分析**: Tree-sitter语法解析，精确依赖检测
- **缓存管理**: 自动维护，支持手动清理
- **跨平台支持**: Windows、macOS、Linux
- **兼容性**: 支持标准Arduino项目结构

## 🚀 快速开始

### 安装

```bash
npm install -g aily-builder
```

### 基本使用

```bash
# 编译Arduino项目
aily-builder compile sketch.ino

# 指定开发板
aily-builder compile sketch.ino --board arduino:avr:uno

# 并行编译（8个任务）
aily-builder compile sketch.ino --jobs 8

# 启用详细输出
aily-builder compile sketch.ino --verbose
```

### 缓存管理

```bash
# 查看缓存统计
aily-builder cache-stats

# 清理30天前的缓存
aily-builder cache-clean --days 30

# 清理所有缓存
aily-builder cache

# 禁用缓存编译
aily-builder compile sketch.ino --no-cache
```

## 📖 详细文档

### 编译选项

```bash
aily-builder compile <sketch> [options]

Options:
  -b, --board <board>         目标开发板 (默认: arduino:avr:uno)
  -p, --port <port>           串口
  --build-path <path>         构建输出目录
  --libraries-path <path>     额外库路径
  -j, --jobs <number>         并行任务数 (默认: CPU核心数+1)
  --verbose                   详细输出
  --use-ninja                 使用Ninja构建系统 (默认: true)
  --use-legacy                使用传统并行编译
  --no-cache                  禁用编译缓存
  --clean-cache               编译前清理缓存
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

## 🔧 配置

### 环境变量

```bash
BUILD_JOBS=8              # 并行编译任务数
BUILD_PATH=/tmp/build     # 构建目录
SKETCH_PATH=sketch.ino    # Arduino sketch路径
SKETCH_NAME=myproject     # 项目名称
```

### 缓存配置

缓存默认存储在：
- **Windows**: `%LOCALAPPDATA%\\aily-builder\\cache`
- **macOS**: `~/Library/Caches/aily-builder`
- **Linux**: `~/.cache/aily-builder`

## 🏗️ 架构设计

### 核心组件

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│ NinjaCompilation│    │  CacheManager   │    │  NinjaGenerator │
│   Pipeline      │◄──►│                 │    │                 │
│                 │    │  • 智能缓存     │    │  • 增量构建     │
│  • 编译流程     │    │  • 自动维护     │    │  • 并行优化     │
│  • 性能优化     │    │  • 分层存储     │    │  • 依赖管理     │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

### 编译流程

```
源文件分析 → 缓存检查 → Ninja构建 → 对象生成 → 缓存存储 → 链接输出
    ↓           ↓           ↓           ↓           ↓           ↓
  依赖解析    缓存命中    并行编译    增量更新    智能存储    固件生成
```

## 📈 性能分析

### 缓存效果示例

```bash
$ aily-builder compile examples/blink.ino --verbose

# 首次编译
🔥 First build (cold build):
✅ Build completed in 2847ms
📊 Cache: 15 files stored

# 第二次编译  
🔥 Second build (warm build):
✅ Build completed in 342ms
🚀 Speed improvement: 8.3x faster
```

### 优化建议

1. **合理设置并行数**: 根据CPU核心数调整 `--jobs` 参数
2. **定期维护缓存**: 使用 `aily-builder cache-clean` 清理过期文件
3. **监控缓存大小**: 使用 `aily-builder cache-stats` 查看缓存状态

## 🔍 故障排除

### 常见问题

**问题**: 编译速度没有提升
```bash
# 解决方案：检查缓存状态
aily-builder cache-stats

# 如果缓存为空，首次编译会建立缓存
# 后续编译将显著加速
```

**问题**: 编译错误
```bash
# 解决方案：清理缓存重新编译
aily-builder cache
aily-builder compile sketch.ino
```

**问题**: 磁盘空间不足
```bash
# 解决方案：清理旧缓存
aily-builder cache-clean --days 7
```

### 调试模式

```bash
# 启用详细日志
aily-builder compile sketch.ino --verbose

# 禁用缓存（调试编译问题）
aily-builder compile sketch.ino --no-cache

# 使用传统编译（性能对比）
aily-builder compile sketch.ino --use-legacy
```

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

### 开发环境

```bash
# 克隆仓库
git clone https://github.com/yourusername/aily-cli3.git

# 安装依赖
npm install

# 构建项目
npm run build

# 运行测试
npm test
```

### 代码规范

- 使用 TypeScript
- 遵循 ESLint 规则
- 添加适当的测试
- 更新相关文档

## 📄 许可证

MIT License

## 🙏 致谢

- [Ninja Build System](https://ninja-build.org/) - 高性能构建系统
- [Tree-sitter](https://tree-sitter.github.io/) - 语法解析器
- [Arduino CLI](https://arduino.github.io/arduino-cli/) - Arduino开发工具

---

**让Arduino开发更快更爽！** 🎉

如果这个工具对你有帮助，请给个 ⭐️ 支持一下！
