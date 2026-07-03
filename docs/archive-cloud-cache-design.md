# archive-cloud-cache 云端归档缓存设计

## 结论

本项目可以实现跨项目复用 `.a` 归档缓存，但不能只用“库目录 hash”或“.a 文件 hash”来判断是否复用。安全的复用单元应该是 `archiveBuildKey`：由库源码、开发板配置、SDK/工具链版本、宏定义、编译参数、include 顺序、响应文件内容等完整编译上下文共同计算。

最终采用一个本地目录：

```text
archive-cloud-cache
```

它同时作为：

- 本机编译时读取的归档缓存。
- 开启生成开关后，本机编译成功写入新 `.a` 的目录。
- 人工或外部同步工具上传到云端的源目录。

生成云缓存必须有单独开关，源码默认关闭。也就是说，程序可以读取已有缓存来加速编译，但不会默认把本次编译生成的 `.a` 写入 `archive-cloud-cache`。只有显式传入 `--generate-archive-cloud-cache`、设置对应环境变量，或使用“默认开启生成云缓存”的专用打包产物时，才生成可上传的云缓存条目。

不再引入独立 `outbox`。云端缓存获取 URL 必须做成可配置参数。默认远程读取 base URL 为：

```text
https://cache.aily.pro/v1
```

路径中不再保留 `sha256` 层。hash 算法写入 manifest 元数据，路径只表达缓存协议版本和 key 分片。

## 现有方案的主要缺陷与修正

### 缺陷 1：只 hash 库源码会误命中

同一个库目录在不同开发板、SDK、宏定义、include 顺序、`build_opt.h`、`file_opts`、项目配置头下可能生成不同 `.a`。

修正：

- 查找 key 使用 `archiveBuildKey`，不是 `librarySourceHash`。
- `librarySourceHash` 只是 `archiveBuildKey` 的一个输入。
- 对可能影响编译结果的项目配置头单独纳入 `projectConfigHeaderHash`。

### 缺陷 2：`.a` 文件 hash 不能作为查找 key

命中前还没有 `.a` 文件，不能先算 `.a` hash 再查缓存。

修正：

- `archiveBuildKey = sha256(canonicalJson(archiveBuildInputs))`。
- `.a` 的 `artifactSha256` 只用于下载后或读取后的完整性校验。

### 缺陷 3：直接恢复 `.a` 但不改 Ninja 图会重新编译

当前 `NinjaGenerator` 会根据 dependency 的 source files 生成 compile edges，再生成 archive edge。如果只把命中的 `.a` 放进 `.build`，但没有告诉 `NinjaGenerator` 该 dependency 已命中，Ninja 仍可能因为 `.o` 不存在而重新编译。

修正：

- 在生成 `build.ninja` 前计算并恢复 archive hits。
- 把 `archiveCacheHits` 传给 `NinjaGenerator`。
- 命中的 `core` 或 library 不生成源文件 compile edges，也不生成 archive edge，但仍加入最终 link inputs。

### 缺陷 4：当前对象缓存 key 逻辑不能直接照搬

当前对象缓存的参数处理会排序参数，并且用编译器文件 mtime 近似版本。对 `.a` 云缓存来说这不够稳：

- `-I` 顺序影响同名头文件解析，不能排序。
- `-include` 和 `@response-file` 的顺序也可能影响结果。
- 编译器 mtime 不能稳定代表版本。

修正：

- archive key 保留有效编译参数顺序。
- 编译器版本优先执行 `compiler --version`，并结合可执行文件 hash 或工具包 manifest hash。
- response file 使用文件内容 hash，而不是路径。

### 缺陷 5：直接上传整个 cache 有半成品风险

如果上传工具扫描到 `.tmp` 或一个尚未完整写入的目录，云端可能出现 manifest 有了但 `.a` 不完整的情况。

修正：

- 本地写入必须先写 `.tmp`，校验后原子 move 到最终目录。
- 云端上传顺序必须是 `.a`、`inputs.json`、最后 `manifest.json`。
- 编译端以 `manifest.json` 是否存在作为条目可见标志。

