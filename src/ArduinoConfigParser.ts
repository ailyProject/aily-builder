import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import { glob } from 'glob';

interface FQBNObject {
    package: string;
    platform: string;
    boardId: string;
}

interface ToolConfig {
    [key: string]: any;
}

interface CompilerConfig {
    [key: string]: any;
}

interface RecipeConfig {
    [key: string]: any;
}

interface DebugConfig {
    [key: string]: any;
}

interface PlatformConfig {
    name: string;
    version: string;
    properties: { [key: string]: any };
    tools: { [key: string]: ToolConfig };
    compiler: CompilerConfig;
    recipe: RecipeConfig;
    debug: DebugConfig;
}

interface BoardUploadConfig {
    [key: string]: any;
}

interface BoardBootloaderConfig {
    [key: string]: any;
}

interface BoardMenuConfig {
    [key: string]: any;
}

interface BoardConfig {
    id: string;
    name: string;
    build: { [key: string]: any };
    upload: BoardUploadConfig;
    bootloader: BoardBootloaderConfig;
    menu: BoardMenuConfig;
}

interface MenuConfig {
    [key: string]: any;
}

interface BoardParseResult {
    fqbn: string;
    fqbnParsed: FQBNObject;
    platform: { [key: string]: string };
    board: { [key: string]: string };
    buildProperties?: { [key: string]: any };
}

/**
 * Arduino 配置文件解析器
 * 解析 boards.txt 和 platform.txt 文件，输出为 JSON 格式
 */
export class ArduinoConfigParser {
    private runtimeProperties: Map<string, string>;
    private globalProperties: Map<string, string>;

    constructor() {
        this.runtimeProperties = new Map<string, string>();
        this.globalProperties = new Map<string, string>();
    }

    /**
     * 解析 FQBN (Fully Qualified Board Name)
     * 格式: package:platform:boardid
     * 示例: esp32:esp32:esp32c3
     * @param {string} fqbn FQBN 字符串
     * @returns {Object} 解析后的 FQBN 对象
     */
    parseFQBN(fqbn: string): FQBNObject {
        if (!fqbn || typeof fqbn !== 'string') {
            throw new Error('FQBN 必须是非空字符串');
        }

        const parts = fqbn.split(':');
        if (parts.length !== 3) {
            throw new Error('无效的 FQBN 格式，必须是 package:platform:boardid');
        }

        const result: FQBNObject = {
            package: parts[0],
            platform: parts[1],
            boardId: parts[2]
        };

        return result;
    }

