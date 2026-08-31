import path from 'path';
import { escapeDefineForShell } from './utils/escapeQuotes';
import { getArduinoHostOs } from './utils/HostPlatform';
import { projectPlatformBuildProperties } from './PlatformPropertyProjector';
import {
    ArduinoProperties,
    loadArduinoProperties
} from './ArduinoPropertyFile';
import {
    applyBoardBuildProperties,
    formatEffectiveFqbn,
    resolveBoardMenus,
    selectBoardProperties
} from './BoardConfigResolver';
import {
    resolveArduinoPlatformProperties
} from './ArduinoPropertyResolver';
import {
    findArduinoToolPath,
    getDefaultArduino15BasePath,
    resolveArduinoToolPaths
} from './ArduinoToolResolver';
import {
    createRuntimePlatformProperties,
    publishLegacyArduinoEnvironment,
    resolveArduinoPlatformFiles,
    resolveArduinoSdkLayout
} from './ArduinoBuildContext';
import {
    ArduinoUploadCommand,
    resolveArduinoUploadCommand
} from './ArduinoUploadCommand';

export interface FQBNObject {
    package: string;
    platform: string;
    boardId: string;
}

export interface BoardParseResult {
    fqbn: string;
    fqbnParsed: FQBNObject;
    platform: ArduinoProperties;
    board: ArduinoProperties;
    upload?: ArduinoUploadCommand;
}

/**
 * 将 FQBN、boards.txt、platform.txt 和已安装工具编排为编译所需配置。
 * 具体的文件、菜单、属性和工具规则由独立的纯函数模块负责。
 */
export class ArduinoConfigParser {
    /**
     * 解析 `package:platform:boardId` 格式的 Arduino FQBN。
     * 输入格式无效时抛出错误，不读取文件或修改环境变量。
     */
    parseFQBN(fqbn: string): FQBNObject {
        if (!fqbn || typeof fqbn !== 'string') {
            throw new Error('FQBN 必须是非空字符串');
        }

        const parts = fqbn.split(':');
        if (parts.length !== 3) {
            throw new Error('无效的 FQBN 格式，必须是 package:platform:boardid');
        }

        return {
            package: parts[0],
            platform: parts[1],
            boardId: parts[2]
        };
    }

    /**
     * 加载并解析 platform.txt 及可选的 platform.local.txt。
     * `_fqbnObj` 为兼容原公开签名保留；返回新对象，不修改输入属性。
     */
    parsePlatformTxt(
        platformPath: string,
        _fqbnObj: FQBNObject,
        boardProperties: ArduinoProperties = {},
        generatedProperties: ArduinoProperties = {}
    ): ArduinoProperties {
        try {
            return resolveArduinoPlatformProperties({
                platformProperties: loadArduinoProperties(platformPath),
                boardProperties,
                generatedProperties,
                onWarning: message => console.warn(`⚠️  ${message}`)
            });
        } catch (error) {
            throw new Error(`解析文件失败 ${platformPath}: ${error}`);
        }
    }