### 缺陷 6：云端默认读取可能拖慢离线编译

如果每个库 miss 都等待网络超时，离线环境会明显变慢。

修正：

- manifest 请求使用短超时。
- 记录本轮网络失败状态，失败后本次编译不再继续请求云端。
- 任何云端错误都降级为 miss，不影响本地编译。

## 当前代码接入点

当前源码已经有适合接入的结构：

- `src/NinjaGenerator.ts` 会把 `core` 和 library 的 `.o` 归档为 `.a`。
- `core` 输出为 `core.a`，普通库输出为 `<libraryName>.a`。
- `src/NinjaCompilationPipeline.ts` 在生成 Ninja 文件前会恢复对象缓存；archive cache 应插在对象缓存之前。
- `src/DependencyAnalyzer.ts` 已经解析出 `Dependency[]`，其中包含 `name`、`path`、`type`、`includes`、`others`。
- `src/LibraryIndexCache.ts` 已经有库内容 hash 和分片目录的思想，但它缓存的是库扫描结果，不是 `.a` 产物。

建议新增独立模块：

```text
src/ArchiveCloudCacheManager.ts
```

不要把归档缓存合并进 `CacheManager`。`CacheManager` 面向单个 `.o`，而 `ArchiveCloudCacheManager` 面向完整 archive 单元，两者 key、校验、存储格式和生命周期都不同。

## 目录结构

默认本地目录：

```text
Windows: %LOCALAPPDATA%\aily-builder\archive-cloud-cache
macOS:   ~/Library/Caches/aily-builder/archive-cloud-cache
Linux:   ~/.cache/aily-builder/archive-cloud-cache
```

目录结构：

```text
archive-cloud-cache/
  v1/
    ab/
      cd/
        abcdef012345.../
          manifest.json
          inputs.json
          WiFi.a
  .tmp/
    <pid>-<timestamp>-<random>/
  state/
    cloud-negative-cache.json
```

说明：

- `abcdef012345...` 是完整 `archiveBuildKey`。
- `ab` 是 key 的前 2 位。
- `cd` 是 key 的第 3 到第 4 位。
- `.tmp/` 只用于原子写入，不上传。
- `state/` 只保存本机状态，不上传。

云端对象 URL 模板：

```text
<remoteCacheBaseUrl>/ab/cd/<archiveBuildKey>/manifest.json
<remoteCacheBaseUrl>/ab/cd/<archiveBuildKey>/<archiveName>.a
<remoteCacheBaseUrl>/ab/cd/<archiveBuildKey>/inputs.json
```

默认配置下等价于：

```text
https://cache.aily.pro/v1/ab/cd/<archiveBuildKey>/manifest.json
https://cache.aily.pro/v1/ab/cd/<archiveBuildKey>/<archiveName>.a
https://cache.aily.pro/v1/ab/cd/<archiveBuildKey>/inputs.json
```

## 缓存对象范围

第一阶段缓存：

- `core.a`
- 每个从源码编译出来的 library archive，例如 `WiFi.a`、`Network.a`、`Preferences.a`、`lvgl.a`

暂不缓存：

- sketch 对象或 sketch archive。用户代码变化频繁，复用价值低，误命中风险高。
- 当前 variant `.o`。现有 Ninja 逻辑是直接把 variant object 放进 link inputs，不会归档成 `variant.a`。
- 库自带的预编译 `.a`。这类 `.a` 是输入，不是本项目生成的产物，继续由 `DependencyAnalyzer` 和 link flags 处理。

后续可选：

- 如果 variant 编译耗时明显，可以新增 `variant.a`，然后纳入相同机制。
- 如果某些 sketch 生成文件稳定，可以另做 final artifact cache，不要混入 library archive cache。

## archiveBuildKey

查找 key：

```text
archiveBuildKey = sha256(canonicalJson(archiveBuildInputs))
```

`canonicalJson` 要求：

