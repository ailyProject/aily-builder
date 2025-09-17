# Aily Builder - Arduino Lightning Compilation Tool

[中文](README-ZH.md) | English

> Arduino Lightning Compilation Tool  
> Compilation speed far exceeds Arduino CLI, superior to PlatformIO  
> Make Arduino Great Again!  

If this tool helps you, please give it a ⭐️ for support!

## Core Features

### Lightning-Fast Compilation
- **Ultra-Fast Analysis**: Uses Tree-sitter syntax parsing for precise dependency detection
- **Build System**: Uses Ninja build system with parallel compilation to maximize CPU utilization
- **Smart Caching**: Avoids redundant compilation, significantly reducing build time
- **Incremental Builds**: Only compiles modified files

## Quick Start

```
npm i -g ts-node
git clone https://github.com/ailyProject/aily-builder
cd aily-builder
npm i
npm run blink
```

### Basic Usage

```bash
# Compile Arduino project
ts-node main.ts compile sketch.ino

# Specify board
ts-node main.ts compile sketch.ino --board arduino:avr:uno

# Parallel compilation (8 tasks)
ts-node main.ts compile sketch.ino --jobs 8

# Enable verbose output
ts-node main.ts compile sketch.ino --verbose
```

### Cache Management

```bash
# View cache statistics
ts-node main.ts cache-stats

# Clean cache older than 30 days
ts-node main.ts cache-clean --days 30

# Clear all cache
ts-node main.ts cache

# Compile without cache
ts-node main.ts compile sketch.ino --no-cache
```

## Detailed Documentation

### Compilation Options

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

### Cache Commands

```bash
# Cache statistics
aily-builder cache-stats [--verbose]

# Cache cleanup
aily-builder cache-clean [options]
  --days <number>    Clean files older than N days (default: 30)
  --pattern <pattern> File name pattern matching
  --dry-run          Preview mode, don't actually delete

# Clear all cache
aily-builder cache
```

### Cache Configuration

Cache is stored by default in:
- **Windows**: `%LOCALAPPDATA%\\aily-builder\\cache`
- **macOS**: `~/Library/Caches/aily-builder`
- **Linux**: `~/.cache/aily-builder`

## Contributing
Issues and Pull Requests are welcome!

## License

GNU GENERAL PUBLIC LICENSE V3

## Acknowledgments

- [Ninja Build System](https://ninja-build.org/) - High-performance build system
- [Tree-sitter](https://tree-sitter.github.io/) - Syntax parser
- [Arduino CLI](https://arduino.github.io/arduino-cli/) - Arduino development tools