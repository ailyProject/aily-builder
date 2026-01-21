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
```

### Basic Usage

```bash
# Compile Arduino project
ts-node main.ts compile sketch.ino

# Specify board
ts-node main.ts compile sketch.ino --board arduino:avr:uno

# Parallel compilation (8 tasks)
ts-node main.ts compile sketch.ino --jobs 8

# With external libraries
ts-node main.ts compile sketch.ino --libraries-path "C:\Arduino\libraries"

# Enable verbose output
ts-node main.ts compile sketch.ino --verbose
```

### Preprocess and Compile Separation

The tool supports separating preprocessing from compilation, which is useful for:
- **CI/CD pipelines**: Run preprocessing once, compile multiple times
- **Parallel builds**: Share preprocessing results across build workers
- **Debugging**: Inspect preprocessing results before compilation
- **Performance optimization**: Skip preprocessing when dependencies haven't changed

#### Preprocessing Only

Perform preprocessing without compilation (dependency analysis, config generation, prebuild hooks):

```bash
# Basic preprocessing
ts-node main.ts preprocess sketch.ino --board arduino:avr:uno

# With external libraries
ts-node main.ts preprocess sketch.ino --board esp32:esp32:esp32 --libraries-path "C:\Arduino\libraries"

# Output as JSON for programmatic use
ts-node main.ts preprocess sketch.ino --output-json

# Save result for later compilation (useful for CI/CD)
ts-node main.ts preprocess sketch.ino --save-result ./preprocess.json
```

#### Compile with Preprocess Result

Use saved preprocessing results to skip the preprocessing phase:

```bash
# Compile using saved preprocess result (skips preprocessing)
ts-node main.ts compile sketch.ino --preprocess-result ./preprocess.json

# Full workflow example
ts-node main.ts preprocess sketch.ino --board arduino:avr:uno --save-result ./preprocess.json
ts-node main.ts compile sketch.ino --board arduino:avr:uno --preprocess-result ./preprocess.json
```

**Preprocessing Steps:**
1. Validate sketch file
2. Extract macros from sketch
3. Parse board and platform configuration
4. Prepare build directory
5. Analyze dependencies
6. Generate compile configuration
7. Run prebuild hooks (if configured)

### Lint / Syntax Check

Multi-mode syntax analysis with fast static check or accurate compiler-based validation:

```bash
# Fast mode - Quick syntax check (~3-5ms, default)
ts-node main.ts lint sketch.ino --board arduino:avr:uno

# Accurate mode - Compiler-based analysis (~3-5s, high precision)
ts-node main.ts lint sketch.ino --mode accurate

# Auto mode - Fast first, then accurate if issues found
ts-node main.ts lint sketch.ino --mode auto

# Different output formats (human, vscode, json)
ts-node main.ts lint sketch.ino --format json
```

### Upload Firmware

```bash
# Upload firmware to Arduino board
ts-node main.ts upload -p COM3 -f firmware.hex --board arduino:avr:uno

# With verbose output
ts-node main.ts upload -p /dev/ttyUSB0 -f firmware.bin --board esp32:esp32:esp32 --verbose
```

### Cache Management

```bash
# View cache statistics
ts-node main.ts cache-stats

# Clean cache older than 30 days
ts-node main.ts cache-clean --days 30

# Preview what would be deleted (dry run)
ts-node main.ts cache-clean --days 7 --dry-run

# Clear all cache
ts-node main.ts cache clear --all

# Compile without cache
ts-node main.ts compile sketch.ino --no-cache
```

## Detailed Documentation

### Compile Command Options

```bash
Arguments:
  sketch                           Path to Arduino sketch (.ino file)