    /**
     * 解析指定 FQBN 的板卡和平台编译配置。
     * SDK/工具路径从当前构建环境读取；返回前统一发布兼容环境变量。
     */
    async parseByFQBN(
        fqbn: string,
        buildProperties: ArduinoProperties = {},
        toolVersions: ArduinoProperties = {},
        buildMacros: string[] = [],
        onUploadWarning?: (message: string) => void
    ): Promise<BoardParseResult> {
        const fqbnObj = this.parseFQBN(fqbn);
        const platformFiles = await resolveArduinoPlatformFiles({
            packageName: fqbnObj.package,
            platformName: fqbnObj.platform,
            sdkPath: process.env['SDK_PATH'],
            arduino15BasePath: getDefaultArduino15BasePath()
        });

        let esp32ArduinoLibrariesPath: string | null | undefined;
        let esptoolPath: string | null | undefined;
        if (fqbnObj.platform === 'esp32') {
            [esp32ArduinoLibrariesPath, esptoolPath] = await Promise.all([
                this.findToolPath(
                    'esp32-arduino-libs',
                    toolVersions['esp32-arduino-libs'] || '',
                    fqbnObj.package
                ),
                this.findToolPath(
                    'esptool_py',
                    toolVersions.esptool_py || '',
                    fqbnObj.package
                )
            ]);
        }

        const parsedBoardProperties = this.parseBoardsTxt(
            platformFiles.boardsTxtPath,
            fqbnObj,
            buildProperties
        );
        const menuResolution = resolveBoardMenus(parsedBoardProperties, buildProperties);
        const boardProperties = applyBoardBuildProperties(
            menuResolution.boardProperties,
            buildProperties
        );

        if (!boardProperties['build.arch']) {
            boardProperties['build.arch'] = fqbnObj.platform.toUpperCase();
        }
        boardProperties['build.fqbn'] = formatEffectiveFqbn(
            fqbn,
            menuResolution.selectedMenus
        );
        this.ensureBuildMcu(boardProperties);

        let toolchainPackage = 'pqt-gcc';
        let pqtGccPath: string | null | undefined;
        if (fqbnObj.package === 'rp2040') {
            toolchainPackage = boardProperties['build.toolchainpkg'] || 'pqt-gcc';
            pqtGccPath = await this.findToolPath(
                toolchainPackage,
                '',
                fqbnObj.package
            );
        }

        const runtimeIdeVersion = process.env['RUNTIME_IDE_VERSION'] || '10607';
        const runtimeIdePath = process.env['RUNTIME_IDE_PATH']
            || (process.argv[1]
                ? path.dirname(path.resolve(process.argv[1]))
                : path.dirname(process.execPath));
        const runtimeHardwarePath = process.env['RUNTIME_HARDWARE_PATH']
            || path.dirname(platformFiles.sdkPath);
        const sketchFolderPath = process.env['SKETCH_DIR_PATH']
            || (process.env['SKETCH_PATH']
                ? path.dirname(process.env['SKETCH_PATH'])
                : process.cwd());
        const sdkLayout = resolveArduinoSdkLayout(
            platformFiles.sdkPath,
            boardProperties['build.core'],
            boardProperties['build.variant']
        );
        const generatedProperties = createRuntimePlatformProperties({
            runtimeOs: getArduinoHostOs(),
            runtimeIdePath,
            runtimeIdeVersion,
            runtimeHardwarePath,
            boardId: fqbnObj.boardId,
            effectiveFqbn: boardProperties['build.fqbn'],
            sdkLayout,
            toolchainPackage,
            toolchain: boardProperties['build.toolchain']
                || (fqbnObj.package === 'rp2040' ? 'arm-none-eabi' : ''),
            flashTotal: boardProperties['build.flash_total'] || '2097152',
            projectName: process.env['SKETCH_NAME'] as string,
            sketchFolderPath,
            buildPath: process.env['BUILD_PATH']
        });

        const rawPlatformProperties = loadArduinoProperties(platformFiles.platformTxtPath);
        Object.assign(generatedProperties, await resolveArduinoToolPaths({
            platformProperties: rawPlatformProperties,
            boardProperties,
            toolVersions,
            toolsPath: process.env['TOOLS_PATH'],
            packageName: fqbnObj.package,
            arduino15BasePath: getDefaultArduino15BasePath(),
            onWarning: message => console.warn(message)
        }));

        const platformProperties = resolveArduinoPlatformProperties({
            platformProperties: rawPlatformProperties,
            boardProperties,
            generatedProperties,
            onWarning: message => console.warn(`⚠️  ${message}`)
        });
        if (buildMacros.length > 0) {
            platformProperties['build.macros'] = buildMacros
                .map(escapeDefineForShell)
                .join(' ');
        }

        publishLegacyArduinoEnvironment({
            packageName: fqbnObj.package,
            platformName: fqbnObj.platform,
            sdkLayout,
            boardProperties,
            platformProperties,
            esp32ArduinoLibrariesPath,
            esptoolPath,
            pqtGccPath
        });

        return {
            fqbn,
            fqbnParsed: fqbnObj,
            platform: projectPlatformBuildProperties(platformProperties),
            board: boardProperties,
            upload: resolveArduinoUploadCommand({
                board: boardProperties,
                platform: platformProperties
            }, {
                onWarning: onUploadWarning
            })
        };
    }

    /**
     * Ensure the standard build.mcu property is present when a platform only
     * exposes a menu-qualified MCU property. The first property in source
     * order wins, preserving the parser's existing fallback rule.
     */
    private ensureBuildMcu(boardProperties: ArduinoProperties): void {
        if (boardProperties['build.mcu']) {
            return;
        }

        for (const [key, value] of Object.entries(boardProperties)) {
            if (key !== 'build.mcu' && key.includes('build.mcu')) {
                boardProperties['build.mcu'] = value;
                return;
            }
        }
    }

    /**
     * 加载 boards.txt 层并返回指定 FQBN 板卡的属性。
     * 显式菜单选项在读取阶段过滤，源文件顺序保持不变。
     */
    parseBoardsTxt(
        boardsPath: string,
        fqbnObj: FQBNObject,
        buildProperties: ArduinoProperties = {}
    ): ArduinoProperties {
        const boardId = fqbnObj.boardId;

        try {
            const boardPrefix = `${boardId}.`;
            const boardProperties = loadArduinoProperties(
                boardsPath,
                key => key.startsWith(boardPrefix)
            );
            return selectBoardProperties(boardProperties, boardId, buildProperties);
        } catch (error) {
            throw new Error(`解析文件失败 ${boardsPath}: ${error}`);
        }
    }

    /**
     * 查找已安装的 Arduino 工具。自定义 TOOLS_PATH 优先，否则使用
     * Arduino15 包目录；未找到时返回 null，不修改环境变量。
     */
    async findToolPath(
        toolName: string,
        version = '',
        packageName = process.env['package'] || ''
    ): Promise<string | null> {
        return findArduinoToolPath({
            toolName,
            version,
            toolsPath: process.env['TOOLS_PATH'],
            packageName,
            arduino15BasePath: getDefaultArduino15BasePath()
        });
    }
}
