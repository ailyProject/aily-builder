import { removeCompilerPath } from './utils/ExtractCompilerArgs';
import { extractCompilerName, extractToolName } from './utils/ExtractCompilerName';
import { Logger } from './utils/Logger';

export class CompileConfigManager {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * 转义编译参数中的双引号，将 -DMACRO="value" 转换为 -DMACRO=\"value\"
   * @param args 编译参数字符串
   * @returns 转义后的编译参数字符串
   */
  private escapeQuotedDefines(args: string): string {
    if (!args) return args;
    
    // 首先处理被单引号包围的 -D 宏定义（来自 platform.txt）
    // 匹配 '-DMACRO_NAME="VALUE"' 格式
    const singleQuotedDefineRegex = /'-D([A-Z_][A-Z0-9_]*)="([^"]*)"'/g;
    args = args.replace(singleQuotedDefineRegex, (match, macroName, value) => {
      // 去掉外层单引号，转义内部双引号，添加外层双引号（Arduino IDE 格式）
      return `"-D${macroName}=\\"${value}\\""`;
    });
    
    // 然后处理普通的 -D 宏定义
    const quotedDefineRegex = /-D([A-Z_][A-Z0-9_]*)="([^"]*)"/g;
    return args.replace(quotedDefineRegex, (match, macroName, value) => {
      // 标准处理：转义内部引号，添加外层双引号
      return `"-D${macroName}=\\"${value}\\""`;
    });
  }

  /**
   * 公开方法：转义编译参数中的双引号
   * @param args 编译参数字符串
   * @returns 转义后的编译参数字符串
   */
  public escapeCompilerArgs(args: string): string {
    return this.escapeQuotedDefines(args);
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
        console.log('手动构建链接器命令:', ld);
      }
      
      flag_ld = removeCompilerPath(arduinoConfig.platform['recipe.c.combine.pattern'])
    }

    // console.log('platformConfig:', JSON.stringify(arduinoConfig.platform, null, 2));

    console.log('recipe.c.combine.pattern:', arduinoConfig.platform['recipe.c.combine.pattern']);
    console.log('compiler.path:', arduinoConfig.platform['compiler.path']);
    console.log('compiler.c.elf.cmd:', arduinoConfig.platform['compiler.c.elf.cmd']);
    console.log('build.toolchainpkg:', arduinoConfig.platform['build.toolchainpkg']);
    console.log('build.toolchain:', arduinoConfig.platform['build.toolchain']);
    console.log('runtime.tools.pqt-gcc.path:', arduinoConfig.platform['runtime.tools.pqt-gcc.path']);
    console.log('ld extracted:', ld);
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
        c: this.escapeQuotedDefines(arduinoConfig.platform['recipe.c.o.pattern'].substring(arduinoConfig.platform['recipe.c.o.pattern'].indexOf(' ') + 1)),
        cpp: this.escapeQuotedDefines(arduinoConfig.platform['recipe.cpp.o.pattern'].substring(arduinoConfig.platform['recipe.cpp.o.pattern'].indexOf(' ') + 1)),
        ld: this.escapeQuotedDefines(flag_ld),
        s: this.escapeQuotedDefines(arduinoConfig.platform['recipe.S.o.pattern'].substring(arduinoConfig.platform['recipe.S.o.pattern'].indexOf(' ') + 1)),
        eep: this.escapeQuotedDefines(flag_eep),
        hex: this.escapeQuotedDefines(flag_hex),
        bin: this.escapeQuotedDefines(flag_bin),
        size: this.escapeQuotedDefines(arduinoConfig.platform['recipe.size.pattern'].substring(arduinoConfig.platform['recipe.size.pattern'].indexOf(' ') + 1))
      },
      includes: [
        // process.env['SDK_CORE_PATH'], // core sdk
        process.env['SDK_VARIANT_PATH'], // variants
      ]
    }



    arduinoConfig.platform['recipe.c.combine.pattern']
    return compileConfig
  }
}