    /**
     * 解析 platform.txt 文件
     * @param {string} platformPath platform.txt 文件路径
     * @param {Object} fqbnObj 解析后的FQBN对象
     * @param {Object} boardConfig 板子配置，用于变量解析
     * @param {Object} moreConfig 额外配置
     * @returns {Object} 解析结果
     */
    parsePlatformTxt(platformPath: string, fqbnObj: FQBNObject, boardConfig: any = {}, moreConfig: any = {}): any {
        const platform = fqbnObj.platform;
        console.log(`  解析平台 ${platform} 的配置...`);
        // console.log(boardConfig);


        try {
            let content = fs.readFileSync(platformPath, 'utf8');
            // 替换compiler.libraries.ldflags為%LD_FLAGS%
            content = content.replace('compiler.libraries.ldflags=', 'compiler.libraries.ldflags=%LD_FLAGS%');

            const lines = content.split('\n');
            const variables: { [key: string]: string } = {};

            // 第一遍：收集所有变量定义，构建变量名字典
            const variableNames = new Set<string>();
            lines.forEach(line => {
                const trimmed = line.trim();
                if (trimmed && !trimmed.startsWith('#')) {
                    const equalIndex = trimmed.indexOf('=');
                    if (equalIndex !== -1) {
                        const key = trimmed.substring(0, equalIndex).trim();
                        const value = trimmed.substring(equalIndex + 1).trim();

                        if (key) {
                            // 将变量名添加到字典中
                            variableNames.add(key);
                            // 如果有键但值为空，则设置为空字符串
                            variables[key] = value || "";
                        }
                    }
                }
            });

            // 将boardConfig加入到字典中
            Object.keys(boardConfig).forEach(key => {
                if (!variables[key]) {
                    variableNames.add(key);
                    variables[key] = boardConfig[key];
                }
            });

            // 将moreConfig加入到字典中
            Object.keys(moreConfig).forEach(key => {
                if (!variables[key]) {
                    variableNames.add(key);
                    variables[key] = moreConfig[key];
                }
            });

            // 检测并处理 platform 与 boardConfig 中的重复键
            // 当存在相同 key 时，使用 boardConfig 的值覆盖 platform 的值
            this.applyBoardConfigOverrides(variables, boardConfig);

            // 处理 Windows 特定配置覆盖（在变量展开前进行）
            this.applyWindowsOverrides(variables);

            // 第二遍：解析变量引用，使用优化的替换策略
            let changed = true;
            let iterations = 0;
            const maxIterations = 10;
            const circularDetected = new Set<string>();

            // console.log(`开始优化变量解析，共有 ${Object.keys(variables).length} 个变量...`);

            while (changed && iterations < maxIterations) {
                changed = false;
                iterations++;
                for (const key in variables) {
                    // 跳过已检测到循环引用的变量
                    if (circularDetected.has(key)) {
                        continue;
                    }

                    const original = variables[key];
                    if (!original) { continue; }

                    // 检查是否包含对自己的引用（直接循环引用）
                    if (original && original.includes(`{${key}}`)) {
                        console.warn(`⚠️  检测到直接循环引用: ${key}`);
                        circularDetected.add(key);
                        continue;
                    }

                    // 使用优化的变量替换策略
                    const expanded = this.expandVariablesOptimized(original, variables, variableNames);

                    // 检测间接循环引用：如果扩展后的字符串变得过长
                    if (expanded.length > 2000) {
                        console.warn(`⚠️  检测到可能的间接循环引用: ${key}`);
                        // console.log(`   变量值: ${original}`);
                        // console.log(`   扩展后: ${expanded}`);
                        circularDetected.add(key);
                        continue;
                    }

                    if (expanded !== original) {
                        variables[key] = expanded;
                        changed = true;
                    }
                }
            }
            if (iterations >= maxIterations) {
                console.warn(`⚠️  变量解析达到最大迭代次数 ${maxIterations}，可能存在复杂的循环引用`);
            }
            // this.showUnresolvedPlatformVariables(variables);
            return variables;
        } catch (error) {
            throw new Error(`解析文件失败 ${platformPath}: ${error}`);
        }
    }

    /**
     * 应用 Windows 特定的配置覆盖
     * 当某个 key 有 .windows 版本时，使用 Windows 版本覆盖普通版本
     * @param {Object} variables 变量映射
     */
    private applyWindowsOverrides(variables: { [key: string]: string }): void {
        // 查找所有以 .windows 结尾的键
        const windowsKeys = Object.keys(variables).filter(key => key.endsWith('.windows'));

        windowsKeys.forEach(windowsKey => {
            // 获取对应的普通键名（去掉 .windows 后缀）
            const baseKey = windowsKey.slice(0, -8); // 移除 '.windows'

            // 如果普通键存在，则用 Windows 版本覆盖它
            if (variables.hasOwnProperty(baseKey)) {
                const windowsValue = variables[windowsKey];
                // console.log(`  应用 Windows 覆盖: ${baseKey} = ${windowsValue}`);
                variables[baseKey] = windowsValue;
            }
        });
    }