Options:
  -b, --board <board>              Target board (default: "arduino:avr:uno")
  -p, --port <port>                Serial port for upload
  --sdk-path <path>                Path to Arduino SDK
  --tools-path <path>              Path to additional tools
  --build-path <path>              Build output directory
  --libraries-path <path>          Additional libraries path (can be used multiple times)
  --build-property <key=value>     Additional build property (can be used multiple times)
  --build-macros <macro[=value]>   Custom macro definitions (e.g., DEBUG, VERSION=1.0.0)
  --board-options <key=value>      Board menu options (e.g., flash=2097152_0)
  --tool-versions <versions>       Specify tool versions (format: tool1@version1,tool2@version2)
  --preprocess-result <path>       Use preprocess result JSON file (skip preprocessing)
  -j, --jobs <number>              Number of parallel compilation jobs (default: "4")
  --verbose                        Enable verbose output
  --no-cache                       Disable compilation cache
  --clean-cache                    Clean cache before compilation
  --log-file                       Write logs to file in build directory
  -h, --help                       Display help for command
```

### Preprocess Command Options

```bash
Arguments:
  sketch                           Path to Arduino sketch (.ino file)

Options:
  -b, --board <board>              Target board (default: "arduino:avr:uno")
  --sdk-path <path>                Path to Arduino SDK
  --tools-path <path>              Path to additional tools
  --build-path <path>              Build output directory
  --libraries-path <path>          Additional libraries path (can be used multiple times)
  --build-property <key=value>     Additional build property
  --build-macros <macro[=value]>   Custom macro definitions
  --board-options <key=value>      Board menu options
  --tool-versions <versions>       Specify tool versions
  --output-json                    Output preprocess result as JSON
  --save-result <path>             Save full preprocess result to JSON file
  --verbose                        Enable verbose output
  --log-file                       Write logs to file in build directory
  -h, --help                       Display help for command
```

### Lint Command Options

```bash
Arguments:
  sketch                           Path to Arduino sketch (.ino file)

Options:
  -b, --board <board>              Target board (default: "arduino:avr:uno")
  --build-path <path>              Build output directory
  --sdk-path <path>                Path to Arduino SDK
  --tools-path <path>              Path to additional tools
  --libraries-path <path>          Additional libraries path (can be used multiple times)
  --build-property <key=value>     Additional build property
  --build-macros <macro[=value]>   Custom macro definitions
  --board-options <key=value>      Board menu options
  --tool-versions <versions>       Specify tool versions
  --format <format>                Output format: human, vscode, json (default: "human")
  --mode <mode>                    Analysis mode: fast, accurate, auto (default: "fast")
  --verbose                        Enable verbose output
  -h, --help                       Display help for command
```

### Upload Command Options

```bash
Options:
  -b, --board <board>              Target board (default: "arduino:avr:uno")
  -p, --port <port>                Serial port for upload (required)
  -f, --file <file>                Firmware file path (.hex or .bin) (required)
  --build-property <key=value>     Additional build property
  --verbose                        Enable verbose output
  --log-file                       Write logs to file
  -h, --help                       Display help for command
```

### Cache Commands

```bash
# Cache statistics
ts-node main.ts cache-stats [--verbose]

# Cache cleanup
ts-node main.ts cache-clean [options]
  --days <number>     Clean files older than N days (default: 30)
  --pattern <pattern> File name pattern matching
  --dry-run           Preview mode, don't actually delete

# Clear all cache
ts-node main.ts cache clear --all
```

### Build Path Configuration

Build output is stored by default in:
- **Windows**: `%LOCALAPPDATA%\aily-builder\project\<sketchname>_<hash>`
- **macOS**: `~/Library/aily-builder/project/<sketchname>_<hash>`

## Contributing
Issues and Pull Requests are welcome!

## License

GNU GENERAL PUBLIC LICENSE V3

## Acknowledgments

- [Ninja Build System](https://ninja-build.org/) - High-performance build system
- [Tree-sitter](https://tree-sitter.github.io/) - Syntax parser
- [Arduino CLI](https://arduino.github.io/arduino-cli/) - Arduino development tools