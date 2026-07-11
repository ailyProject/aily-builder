# 专用预处理指令扫描器实施方案

## 1. 目标与结论

使用专门面向依赖分析的两阶段引擎替换 `tree-sitter` 和
`tree-sitter-cpp`：

```text
源文件 Buffer
  -> 单遍字节级 DirectiveScanner
  -> 宏无关 PackedDirectiveTape
  -> 按翻译单元宏状态同步回放的 DirectiveExecutor
  -> DependencyAnalyzer / LibraryIndexCache / Ninja
```

核心性能原则：

1. 不解析普通 C/C++ 语法，不构建 AST。
2. 文件后端直接扫描 `Buffer`，不解码整个源文件。
3. 只保留预处理指令的 operand；普通函数、类型、数组和资源数据不进入 IR。
4. 每个唯一文件在一次 preprocess 中最多扫描一次；不同宏环境只重新回放 Tape。
5. 字面量 include、`#ifdef`、`#ifndef`、`#if 0/1` 走专用快路径。
6. include 必须在原位置同步执行；被包含文件修改的宏必须立即影响父文件后续指令。

首版复用现有 `MacroDefinition`、`MacroExpander` 和
`ExpressionEvaluator`。完整 Token MacroVM、数字化 COW 宏环境、跨进程二进制
Tape 缓存和 Rust/N-API 后端，只有基准证明当前实现仍是瓶颈时才启动。

## 2. 正确性契约

### 2.1 翻译阶段

扫描器必须按下列顺序融合预处理所需的翻译阶段：

```text
UTF-8 BOM / dialect
  -> 删除反斜杠换行
  -> 将注释归一化为空白
  -> 识别字符串、字符和 raw string token
  -> 识别逻辑行第一个 preprocessing token 位置的 # 或 %:
  -> 解码该条指令的有效 operand
```

`// comment \` 后的下一物理行仍属于同一行注释，因为续行发生在注释识别前。
字符串、字符和 raw string 内出现的伪 `#include` 不能产生依赖。

### 2.2 include 顺序

- 活动 include 在指令位置同步调用 `onInclude`。
- 同一个翻译单元内，父文件和本地 include 共享同一个宏 Map。
- 输出 include 可以去重，但不能仅因已经输出过就跳过文件执行。
- 每个翻译单元维护 `activeIncludeStack` 和 `onceFiles`。
- `#pragma once` 使用规范化文件身份，不使用 include 拼写或内容 hash。

### 2.3 条件与未知语义

普通未定义标识符在 `#if` 中按 C/C++ 规则为整数 `0`，不属于未知。

表达式详细结果：

```ts
type ExpressionEvaluationResult =
  | { kind: 'known'; value: boolean }
  | { kind: 'indeterminate'; reason: string };
```

无法支持的 builtin、非法 token、求值错误和无法解析的宏 include 必须产生
`indeterminate`。禁止静默按 `false` 处理，因为这会漏依赖。

生产策略采用 exact-or-fallback：

1. 支持范围内走零额外分配的精确快路径。
2. indeterminate 时停止该翻译单元的快速执行，并标记 `fallbackRequired`。
3. 迁移期由结构化诊断和真实编译器依赖结果裁决。
4. 删除 tree-sitter 前，所有真实语料必须为 exact；剩余罕见语法必须有目标编译器
   dependency probe 或明确错误，绝不静默漏报。

### 2.4 缓存边界

- Tape 与宏环境无关，可以跨翻译单元复用。
- 执行结果与宏环境、include 搜索上下文有关，不能只按文件内容缓存。
- `LibraryIndexCache` 继续缓存完整库索引结果。
- 首版只增加一次 preprocess 内的 Tape cache：
  `normalizedPath + size + mtime -> DirectiveTape`。
- 持久化 Tape 必须等冷路径基准证明仍有收益后再实现。

## 3. 模块设计

### 3.1 PreprocessorDirectiveScanner

新增 `src/utils/PreprocessorDirectiveScanner.ts`。

扫描热路径直接读取 `Buffer[i]`，禁止：

- 整文件 `toString()`、`replace()` 或 split；
- 热循环正则；
- 为普通 token 创建对象；
- 保存源文件大 Buffer 的切片引用；
- 扫描或解析普通 C/C++ 语法。

扫描状态至少覆盖：

- BOM、CRLF/LF/CR；
- 反斜杠续行；
- 行注释和块注释；
- 普通字符串、字符字面量和 C++ raw string；
- 逻辑行首空白/注释；
- `#` 和 `%:` 指令起始符。

支持的指令：

- `include`、`include_next`、`import`；
- `define`、`undef`；
- `if`、`ifdef`、`ifndef`；
- `elif`、`elifdef`、`elifndef`、`else`、`endif`；
- `pragma once`。

其他可能影响依赖或宏状态的指令必须产生结构化诊断，不能静默忽略。

扫描器应提前识别直接 `"file.h"` 和 `<file.h>` operand；宏形式只保存清理后的
operand，交给执行器展开。