- object key 按字典序输出。
- 数组只在语义无序时排序；编译参数、include 路径、link 参数必须保留顺序。
- 路径统一使用 `/`。
- 不写入用户私有绝对路径，除非绝对路径本身会影响编译结果。

### archiveBuildInputs 示例

```json
{
  "schema": "aily.archive-build-inputs.v1",
  "target": {
    "kind": "library",
    "name": "WiFi",
    "archiveName": "WiFi.a"
  },
  "builder": {
    "keyVersion": "archive-cloud-cache-v1"
  },
  "board": {
    "fqbn": "esp32:esp32:esp32s3:PSRAM=opi,FlashMode=qio",
    "build": {
      "mcu": "esp32s3",
      "arch": "ESP32",
      "core": "esp32",
      "variant": "esp32s3"
    }
  },
  "toolchain": {
    "c": "xtensa-esp32s3-elf-gcc",
    "cpp": "xtensa-esp32s3-elf-g++",
    "ar": "xtensa-esp32s3-elf-ar",
    "cVersion": "...",
    "cppVersion": "...",
    "arVersion": "..."
  },
  "sdk": {
    "identity": "esp32@3.2.1",
    "toolPackages": [
      "esp32-arduino-libs@5.4.1"
    ]
  },
  "compile": {
    "effectiveCompileArgs": {
      "c": "-MMD -c ...",
      "cpp": "-MMD -c ...",
      "s": "-MMD -c ..."
    },
    "responseFilesHash": "..."
  },
  "sources": {
    "sourceHash": "...",
    "projectConfigHeaderHash": "..."
  }
}
```

### 必须纳入 key 的因素

开发板：

- 完整 `build.fqbn`，包含菜单选项。
- `build.mcu`、`build.arch`、`build.core`、`build.variant`。
- 用户传入的 `buildProperties`。

工具链：

- C/C++ compiler 命令和真实版本。
- `ar` 命令和真实版本。
- 不把 `COMPILER_PATH`、`TOOLS_PATH` 或编译器二进制 hash 作为 key 输入；这些更适合放进 manifest 诊断信息。

SDK：

- 优先使用 preprocess 阶段得到的 SDK identity，例如 `esp32@3.2.1`。
- 优先使用实际参与 compile 的工具包 identity，例如 `esp32-arduino-libs@5.4.1`。
- 只在拿不到可信 SDK identity 时，才 fallback 到 `platform.txt` / `boards.txt` 内容 hash。
- 不把 `ctags`、`esptool_py` 等未参与 `.a` 编译的工具版本纳入 key。
- 不把 `SDK_PATH`、`runtime.platform.path`、`COMPILER_SDK_PATH` 这类安装路径作为 key 输入。

编译参数：

- 展开后的 compile command。
- `-D` 宏定义。
- `-I` include 路径顺序。
- `-include` 参数。
- `@response-file` 内容。
- optimization、CPU、ABI、C++ standard、exception/RTTI 等 flags。

源码：

- 该 archive 内实际参与编译的 `.c`、`.cpp`、`.S`、`.s`。
- 库内 `.h`、`.hpp`、`.hh`。
- `library.properties`。
- 被库源码间接包含且会影响编译的头文件。

项目配置头：

这些文件经常影响 `.a` 内容，不能忽略：

```text
lv_conf.h
User_Setup.h
config.h
sdkconfig.h
build_opt.h
file_opts
```

策略：

- MVP 可以保守扫描 include path 中与库相关的配置头候选。
- 命中率可以低一点，不能误命中。
- 后续再用 depfile 或 compiler `-MMD` 结果做精确 transitive header tracking。

## manifest.json

每个缓存条目必须有 `manifest.json`：