    /**
     * 应用 boardConfig 的配置覆盖
     * 当 platform 配置和 boardConfig 中有相同的 key 时，使用 boardConfig 的值覆盖 platform 的值
     * 如果原值是 {} 包裹的变量形式，则不进行覆盖
     * @param {Object} variables 变量映射（包含 platform 配置）
     * @param {Object} boardConfig 板子配置
     */
    private applyBoardConfigOverrides(variables: { [key: string]: string }, boardConfig: any): void {
        const overrides: string[] = [];
        const skipped: string[] = [];
        
        Object.keys(boardConfig).forEach(key => {
            // 检查 platform 配置中是否已存在相同的 key
            if (variables.hasOwnProperty(key) && variables[key] !== boardConfig[key]) {
                const originalValue = variables[key];
                
                // 检查原值是否为 {} 包裹的变量形式
                if (originalValue && originalValue.match(/^\{[^}]+\}$/)) {
                    // 如果是变量形式，跳过覆盖
                    skipped.push(`${key}: 保持变量 "${originalValue}"，跳过覆盖 "${boardConfig[key]}"`);
                } else {
                    // 正常覆盖
                    variables[key] = boardConfig[key];
                    overrides.push(`${key}: "${originalValue}" -> "${boardConfig[key]}"`);
                }
            }
        });

        // 记录覆盖信息
        if (overrides.length > 0) {
            console.log(`  检测到 ${overrides.length} 个重复键，应用 boardConfig 覆盖:`);
            overrides.forEach(override => {
                console.log(`    ${override}`);
            });
        }
        