### 3.2 PackedDirectiveTape

构建期间使用普通 number 数组，扫描结束后一次性转为紧凑并行数组：

```ts
interface DirectiveTape {
  ops: Uint8Array;
  args: Uint32Array;
  jumps: Uint32Array;
  locations: Uint32Array;
  payloads: string[];
  diagnostics: PreprocessorDiagnostic[];
}
```

`args` 指向小型 payload pool；`jumps` 保存条件 false target 或链尾 target。
扫描时配对 `if/elif/else/endif` 并回填跳转，使 inactive 大段能够直接跳过。

首版不实现完整 token pool、basic block、通用字节码 VM 或 symbol interning。

### 3.3 PreprocessorDirectiveExecutor

新增 `src/utils/PreprocessorDirectiveExecutor.ts`。

职责：

- 顺序执行 Tape；
- 维护条件状态或使用预计算 jump；
- 解析 object-like、function-like、variadic define；
- 执行 undef；
- 对宏 include 使用现有 `MacroExpander`；
- 对条件表达式使用现有 `ExpressionEvaluator` 的详细接口；
- 在 include 位置同步回调；
- 输出有序去重 includes、include events、宏 delta、diagnostics；
- 遇到 indeterminate 时设置 `fallbackRequired`。

快路径：

- 字面量 include 不进入 MacroExpander；
- `ifdef/ifndef` 直接查宏 Map；
- `if 0/1` 直接判断；
- 同一个宏 Map 原地修改，不重复复制或重建整张表。

### 3.4 AnalyzeFile 兼容层

`src/utils/AnalyzeFile.ts` 保留以下公共 API：

- `analyzeFile()`
- `analyzeFileWithDefines()`
- `analyzeSourceWithDefines()`
- `AnalysisOptions`
- `AnalysisResult`

文件 API 使用 Buffer 后端；string API 仅为兼容调用方。

`AnalysisResult` 增加可选字段：

- `includeEvents`
- `diagnostics`
- `fallbackRequired`
- `tape`

### 3.5 DependencyAnalyzer 集成

在每次 `preprocess()` 开始时重置本次会话状态：

- `dependencyList`
- `macroDefinitions`
- `libraryMap`
- Tape/source cache
- TU include/once 状态

`analyzeLibraryIncludes()`、source fragment 识别和 sketch build macro 提取复用同一套
扫描结果。删除 `findIncludedCppFiles()`、`findIncludedCFiles()` 的逐行正则实现。

候选源文件筛选和依赖分析必须使用同一个 TU executor；不能只回放单个源文件而忽略
它同步包含的本地头文件链。

`LibraryIndexCache` 的 analyzer schema/version 必须升级，防止旧 AST 结果复用。
其他依赖分析缓存键必须包含 analyzer version 和文件内容身份。

## 4. 实施阶段

### 阶段 0：基线与契约

1. 保存当前真实项目的 include 集合、宏终态、preprocess.json、build.ninja 和耗时。
2. 建立人工语义 fixture。
3. 使用目标 GCC/Clang 的 `.d/-MMD` 和 `-dM -E` 作为最终裁决。

旧 tree-sitter 结果只用于迁移差分，不作为唯一正确答案。

### 阶段 1：Scanner + Tape

1. 实现 Buffer/string 扫描后端。
2. 实现最小词法状态和逻辑行拼接。
3. 实现指令识别、payload 解码、direct include 快路径。
4. 实现条件匹配 jump 和结构诊断。
5. 增加无 Arduino core 依赖的 Node 单元测试。

### 阶段 2：Executor + 兼容层

1. 实现 define/undef/condition/include 执行。
2. 接入现有宏展开和表达式求值器。
3. 支持 `pragma once`、`include_next`、`__has_include(_next)`。
4. 重写 AnalyzeFile 为 scanner/executor 门面。
5. 增加同步 include 修改宏的回归测试。

### 阶段 3：DependencyAnalyzer 与缓存

1. 增加 build-local Tape cache，保证每个唯一文件最多扫描一次。
2. 修复 preprocess 会话状态污染。
3. 合并 `.c/.cpp` fragment 扫描。
4. sketch、library dependency 和 source selection 共用 Tape。
5. 升级 LibraryIndexCache analyzer version。

### 阶段 4：验证与移除 tree-sitter

1. 运行 `npm run build`。
2. 对 AVR、ESP32 Xtensa、ESP32 RISC-V、STM32 运行真实
   `preprocess -> compile`。
3. 对比目标编译器依赖文件，要求漏报为 0。
4. 删除 package dependency/override、lockfile runtime entry 和类型声明。
5. 删除 `bundle-native.js` 的 tree-sitter、tree-sitter-cpp 和只为它们服务的
   node-gyp-build 复制逻辑。
6. 更新中英文 README。

### 阶段 5：仅在 profiler 证明必要后

- 数字 symbol id 和 epoch/COW MacroEnvironment；
- 完整 TokenMacroVM / ExpressionVM；
- 跨进程二进制 Tape cache；
- library catalog/path-state；
- Rust/N-API scanner。