```json
{
  "schema": "aily.archive-cache.v1",
  "keyAlgorithm": "sha256",
  "key": "abcdef012345...",
  "createdAt": "2026-07-03T00:00:00.000Z",
  "origin": "local-build",
  "target": {
    "kind": "library",
    "name": "WiFi",
    "archiveName": "WiFi.a"
  },
  "artifact": {
    "file": "WiFi.a",
    "sha256": "...",
    "size": 123456
  },
  "inputs": {
    "file": "inputs.json",
    "sha256": "..."
  },
  "builder": {
    "ailyBuilderVersion": "1.2.3",
    "keyVersion": "archive-cloud-cache-v1"
  }
}
```

校验要求：

- manifest 的 `key` 必须等于当前计算出的 `archiveBuildKey`。
- `artifact.file` 必须等于预期 archive name。
- `.a` 文件 size 和 sha256 必须匹配。
- `inputs.json` 可按需校验，但本地最终落盘应保存完整。

## inputs.json

`inputs.json` 保存完整 `archiveBuildInputs`，用于：

- 排查为什么缓存没有命中。
- 对比两个 key 的差异。
- 未来升级 key 规则时迁移或诊断。

注意：

- 不写入 secret。
- 不写入用户私有绝对路径，优先写 SDK/tool/library identity。
- 如果必须写路径，写经过归一化的路径和该路径下关键文件 hash。

## 编译命中流程

编译时流程：

```text
preprocess
  -> dependencies + compileConfig
compute archiveBuildInputs per archive
restore local archive hits
restore remote archive hits
restore object cache hits
generate build.ninja with archiveCacheHits
run prelink hooks
run ninja
store newly built archives on success, only when generate switch is enabled
```

详细步骤：

1. `preprocess` 得到 `Dependency[]` 和 `compileConfig`。
2. 对每个 `core` 和 library dependency 计算 `archiveBuildInputs`。
3. 计算 `archiveBuildKey`。
4. 查询本地 `archive-cloud-cache/v1/ab/cd/<key>/manifest.json`。
5. 本地命中后校验 manifest 和 `.a`。
6. 本地 miss 时按配置的 `remoteCacheBaseUrl` 查询 `<remoteCacheBaseUrl>/ab/cd/<key>/manifest.json`。
7. 云端 manifest 命中后下载 `.a` 到 `.tmp/`。
8. 校验 `.a` sha256 和 size。
9. 将完整条目原子移动到本地 cache。
10. 将 `.a` 硬链接或复制到当前 build path。
11. 记录 `ArchiveCacheHit`。
12. 生成 Ninja 文件时跳过命中 archive 的编译边。

云端失败策略：

- 404 是正常 miss。
- 网络超时、5xx、TLS 错误都视为 miss。
- 本轮首次网络错误后，可以禁用本轮后续远程请求。
- 不允许因为 cache 服务失败导致编译失败。

## 编译未命中流程

未命中时保持现有 Ninja 行为：

1. 源文件编译为 `.o`。
2. Ninja 归档为 `core.a` 或 `<libraryName>.a`。
3. 链接生成最终固件。
4. 如果开启了 `--generate-archive-cloud-cache`，则在完整编译成功后把新 `.a` 写入 `archive-cloud-cache`。

默认不生成新缓存。开启生成后，也不要在 archive 刚生成时立即发布缓存。后续链接失败可能暴露 key 漏项，过早缓存会扩大错误影响。

## Ninja 集成设计

新增类型：

```ts
export interface ArchiveCacheHit {
  dependencyName: string;
  dependencyType: 'core' | 'library';
  archiveName: string;
  buildArchivePath: string;
  cacheKey: string;
  source: 'local' | 'remote';
}
```

`NinjaOptions` 增加：

```ts
archiveCacheHits?: Map<string, ArchiveCacheHit>;
```

key 建议：

```text
<dependency.type>:<dependency.name>
```

`NinjaGenerator.generateBuilds()` 修改规则：

- sketch 永远正常处理。
- variant 保持现状。
- 如果 `core:core` 命中：
  - 不生成 core 源文件 compile build。
  - 不生成 `core.a` archive build。
  - 确保 `core.a` 作为 link implicit 依赖存在。
