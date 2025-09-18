import { removeCompilerPath } from './utils/ExtractCompilerArgs';
import { extractCompilerName, extractToolName } from './utils/ExtractCompilerName';
import { Logger } from './utils/Logger';
import { escapeQuotedDefines } from './utils/escapeQuotes';

export class CompileConfigManager {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * 公开方法：转义编译参数中的双引号
   * @param args 编译参数字符串
   * @returns 转义后的编译参数字符串
   */
  public escapeCompilerArgs(args: string): string {
    return escapeQuotedDefines(args);
  }

  parseCompileConfig(arduinoConfig: any) {

    let flag_eep, flag_hex, bin, flag_bin, ld, flag_ld, objcopy;
    if (arduinoConfig.platform['recipe.objcopy.eep.pattern']) {
      flag_eep = removeCompilerPath(arduinoConfig.platform['recipe.objcopy.eep.pattern'])
    }
    if (arduinoConfig.platform['recipe.objcopy.hex.pattern']) {
      objcopy = extractToolName(arduinoConfig.platform['recipe.objcopy.hex.pattern'])
      flag_hex = removeCompilerPath(arduinoConfig.platform['recipe.objcopy.hex.pattern'])
    }
    if (arduinoConfig.platform['recipe.objcopy.bin.pattern']) {
      bin = extractToolName(arduinoConfig.platform['recipe.objcopy.bin.pattern'])
      flag_bin = removeCompilerPath(arduinoConfig.platform['recipe.objcopy.bin.pattern'])
    }
    if (arduinoConfig.platform['recipe.c.combine.pattern']) {
      // 先尝试从模式中提取编译器名称
      ld = extractCompilerName(arduinoConfig.platform['recipe.c.combine.pattern'])
      
      // 如果提取失败（包含未解析变量），则手动构建
      if (!ld && arduinoConfig.platform['compiler.path'] && arduinoConfig.platform['compiler.c.elf.cmd']) {
        const compilerPath = arduinoConfig.platform['compiler.path'];
        const compilerCmd = arduinoConfig.platform['compiler.c.elf.cmd'];
        ld = compilerPath + compilerCmd;
        // console.log('手动构建链接器命令:', ld);
      }
      
      flag_ld = removeCompilerPath(arduinoConfig.platform['recipe.c.combine.pattern'])
    }

    // console.log('platformConfig:', JSON.stringify(arduinoConfig.platform, null, 2));

    // console.log('recipe.c.combine.pattern:', arduinoConfig.platform['recipe.c.combine.pattern']);
    // console.log('compiler.path:', arduinoConfig.platform['compiler.path']);
    // console.log('compiler.c.elf.cmd:', arduinoConfig.platform['compiler.c.elf.cmd']);
    // console.log('build.toolchainpkg:', arduinoConfig.platform['build.toolchainpkg']);
    // console.log('build.toolchain:', arduinoConfig.platform['build.toolchain']);
    // console.log('runtime.tools.pqt-gcc.path:', arduinoConfig.platform['runtime.tools.pqt-gcc.path']);
    // console.log('ld extracted:', ld);
    // console.log(arduinoConfig.platform['recipe.c.combine.pattern']);
    // console.log(arduinoConfig.platform['recipe.c.o.pattern']);
    // console.log(arduinoConfig.platform['recipe.cpp.o.pattern']);
    // console.log(arduinoConfig.platform['recipe.ar.o.pattern']);
    // console.log(arduinoConfig.platform['recipe.S.o.pattern']);
    // console.log(arduinoConfig.platform['recipe.objcopy.bin.pattern']);
    // console.log(arduinoConfig.platform['recipe.size.pattern']);

    let compileConfig = {
      // path: process.env['COMPILER_PATH'],
      compiler: {
        c: arduinoConfig.platform['compiler.c.cmd'],
        cpp: arduinoConfig.platform['compiler.cpp.cmd'],
        ar: arduinoConfig.platform['compiler.ar.cmd'],
        ld: ld,
        bin: bin,
        objcopy: objcopy,
        size: arduinoConfig.platform['compiler.size.cmd']
      },
      args: {
        c: escapeQuotedDefines(arduinoConfig.platform['recipe.c.o.pattern'].substring(arduinoConfig.platform['recipe.c.o.pattern'].indexOf(' ') + 1)),
        cpp: escapeQuotedDefines(arduinoConfig.platform['recipe.cpp.o.pattern'].substring(arduinoConfig.platform['recipe.cpp.o.pattern'].indexOf(' ') + 1)),
        ld: escapeQuotedDefines(flag_ld),
        s: escapeQuotedDefines(arduinoConfig.platform['recipe.S.o.pattern'].substring(arduinoConfig.platform['recipe.S.o.pattern'].indexOf(' ') + 1)),
        eep: escapeQuotedDefines(flag_eep),
        hex: escapeQuotedDefines(flag_hex),
        bin: escapeQuotedDefines(flag_bin),
        size: escapeQuotedDefines(arduinoConfig.platform['recipe.size.pattern'].substring(arduinoConfig.platform['recipe.size.pattern'].indexOf(' ') + 1))
      },
      includes: [
        // process.env['SDK_CORE_PATH'], // core sdk
        process.env['SDK_VARIANT_PATH'], // variants
      ],
      // 添加 Arduino 配置信息 - 用于预链接钩子和平台特定编译
      arduino: {
        platform: arduinoConfig.platform,
        board: arduinoConfig.board  // 添加 board 配置，可能在某些场景下有用
      }
    }



    arduinoConfig.platform['recipe.c.combine.pattern']
    return compileConfig
  }
}
