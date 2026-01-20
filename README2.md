

# Aily Builder - 预处理与编译分离

## 概述

Aily Builder 支持将预处理和编译步骤分离执行。这允许你：
- 先执行预处理（依赖分析、配置生成等），保存结果
- 后续编译时直接使用预处理结果，跳过重复的预处理步骤
- 适用于需要多次编译同一项目的场景，提高效率

## 使用方式

### 原命令（一次性完成预处理和编译）

```bash
ts-node .\main.ts compile "C:\Users\coloz\Documents\aily-project\project_dec24a_356734\.temp\sketch\sketch.ino" \
  --board "esp32:esp32:XIAO_ESP32S3" \
  --libraries-path "C:\Users\coloz\Documents\aily-project\project_dec24a_356734\.temp\libraries" \
  --sdk-path "C:\Users\coloz\AppData\Local\aily-project\sdk\esp32_3.3.1" \
  --tools-path "C:\Users\coloz\AppData\Local\aily-project\tools" \
  --tool-versions "esp-x32@14.2.0,esptool_py@5.1.0,esp32-arduino-libs@5.5.1,ctags@5.8.0"
```

### 分离命令（先预处理，再编译）

#### 步骤 1：预处理并保存结果

```bash
ts-node .\main.ts preprocess "C:\Users\coloz\Documents\aily-project\project_dec24a_356734\.temp\sketch\sketch.ino" \
  --board "esp32:esp32:XIAO_ESP32S3" \
  --libraries-path "C:\Users\coloz\Documents\aily-project\project_dec24a_356734\.temp\libraries" \
  --sdk-path "C:\Users\coloz\AppData\Local\aily-project\sdk\esp32_3.3.1" \
  --tools-path "C:\Users\coloz\AppData\Local\aily-project\tools" \
  --tool-versions "esp-x32@14.2.0,esptool_py@5.1.0,esp32-arduino-libs@5.5.1,ctags@5.8.0" \
  --save-result "D:\project\build\preprocess.json"
```

#### 步骤 2：使用预处理结果进行编译

```bash
ts-node .\main.ts compile "C:\Users\coloz\Documents\aily-project\project_dec24a_356734\.temp\sketch\sketch.ino" \
  --board "esp32:esp32:XIAO_ESP32S3" \
  --preprocess-result "D:\project\build\preprocess.json"
```

## 命令选项说明

### preprocess 命令

| 选项 | 说明 |
|------|------|
| `-b, --board <board>` | 目标开发板 FQBN |
| `--sdk-path <path>` | Arduino SDK 路径 |
| `--tools-path <path>` | 工具路径 |
| `--libraries-path <path>` | 额外库路径（可多次指定） |
| `--tool-versions <versions>` | 工具版本（格式：tool1@version1,tool2@version2） |
| `--save-result <path>` | 保存预处理结果到 JSON 文件 |
| `--output-json` | 以 JSON 格式输出简要结果 |
| `--verbose` | 详细输出 |

### compile 命令

| 选项 | 说明 |
|------|------|
| `--preprocess-result <path>` | 从 JSON 文件加载预处理结果，跳过预处理步骤 |
| 其他选项 | 与原 compile 命令相同 |

## 预处理结果文件

`preprocess.json` 文件包含以下内容：
- `arduinoConfig` - 开发板和平台配置
- `compileConfig` - 编译配置
- `dependencies` - 依赖库列表
- `envVars` - 编译所需的环境变量（工具路径等）
- `preprocessTime` - 预处理耗时

## 注意事项

1. 预处理结果文件包含绝对路径，如果项目或 SDK 路径发生变化，需要重新执行预处理
2. 使用 `--preprocess-result` 时，编译命令仍需指定 `--board` 参数
3. 预处理结果会自动保存所有编译所需的环境变量，编译时会自动恢复