        // 记录跳过的变量覆盖
        if (skipped.length > 0) {
            console.log(`  检测到 ${skipped.length} 个变量形式的键，跳过覆盖:`);
            skipped.forEach(skip => {
                console.log(`    ${skip}`);
            });
        }
    }

    /**
     * 应用额外的构建属性，并处理分区方案的智能匹配
     * 当设置 build.partitions 时，自动应用对应的相关参数（如 upload.maximum_size）
     * @param {Object} boardConfig 板子配置对象
     * @param {Object} buildProperties 要应用的构建属性
     */
    private applyBuildProperties(boardConfig: { [key: string]: string }, buildProperties: { [key: string]: string }): void {
        Object.keys(buildProperties).forEach(key => {
            console.log(`  应用额外构建属性: ${key} = ${buildProperties[key]}`);
            boardConfig[key] = buildProperties[key];
        });

        // 处理分区方案的智能匹配
        if (buildProperties['build.partitions']) {
            this.applyPartitionSchemeSettings(boardConfig, buildProperties['build.partitions']);
        }
    }

    /**
     * 根据分区方案自动应用相关的配置参数
     * @param {Object} boardConfig 板子配置对象
     * @param {string} partitionValue 分区方案值
     */
    private applyPartitionSchemeSettings(boardConfig: { [key: string]: string }, partitionValue: string): void {
        console.log(`  检测到分区方案设置: ${partitionValue}`);
        
        // 查找匹配的分区方案配置
        const matchingScheme = this.findPartitionScheme(boardConfig, partitionValue);
        
        if (matchingScheme) {
            console.log(`  找到匹配的分区方案: ${matchingScheme.schemeName}`);
            
            // 应用相关的参数
            if (matchingScheme.uploadMaxSize) {
                boardConfig['upload.maximum_size'] = matchingScheme.uploadMaxSize;
                console.log(`    自动设置 upload.maximum_size = ${matchingScheme.uploadMaxSize}`);
            }
            
            if (matchingScheme.uploadExtraFlags) {
                boardConfig['upload.extra_flags'] = matchingScheme.uploadExtraFlags;
                console.log(`    自动设置 upload.extra_flags = ${matchingScheme.uploadExtraFlags}`);
            }
        } else {
            console.log(`  ⚠️  未找到匹配的分区方案配置: ${partitionValue}`);
        }
    }

    /**
     * 在 boardConfig 中查找与指定分区值匹配的分区方案
     * @param {Object} boardConfig 板子配置对象
     * @param {string} partitionValue 要查找的分区值
     * @returns {Object|null} 匹配的分区方案信息或 null
     */
    private findPartitionScheme(boardConfig: { [key: string]: string }, partitionValue: string): any {
        // 遍历所有以 menu.PartitionScheme. 开头的配置项
        for (const key in boardConfig) {
            if (key.startsWith('menu.PartitionScheme.') && key.endsWith('.build.partitions')) {
                const schemeValue = boardConfig[key];
                
                if (schemeValue === partitionValue) {
                    // 提取方案名称（去掉前缀和后缀）
                    const schemeName = key.replace('menu.PartitionScheme.', '').replace('.build.partitions', '');
                    
                    // 查找相关的配置项
                    const uploadMaxSizeKey = `menu.PartitionScheme.${schemeName}.upload.maximum_size`;
                    const uploadExtraFlagsKey = `menu.PartitionScheme.${schemeName}.upload.extra_flags`;
                    
                    return {
                        schemeName: schemeName,
                        partitionValue: schemeValue,
                        uploadMaxSize: boardConfig[uploadMaxSizeKey],
                        uploadExtraFlags: boardConfig[uploadExtraFlagsKey]
                    };
                }
            }
        }
        
        return null;
    }

    /**
     * 优化的变量扩展方法
     * 支持嵌套变量展开，如 {tools.{build.tarch}-esp-elf-gdb.path}
     * 先展开内层变量，再展开外层变量
     * @param {string} value 要扩展的值
     * @param {Object} variables 变量映射
     * @param {Set} variableNames 所有变量名的集合
     * @returns {string} 扩展后的值
     */
    expandVariablesOptimized(value: string, variables: { [key: string]: string }, variableNames: Set<string>): string {
        let result = value;
        let maxIterations = 10; // 防止无限递归
        let iteration = 0;

        while (iteration < maxIterations) {
            const originalResult = result;

            // 处理嵌套变量：从最内层开始展开

            result = this.expandNestedVariables(result, variables, variableNames);

            // 如果没有变化，说明展开完成
            if (result === originalResult) {
                break;
            }

            iteration++;
        }

        if (iteration >= maxIterations) {
            console.warn(`⚠️  变量展开达到最大迭代次数，可能存在循环引用: ${value}`);
        }

        return result;
    }

    /**
     * 展开嵌套变量，从最内层开始
     * @param {string} value 要展开的值
     * @param {Object} variables 变量映射
     * @param {Set} variableNames 所有变量名的集合
     * @returns {string} 展开后的值
     */
    private expandNestedVariables(value: string, variables: { [key: string]: string }, variableNames: Set<string>): string {
        // 使用递归正则表达式来找到最内层的变量
        // 这个正则会匹配不包含其他大括号的变量引用
        return value.replace(/\{([^{}]+)\}/g, (match, varName) => {
            // 首先检查变量名是否存在于字典中
            if (variableNames.has(varName)) {
                const replacement = variables[varName];
                // 如果找到替换值且不为 undefined，则替换
                if (replacement !== undefined) {
                    return replacement;
                }
            }

            // 如果变量不存在于字典中，保持原样
            return match;
        });
    }


    /**
     * 查找并显示未解析的平台变量
     * @param {Object} variables 变量映射
     * @param {Set} circularDetected 循环引用的变量集合
     * @returns {Object} 分析结果
     */
    showUnresolvedPlatformVariables(variables: { [key: string]: string }): any {
        const unresolvedVars = new Set<string>();
        const unresolvedEntries: Array<{ key: string; value: string }> = [];

        // 遍历所有变量，查找仍包含 {variable} 格式的未解析变量
        for (let key in variables) {
            const value = variables[key];

            const matches = value.match(/\{([^}]+)\}/g);

            if (matches) {
                // 记录包含未解析变量的条目
                unresolvedEntries.push({ key, value });

                // 提取未解析的变量名
                matches.forEach(match => {
                    const varName = match.slice(1, -1); // 移除 { 和 }
                    unresolvedVars.add(varName);
                });
            }
        }

        console.log('\n=== 平台变量解析分析报告 ===');

        if (unresolvedVars.size > 0) {
            console.log(`❌ 发现 ${unresolvedVars.size} 个未解析的变量:`);
            Array.from(unresolvedVars).forEach(v => {
                console.log(`  {${v}}`);
            });

            console.log(`\n📝 共有 ${unresolvedEntries.length} 个条目包含未解析变量:`);
            unresolvedEntries.forEach(entry => {
                console.log(`  ${entry.key} = ${entry.value}`);
            });
        }
        console.log('============================\n');

        return {
            unresolvedVariables: Array.from(unresolvedVars),
            unresolvedEntries: unresolvedEntries
        };
    }

    /**
     * 根据 FQBN 解析特定板子的配置
     * @param {string} platformDir 平台目录路径
     * @param {string} fqbn FQBN 字符串
     * @param {Object} buildProperties 额外的构建属性
     * @returns {Object} 特定板子的完整配置
     */
    async parseByFQBN(fqbn: string, buildProperties: { [key: string]: string }): Promise<BoardParseResult> {
        // 解析 FQBN
        const fqbnObj = this.parseFQBN(fqbn);
        console.log(`解析 FQBN: ${fqbn}`);
        console.log(`  包: ${fqbnObj.package}`);
        console.log(`  平台: ${fqbnObj.platform}`);
        console.log(`  板子ID: ${fqbnObj.boardId}`);
        process.env['package'] = fqbnObj.package;
        process.env['platform'] = fqbnObj.platform;

        let platformTxtPath, boardsTxtPath;


        if (process.env['SDK_PATH']) {
            // 自定义SDK路径
            platformTxtPath = path.join(process.env['SDK_PATH'], 'platform.txt');
            boardsTxtPath = path.join(process.env['SDK_PATH'], 'boards.txt');
        } else {
            let ARDUINO15_PACKAGE_PATH = path.join(os.homedir(), 'AppData', 'Local', 'Arduino15', 'packages', fqbnObj.package);
            let ARDUINO15_PACKAGE_HARDWARE_PATH = path.join(ARDUINO15_PACKAGE_PATH, 'hardware', fqbnObj.platform);
            const platformTxtPattern = path.join(ARDUINO15_PACKAGE_HARDWARE_PATH, '**/platform.txt').replace(/\\/g, '/');
            const boardsTxtPattern = path.join(ARDUINO15_PACKAGE_HARDWARE_PATH, '**/boards.txt').replace(/\\/g, '/');
            const [platformTxtFiles, boardsTxtFiles] = await Promise.all([
                glob(platformTxtPattern, {
                    absolute: true,
                }),
                glob(boardsTxtPattern, {
                    absolute: true,
                })
            ]);
            platformTxtPath = platformTxtFiles[0];
            boardsTxtPath = boardsTxtFiles[0];
        }
        process.env['SDK_PATH'] = path.dirname(platformTxtPath);


        if (fqbnObj.package == 'esp32') {
            const [ESP32_ARDUINO_LIBS_PATH, ESPTOOL_PY_PATH] = await Promise.all([
                this.findToolPath('esp32-arduino-libs'),
                this.findToolPath('esptool_py'),
            ]);
            process.env['ESP32_ARDUINO_LIBS_PATH'] = ESP32_ARDUINO_LIBS_PATH;
            process.env['ESPTOOL_PY_PATH'] = ESPTOOL_PY_PATH;
        }

        let boardConfig: { [key: string]: string } = this.parseBoardsTxt(boardsTxtPath, fqbnObj);

        // 替换/添加额外的构建属性
        this.applyBuildProperties(boardConfig, buildProperties);

        if (!boardConfig['build.arch']) {
            boardConfig['build.arch'] = fqbnObj.platform.toUpperCase();
        }

        if (fqbnObj.package == 'esp32') {
            // 这里要读取arduino配置菜单，还未实现
            const cpuFreq = boardConfig['build.f_cpu'] ? boardConfig['build.f_cpu'].replace('000000L', '') : '240';
            const flashSize = boardConfig['build.flash_size'] ? boardConfig['build.flash_size'].replace(/MB$/i, 'M') : '4M';
            const flashFreq = boardConfig['build.flash_freq'] || '80m';
            const flashMode = boardConfig['build.flash_mode'] || 'qio';
            const psram = boardConfig['build.psram'] || 'disabled';
            const PartitionScheme = boardConfig['build.partitions'] || 'default';
            const loopCore = boardConfig['build.loop_core'] || '1';
            const eventsCore = boardConfig['build.events_core'] || '1';
            const eraseFlash = boardConfig['build.erase_cmd'] || 'none';
            const uploadSpeed = boardConfig['upload.speed'] || '921600';
            const usbMode = boardConfig['build.usb_mode'] || 'hwcdc';
            const cdcOnBoot = boardConfig['build.cdc_on_boot'] || 'default';
            const mscOnBoot = boardConfig['build.msc_on_boot'] || 'default';
            const dfuOnBoot = boardConfig['build.dfu_on_boot'] || 'default';
            const uploadMode = boardConfig['upload.mode'] || 'default';
            const debugLevel = boardConfig['build.debug_level'] || 'none';
            const jtagAdapter = boardConfig['debug.tool'] || 'default';
            const zigbeeMode = boardConfig['build.zigbee_mode'] || 'default';

            boardConfig['build.fqbn'] = fqbn + ':' +
                `UploadSpeed=${uploadSpeed},USBMode=${usbMode},CDCOnBoot=${cdcOnBoot},` +
                `MSCOnBoot=${mscOnBoot},DFUOnBoot=${dfuOnBoot},UploadMode=${uploadMode},` +
                `CPUFreq=${cpuFreq},FlashMode=${flashMode},FlashSize=${flashSize},` +
                `PartitionScheme=${PartitionScheme},DebugLevel=${debugLevel},PSRAM=${psram},` +
                `LoopCore=${loopCore},EventsCore=${eventsCore},EraseFlash=${eraseFlash},` +
                `JTAGAdapter=${jtagAdapter},ZigbeeMode=${zigbeeMode}`
        }

        process.env['BUILD_MCU'] = boardConfig['build.mcu'];

        let moreConfig = {
            'runtime.os': 'windows',
            'runtime.ide.version': '10607',
            'runtime.tools.avr-gcc.path': process.env['COMPILER_PATH'] || await this.findToolPath('avr-gcc'),
            'runtime.tools.esp-x32.path': process.env['COMPILER_PATH'] || await this.findToolPath('esp-x32'),
            'runtime.tools.esp-rv32.path': process.env['COMPILER_PATH'] || await this.findToolPath('esp-rv32'),
            'runtime.tools.arm-none-eabi-gcc-7-2017q4.path': process.env['COMPILER_PATH'] || await this.findToolPath('arm-none-eabi-gcc'),
            'runtime.tools.esp32-arduino-libs.path': process.env['ESP32_ARDUINO_LIBS_PATH'] || '%ESP32_ARDUINO_LIBS_PATH%',
            'runtime.tools.esptool_py.path': process.env['ESPTOOL_PY_PATH'],
            'build.project_name': process.env['SKETCH_NAME'],
            'includes': '%INCLUDE_PATHS%',
            'source_file': '%SOURCE_FILE_PATH%',
            'build.source.path': process.env['BUILD_PATH'],
            'build.variant.path': path.join(process.env['SDK_PATH'], 'variants', boardConfig['build.variant']),
            'runtime.platform.path': process.env['SDK_PATH'],
            'object_file': '%OBJECT_FILE_PATH%',
            'object_files': '%OBJECT_FILE_PATHS%',
            'build.path': process.env['BUILD_PATH'] || '%OUTPUT_PATH%',
            'archive_file': 'core.a',
            'archive_file_path': process.env['BUILD_PATH'] + '/core.a',
            'build.core.path': path.join(process.env['SDK_PATH'], 'cores', fqbnObj.package),
        }

        // console.log(moreConfig);
        // console.log('moreConfig:', moreConfig);
        let platformConfig: { [key: string]: string } = this.parsePlatformTxt(platformTxtPath, fqbnObj, boardConfig, moreConfig);

        // 设置编译器路径
        process.env['COMPILER_PATH'] = process.env['COMPILER_PATH'] || platformConfig['compiler.path'] || platformConfig['runtime.tools.avr-gcc.path'];
        // console.log(`process.env['COMPILER_PATH']:`, process.env['COMPILER_PATH'], platformConfig);

        // 设置 SDK_CORE_PATH
        process.env['SDK_CORE_PATH'] = path.join(process.env['SDK_PATH'], 'cores', fqbnObj.package);
        // 设置SDK_VARIANT_PATH
        process.env['SDK_VARIANT_PATH'] = path.join(process.env['SDK_PATH'], 'variants', boardConfig['build.variant']);
        // 设置 SDK_CORE_LIBRARIES_PATH
        process.env['SDK_CORE_LIBRARIES_PATH'] = path.join(process.env['SDK_PATH'], 'libraries');

        if (platformConfig['compiler.sdk.path']) {
            process.env['COMPILER_SDK_PATH'] = platformConfig['compiler.sdk.path']
        }
        // console.log(platformConfig);
        process.env['COMPILER_GPP_PATH'] = platformConfig['compiler.path'] + platformConfig['compiler.cpp.cmd'];

        // 构建最终配置
        const result: BoardParseResult = {
            fqbn: fqbn,
            fqbnParsed: fqbnObj,
            platform: platformConfig,
            board: boardConfig,
        };

        // console.log("Result: ", result);

        return result;

    }

    /**
     * 解析 boards.txt 文件中指定板子的配置
     * @param {string} boardsPath boards.txt 文件路径
     * @param {string} boardId 目标板子ID
     * @returns {Object} 解析结果，只包含指定板子的配置
     */
    parseBoardsTxt(boardsPath: string, fqbnObj: FQBNObject) {
        const boardId = fqbnObj.boardId;
        console.log(`  解析开发板 ${boardId} 的配置...`);
        // console.log(boardsPath);

        try {
            const content = fs.readFileSync(boardsPath, 'utf8');
            const lines = content.split('\n');

            // 查找以指定板卡名称开头的配置行
            const boardPrefix = `${boardId}.`;
            const boardLines = lines.filter(line => {
                const trimmedLine = line.trim();
                return trimmedLine.startsWith(boardPrefix) && !trimmedLine.startsWith('#');
            });

            // 将配置行解析为对象
            const boardConfig: { [key: string]: string } = {};

            boardLines.forEach(line => {
                const trimmedLine = line.trim();
                const equalIndex = trimmedLine.indexOf('=');

                if (equalIndex > 0) {
                    const key = trimmedLine.substring(0, equalIndex);
                    const value = trimmedLine.substring(equalIndex + 1);

                    // 移除板卡名称前缀，只保留配置项名称
                    const configKey = key.substring(boardPrefix.length);
                    boardConfig[configKey] = value;
                }
            });

            return boardConfig;
        } catch (error) {
            throw new Error(`解析文件失败 ${boardsPath}: ${error}`);
        }
    }

    async findToolPath(toolName) {
        let toolsBasePath: string;
        
        if (process.env['TOOLS_PATH']) {
            // 使用自定义工具路径
            toolsBasePath = process.env['TOOLS_PATH'];
            console.log(`使用自定义工具路径: ${toolsBasePath}`);
        } else {
            // 使用默认 Arduino15 路径
            let ARDUINO15_PACKAGE_PATH = path.join(os.homedir(), 'AppData', 'Local', 'Arduino15', 'packages', process.env['package']);
            toolsBasePath = path.join(ARDUINO15_PACKAGE_PATH, 'tools');
            console.log(`使用默认工具路径: ${toolsBasePath}`);
        }
        
        // 支持两种匹配模式：
        // 1. toolName/* (传统 Arduino 路径结构)
        // 2. toolName@* (aily-project 工具路径结构)
        const patterns = [
            path.join(toolsBasePath, `${toolName}@*`).replace(/\\/g, '/'),
            path.join(toolsBasePath, toolName, '*').replace(/\\/g, '/')
        ];
        
        for (const pattern of patterns) {
            const result = await glob(pattern, { absolute: true });
            if (result && result.length > 0) {
                console.log(`找到工具路径: ${result[0]}`);
                return result[0];
            }
        }
        
        console.warn(`未找到工具: ${toolName} 在路径: ${toolsBasePath}`);
        return null;
    }
}