- 如果 `library:<name>` 命中：
  - 不生成该库源文件 compile build。
  - 不生成 `<name>.a` archive build。
  - 把 `<name>.a` 加入 `objectFiles`，让 link 使用它。

`NinjaCompilationPipeline.compile()` 推荐顺序：

```ts
const archiveHits = await archiveCloudCache.restoreArchives(dependencies, compileConfig);
const objectCacheHits = await this.restoreFromCache(dependencies, archiveHits);
const ninjaFilePath = await this.ninjaGenerator.generateNinjaFile({
  dependencies,
  compileConfig,
  buildPath,
  jobs,
  skipExistingObjects: true,
  archiveCacheHits: archiveHits
});
```

对象缓存恢复也应跳过 archive 命中的 dependency，避免无意义恢复大量 `.o`。

## ArchiveCloudCacheManager 接口

建议最小接口：

```ts
class ArchiveCloudCacheManager {
  isEnabled(): boolean;
  shouldGenerate(): boolean;
  computeInputs(target: ArchiveTarget, context: CompileContext): Promise<ArchiveBuildInputs>;
  computeKey(inputs: ArchiveBuildInputs): string;
  getEntryDir(key: string): string;
  restore(input: ArchiveBuildInputs, targetArchivePath: string): Promise<ArchiveCacheHit | null>;
  store(input: ArchiveBuildInputs, sourceArchivePath: string): Promise<void>;
  verifyEntry(entryDir: string, expectedKey: string, archiveName: string): Promise<boolean>;
}
```

`restore()` 内部顺序：

1. `restoreLocal()`。
2. `restoreRemote()`。
3. 校验。
4. 落盘到 build path。

调用方只接收可信 hit。

## 原子写入

本地写入流程：

```text
archive-cloud-cache/.tmp/<pid>-<timestamp>-<random>/
  manifest.json
  inputs.json
  WiFi.a
```

步骤：

1. 写入 `.a`。
2. 计算 `.a` sha256 和 size。
3. 写入 canonical `inputs.json`。
4. 计算 `inputs.json` sha256。
5. 写入 `manifest.json`。
6. 再次读取校验。
7. 原子移动到 `archive-cloud-cache/v1/ab/cd/<key>/`。

最终目录已存在时：

- 如果 manifest 和 artifact hash 一致，跳过。
- 如果 key 相同但 artifact hash 不同，保留已有条目，记录 warning，拒绝覆盖。

## 云端读取

远程缓存获取 base URL 可配置：

```text
--archive-cloud-cache-url <url>
AILY_BUILDER_ARCHIVE_CLOUD_CACHE_URL=<url>
```

请求：

```text
GET <baseUrl>/ab/cd/<key>/manifest.json
GET <baseUrl>/ab/cd/<key>/<archiveName>.a
GET <baseUrl>/ab/cd/<key>/inputs.json
```

默认值：

```text
https://cache.aily.pro/v1
```

建议：

- manifest 请求超时 1 到 2 秒。
- artifact 下载按大小设置超时。
- 下载先写 `.tmp`。
- 下载后必须校验 sha256。
- 可以维护短期 negative cache，避免同一次编译反复请求不存在的 key。

## 人工上传

直接上传本地缓存源目录：

```text
archive-cloud-cache/v1/
```

上传规则：

- 跳过 `.tmp/`。
- 跳过 `state/`。
- 跳过锁文件和统计文件。
- 不覆盖云端已有同路径 manifest。
- 上传顺序：`.a` -> `inputs.json` -> `manifest.json`。

推荐同步过滤：

```text
include: v1/**/*.a
include: v1/**/inputs.json
include: v1/**/manifest.json
exclude: .tmp/**
exclude: state/**
exclude: **/*.lock
```

为什么最后上传 manifest：

- 编译端以 manifest 是否存在判断缓存条目是否可见。
- 如果上传中断，没有 manifest 的半成品不会被读取。

## CLI 与环境变量

新增 compile 参数：

```text
--archive-cloud-cache <path>
--no-archive-cloud-cache
--archive-cloud-cache-url <url>
--archive-cloud-cache-local-only
--generate-archive-cloud-cache
```