## 5. 测试矩阵

至少覆盖：

- 多层 `if/elif/else/endif` 和父分支 inactive；
- `ifdef/ifndef/elifdef/elifndef`；
- active/inactive 分支中的 define、undef、include；
- object-like、function-like、variadic 宏；
- 宏生成的 quoted/angle include；
- direct include、include_next、import；
- `__has_include` 和 `__has_include_next`；
- 续行出现在关键字、宏名、表达式和 include operand；
- CRLF/LF/CR；
- 行注释、块注释、字符串、字符和 raw string 内伪指令；
- `#pragma once`、普通 include guard、循环 include；
- 本地头文件修改宏后影响父文件后续条件；
- malformed directive、条件栈不平衡和 indeterminate；
- 活动/非活动分支中的 `.c/.cpp` fragment include；
- 同一 DependencyAnalyzer 实例连续 preprocess 的状态隔离。

## 6. 性能验收

- Scanner 吞吐不低于 250 MiB/s，目标 500 MiB/s。
- 每个唯一文件每次 preprocess 最多扫描一次。
- 宏环境变化造成 0 次重新扫描。
- 无指令文件返回共享空 Tape。
- direct literal include 不进入通用宏展开器。
- cold `analyzeDependencies` 至少提升 5 倍，目标 10 倍。
- warm cache 相比当前实现退化不超过 5%。
- 峰值 RSS 目标下降至少 30%。
- 对编译器 `.d` 的依赖漏报必须为 0。

绝对耗时只用于同机验收；CI 使用语义、扫描次数、相对基准和性能退化阈值。

## 7. 范围边界

- 不解析模板、函数体、类型和普通表达式。
- 首版不改变现有 quoted/angle 本地 include 搜索优先级。
- 不把宏环境相关的执行结果错误地缓存成文件级结果。
- 不保留 tree-sitter 作为最终生产 fallback。

## 8. 当前实施状态与实测结果（2026-07-12）

### 8.1 已完成

- 已实现 `PreprocessorDirectiveScanner`：直接扫描 `Buffer`，生成 typed-array
  Tape，并覆盖逻辑行拼接、注释/字符串/raw string、direct/macro include、条件 jump。
- 已实现 `PreprocessorDirectiveExecutor`：按源顺序执行 define/undef/条件/include，
  支持同步 include 回调、`pragma once`、宏 include 和 `__has_include`。
- 已将 `AnalyzeFile` 改为兼容门面，并将 `DependencyAnalyzer`、library source
  selection 和 fragment 识别接到同一份 build-local Tape cache。
- 已重置每次 preprocess 的会话状态，并将依赖分析缓存键升级到
  `dependency-directive-tape-v2`。
- 已从生产依赖、TypeScript 声明和 native bundle 中移除旧 C/C++ AST 运行时及其
  native 复制逻辑；对象缓存、library index cache 与 archive cache 保持不变。

### 8.2 当前验收证据

- `npm run build`：通过。
- `npm run bundle:native:minify`：通过，产物 907.2 KB、4 个文件，只包含启动入口、
  主程序、package metadata 与 Ninja。
- 源码和 bundled CLI 的 `--help` 均只列出构建、预处理、清理、上传和缓存命令。
- 32 MiB 合成语料：p50 132.640 ms，241.28 MiB/s。
- LVGL 真实语料：1,153 文件、23,427,337 字节、37,014 条指令，p50
  117.412 ms，190.29 MiB/s。
- ESP32-S3 真实项目 bundled preprocess：7 个依赖；与既有基线逐库、逐源文件
  完全一致（core 54、variant 0、lvgl 544、esp32xzai 63、WiFi 8、Network 6、
  Preferences 1，双向差集均为 0）。warm preprocess 为 1.303 秒。
- 同一份 exact 依赖结果已完成 685 个 Ninja 任务的真实编译并生成 ELF、BIN、
  merged BIN；因此本轮不是仅通过静态 fixture。

### 8.3 尚未冒充完成的门槛

- 纯 TypeScript scanner 已接近但尚未稳定达到 250 MiB/s；真实语料当前约
  190 MiB/s。继续复制 Buffer 专用状态机或引入 native addon 之前，必须先由
  end-to-end profiler 证明 scanner 仍是主要瓶颈。
- active indeterminate 条件当前采用 fail-closed（抛出并标记
  `fallbackRequired`），不会静默漏依赖；目标编译器自动 fallback 尚未接入生产链路。
- `include_next/__has_include_next` 的 search-index、ESP response/sdkconfig 完整宏面、
  `push_macro/pop_macro` 和 symlink realpath 身份仍列为正确性增强项。
- AVR、ESP32 RISC-V、STM32 的 `.d` 差分、cold/warm/RSS 统一 CI 矩阵仍属于阶段 4
  发布门槛；本轮已完成 ESP32-S3 的真实 preprocess 与 compile 闭环。
