import path from 'node:path';
import { glob } from 'glob';
import type { ArduinoProperties } from './ArduinoPropertyFile';
import { toGlobPath } from './ArduinoToolResolver';

export interface ArduinoPlatformFiles {
  sdkPath: string;
  platformTxtPath: string;
  boardsTxtPath: string;
}

export interface ResolveArduinoPlatformFilesOptions {
  packageName: string;
  platformName: string;
  sdkPath?: string;
  arduino15BasePath: string;
}

export interface ArduinoSdkLayout {
  sdkPath: string;
  systemPath: string;
  corePath: string;
  variantPath: string;
  librariesPath: string;
}

export interface RuntimePlatformPropertyOptions {
  runtimeOs: string;
  runtimeIdePath: string;
  runtimeIdeVersion: string;
  runtimeHardwarePath: string;
  boardId: string;
  effectiveFqbn: string;
  sdkLayout: ArduinoSdkLayout;
  toolchainPackage: string;
  toolchain: string;
  flashTotal: string;
  projectName: string;
  sketchFolderPath: string;
  buildPath?: string;
}

export interface LegacyArduinoEnvironmentOptions {
  packageName: string;
  platformName: string;
  sdkLayout: ArduinoSdkLayout;
  boardProperties: Readonly<ArduinoProperties>;
  platformProperties: Readonly<ArduinoProperties>;
  esp32ArduinoLibrariesPath?: string | null;
  esptoolPath?: string | null;
  pqtGccPath?: string | null;
}

/**
 * Locate `platform.txt` and `boards.txt` for one Arduino platform.
 *
 * An explicit SDK directory is used directly. Otherwise the standard
 * Arduino15 package layout is searched and the first glob result is selected,
 * preserving the parser's existing discovery order. The filesystem is read
 * but never modified, and the resolved SDK directory is returned explicitly.
 */
export async function resolveArduinoPlatformFiles(
  options: ResolveArduinoPlatformFilesOptions
): Promise<ArduinoPlatformFiles> {
  if (options.sdkPath) {
    return {
      sdkPath: options.sdkPath,
      platformTxtPath: path.join(options.sdkPath, 'platform.txt'),
      boardsTxtPath: path.join(options.sdkPath, 'boards.txt')
    };
  }

  const hardwarePath = path.join(
    options.arduino15BasePath,
    'packages',
    options.packageName,
    'hardware',
    options.platformName
  );
  const [platformFiles, boardsFiles] = await Promise.all([
    glob(toGlobPath(path.join(hardwarePath, '**', 'platform.txt')), { absolute: true }),
    glob(toGlobPath(path.join(hardwarePath, '**', 'boards.txt')), { absolute: true })
  ]);
  const platformTxtPath = platformFiles[0];

  return {
    sdkPath: path.dirname(platformTxtPath),
    platformTxtPath,
    boardsTxtPath: boardsFiles[0]
  };
}

/**
 * Build the standard directory layout used by Arduino compile properties.
 * This function performs path calculations only and does not require the
 * directories to exist.
 */
export function resolveArduinoSdkLayout(
  sdkPath: string,
  coreName: string,
  variantName: string
): ArduinoSdkLayout {
  return {
    sdkPath,
    systemPath: path.join(sdkPath, 'system'),
    corePath: path.join(sdkPath, 'cores', coreName),
    variantPath: path.join(sdkPath, 'variants', variantName),
    librariesPath: path.join(sdkPath, 'libraries')
  };
}

/**
 * Create the generated Arduino runtime/build property layer.
 * The returned object is new, inputs are not modified, and placeholder values
 * required by later compilation stages are intentionally left unexpanded.
 */
export function createRuntimePlatformProperties(
  options: RuntimePlatformPropertyOptions
): ArduinoProperties {
  return {
    'runtime.os': options.runtimeOs,
    'runtime.ide.path': options.runtimeIdePath,
    'runtime.ide.version': options.runtimeIdeVersion,
    'runtime.hardware.path': options.runtimeHardwarePath,
    ide_version: options.runtimeIdeVersion,
    software: 'ARDUINO',
    _id: options.boardId,
    'build.fqbn': options.effectiveFqbn,
    sketch_path: options.sketchFolderPath,
    'build.system.path': options.sdkLayout.systemPath,
    'build.toolchainpkg': options.toolchainPackage,
    'build.toolchain': options.toolchain,
    'build.flash_total': options.flashTotal,
    'build.project_name': options.projectName,
    includes: '%INCLUDE_PATHS%',
    source_file: '%SOURCE_FILE_PATH%',
    'build.source.path': options.sketchFolderPath,
    'build.variant.path': options.sdkLayout.variantPath,
    'runtime.platform.path': options.sdkLayout.sdkPath,
    object_file: '%OBJECT_FILE_PATH%',
    object_files: '%OBJECT_FILE_PATHS%',
    'build.path': options.buildPath || '%OUTPUT_PATH%',
    archive_file: 'core.a',
    archive_file_path: `${options.buildPath}/core.a`,
    'build.core.path': options.sdkLayout.corePath
  };
}

function assignEnvironmentValue(
  target: NodeJS.ProcessEnv,
  key: string,
  value: string | null | undefined
): void {
  target[key] = value as string;
}

/**
 * Publish compatibility variables consumed by the current compile pipeline.
 *
 * This is the only intentionally process-global operation in the platform
 * parsing flow. A target environment can be supplied for tests. Existing
 * `COMPILER_PATH` wins, matching the previous parser behavior.
 */
export function publishLegacyArduinoEnvironment(
  options: LegacyArduinoEnvironmentOptions,
  target: NodeJS.ProcessEnv = process.env
): void {
  const board = options.boardProperties;
  const platform = options.platformProperties;

  target.package = options.packageName;
  target.platform = options.platformName;
  target.SDK_PATH = options.sdkLayout.sdkPath;
  assignEnvironmentValue(target, 'BUILD_MCU', board['build.mcu']);

  if (options.platformName === 'esp32') {
    assignEnvironmentValue(
      target,
      'ESP32_ARDUINO_LIBS_PATH',
      options.esp32ArduinoLibrariesPath
    );
    assignEnvironmentValue(target, 'ESPTOOL_PY_PATH', options.esptoolPath);
  }
  if (options.packageName === 'rp2040') {
    assignEnvironmentValue(target, 'PQT_GCC_PATH', options.pqtGccPath);
  }

  target.COMPILER_PATH = target.COMPILER_PATH
    || platform['compiler.path']
    || platform['runtime.tools.avr-gcc.path'];
  assignEnvironmentValue(
    target,
    'COMPILER_GPP_PATH',
    platform['compiler.path'] + platform['compiler.cpp.cmd']
  );
  target.SDK_CORE_PATH = options.sdkLayout.corePath;
  target.SDK_VARIANT_PATH = options.sdkLayout.variantPath;
  target.SDK_CORE_LIBRARIES_PATH = options.sdkLayout.librariesPath;

  if (platform['compiler.sdk.path']) {
    target.COMPILER_SDK_PATH = platform['compiler.sdk.path'];
  }
}