建议默认：

- 本地 archive cache 默认开启。
- 云端读取 URL 由 `--archive-cloud-cache-url <url>` 或 `AILY_BUILDER_ARCHIVE_CLOUD_CACHE_URL` 配置，默认值为 `https://cache.aily.pro/v1`。
- 如果用户配置 `--archive-cloud-cache-local-only`，则不请求云端。
- 生成新云缓存默认关闭。
- 只有传入 `--generate-archive-cloud-cache` 时，编译成功后才写入新的 `manifest.json`、`inputs.json` 和 `.a`。
- 未开启生成时，缓存系统是只读优化路径：可以 restore local/remote hits，但不会产生新的上传源条目。

环境变量：

```text
AILY_BUILDER_ARCHIVE_CLOUD_CACHE=1
AILY_BUILDER_ARCHIVE_CLOUD_CACHE_DIR=...
AILY_BUILDER_ARCHIVE_CLOUD_CACHE_URL=https://cache.aily.pro/v1
AILY_BUILDER_ARCHIVE_CLOUD_CACHE_LOCAL_ONLY=0
AILY_BUILDER_GENERATE_ARCHIVE_CLOUD_CACHE=0
```

打包参数：

```text
node bundle-native.js --minify --generate-archive-cloud-cache-default
npm run bundle:native:minify:generate-cache
```

打包行为：

- 普通源码运行和普通 `bundle:native:minify` 仍然默认不生成新云缓存。
- 使用 `--generate-archive-cloud-cache-default` 打出的 bundle，会在 `dist/bundle-min/index.js` 启动壳中默认设置 `AILY_BUILDER_GENERATE_ARCHIVE_CLOUD_CACHE=1`。
- 启动壳只在该环境变量未设置时注入默认值；如果运行环境显式设置 `AILY_BUILDER_GENERATE_ARCHIVE_CLOUD_CACHE=0`，则以运行环境为准。
- 也可以用 `AILY_BUILDER_BUNDLE_GENERATE_ARCHIVE_CLOUD_CACHE=1` 触发相同的打包行为，便于 CI 中配置。

## 清理策略

本地缓存会持续增长，需要清理。

建议本地 state 记录：

```json
{
  "lastAccessAt": "2026-07-03T00:00:00.000Z",
  "accessCount": 12,
  "lastVerifiedAt": "2026-07-03T00:00:00.000Z",
  "source": "local-build"
}
```

清理策略：

- 高水位触发，例如超过 20 GB。
- 清理到低水位，例如 12 GB。
- 优先删除最久未访问条目。
- `.tmp/` 中超过 24 小时的目录直接删除。
- 不删除当前进程锁定的条目。

云端清理不由 `aily-builder` 负责，但本地 manifest 可为云端生命周期策略提供 `createdAt`、`origin`、`size`。

## 验证矩阵

必须验证这些场景：

| 场景 | 预期 |
| --- | --- |
| 同一项目同一配置重复编译 | 第二次 archive hit |
| 删除 `.build` 后重复编译 | 仍然 archive hit |
| 修改库 `.cpp` | miss |
| 修改库 `.h` | miss |
| 修改 `lv_conf.h` 等项目配置头 | miss |
| 修改 `--build-macros` | miss |
| 修改 FQBN 菜单项 | miss |
| 修改 SDK 版本 | miss |
| 修改 compiler/toolchain 版本 | miss |
| 云端 404 | miss 并继续本地编译 |
| 云端 `.a` sha256 错误 | 拒绝使用并继续本地编译 |
| 云端超时 | 本轮禁用远程请求并继续本地编译 |
| 本地 cache 条目损坏 | 删除或隔离该条目后继续编译 |
| archive hit 的 library | Ninja 不生成该库 compile/archive edges |

额外建议：

- 对同一输入分别执行“无 archive cache 编译”和“archive hit 编译”，比较最终 `.elf` 或 `.bin`。
- 如果二进制不完全一致，至少比较 map 文件和符号表，确认差异来自时间戳或非确定性归档，而不是链接内容变化。

## 分阶段实现

### P0：实现显式生成本地缓存条目

目标：

- 不改变编译行为。
- 默认不生成缓存。
- 传入 `--generate-archive-cloud-cache` 后，编译成功生成 `archive-cloud-cache` 条目。

改动：

- 新增 `ArchiveCloudCacheManager`。
- 实现 `archiveBuildInputs` 和 `archiveBuildKey`。
- 增加生成开关解析，默认值为 false。
- 仅在生成开关开启且完整编译成功后，存储 `core.a` 和 library `.a`。
- 写入 manifest 和 inputs。

验收：

- 同一输入生成同一 key。
- 修改宏、开发板、SDK、库源码后 key 改变。
- 文件写入使用 `.tmp` 和原子 move。
- 未传入 `--generate-archive-cloud-cache` 时，不创建新的 cache 条目。
- 传入 `--generate-archive-cloud-cache` 时，才创建可上传条目。

### P1：本地恢复命中

目标：

- 本地 cache 命中时跳过对应 archive 编译。

改动：

- `NinjaCompilationPipeline` 先恢复 archive cache。
- `NinjaGenerator` 接收 `archiveCacheHits`。
- 对命中 dependency 跳过 compile/archive edges。

验收：

- 第二次编译日志出现 archive hit。
- `build.ninja` 中不再出现命中库的源文件 compile edge。
- 最终固件正确。

### P2：可配置 URL 的云端只读命中

目标：

- 本地 miss 时从配置的远程缓存 URL 下载，默认 URL 为 `https://cache.aily.pro/v1`。

改动：

- 增加 URL 配置，支持 `--archive-cloud-cache-url <url>` 和 `AILY_BUILDER_ARCHIVE_CLOUD_CACHE_URL`。
- 下载 manifest 和 artifact。
- 校验后落入本地 cache。

验收：

- 清空本地 cache，云端有条目时可命中。
- 云端错误不影响编译。
- hash 错误不会被使用。

### P3：统计和清理

目标：

- 支撑长期使用。

改动：

- 增加 hit/miss/download/store/verify-failed 统计。
- 增加 cache size 统计。
- 增加高低水位清理。

验收：

- 大量条目下目录扫描不会明显拖慢编译。
- 清理不会删除当前编译正在使用的条目。

## 推荐日志

默认 info：

```text
[ARCHIVE_CLOUD_CACHE] local hits=5 remote hits=1 misses=3
[ARCHIVE_CLOUD_CACHE] generate=off stored archives=0
```

debug：

```text
[ARCHIVE_CLOUD_CACHE] key WiFi.a abcdef...
[ARCHIVE_CLOUD_CACHE] local hit WiFi.a abcdef...
[ARCHIVE_CLOUD_CACHE] remote hit WiFi.a abcdef...
[ARCHIVE_CLOUD_CACHE] miss WiFi.a abcdef...
[ARCHIVE_CLOUD_CACHE] restored WiFi.a -> .build/WiFi.a
[ARCHIVE_CLOUD_CACHE] generate disabled, skip storing WiFi.a
[ARCHIVE_CLOUD_CACHE] stored WiFi.a abcdef...
[ARCHIVE_CLOUD_CACHE] verify failed WiFi.a abcdef...
```

## 最终建议

第一版实现要偏保守：

- key 宁可包含更多输入导致 miss，也不要漏输入导致误命中。
- 生成云缓存必须显式开启，默认关闭，避免普通编译不断制造待上传条目。
- 先实现 P0 和 P1，确认本地 archive hit 行为正确后再接云端。
- 云端读取必须是纯优化路径，不能成为编译成功的必要条件。
- 上传直接同步 `archive-cloud-cache/v1/`，但必须最后上传 manifest。

这套方案的核心不是“把 `.a` 存起来”，而是“用足够完整、可解释、可演进的 build key 判断这个 `.a` 是否真的可以复用”。
