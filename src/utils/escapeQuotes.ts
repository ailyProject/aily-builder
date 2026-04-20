/**
 * 转义编译参数中的双引号，处理宏定义格式
 * @param args 编译参数字符串
 * @returns 转义后的编译参数字符串
 */
export function escapeQuotedDefines(args: string): string {
  if (!args) return args;
  
  // 首先处理被单引号包围的 -D 宏定义（来自 platform.txt）
  // 匹配 '-DMACRO_NAME="VALUE"' 格式
  const singleQuotedDefineRegex = /'-D([A-Z_][A-Z0-9_]*)="([^"]*)"'/g;
  args = args.replace(singleQuotedDefineRegex, (match, macroName, value) => {
    // 去掉外层单引号，转义内部双引号，添加外层双引号（Arduino IDE 格式）
    return `"-D${macroName}=\\"${value}\\""`;
  });

  // 处理被单引号包围的简单 -D 宏定义（无双引号值）
  // 匹配 '-DMACRO' 或 '-DMACRO=value' 格式（值不含双引号和空格）
  // Windows 上单引号不被 shell 去除，会导致 GCC 无法识别这些宏定义
  args = args.replace(/'(-D[A-Za-z_][A-Za-z0-9_]*(?:=[^\s'"]*)?)'/g, '$1');

  // 处理被单引号包围的 -I 路径（来自 platform.txt）
  args = args.replace(/'(-I[^\s'"]*)'/g, '$1');
  
  // 然后处理普通的 -D 宏定义（带双引号的值）
  const quotedDefineRegex = /-D([A-Z_][A-Z0-9_]*)="([^"]*)"/g;
  args = args.replace(quotedDefineRegex, (match, macroName, value) => {
    // 标准处理：转义内部引号，添加外层双引号
    return `"-D${macroName}=\\"${value}\\""`;
  });
  
  // 处理包含 shell 特殊字符（如括号）的宏定义
  // 匹配 -DMACRO=VALUE 格式，其中 VALUE 包含 ( 或 ) 等特殊字符
  // 但排除已经被双引号包围的宏定义
  args = args.replace(/(?<!")(-D[A-Za-z_][A-Za-z0-9_]*=)([^\s"]+[()][^\s"]*)/g, (match, prefix, value) => {
    // 用双引号包围整个宏定义以保护 shell 特殊字符
    return `"${prefix}${value}"`;
  });
  
  return args;
}

/**
 * 转义单个宏定义，处理 shell 特殊字符
 * @param macro 宏定义字符串（不包含 -D 前缀）
 * @returns 转义后的宏定义字符串（包含 -D 前缀）
 */
export function escapeDefineForShell(macro: string): string {
  if (!macro) return '';
  
  // 检查宏值是否包含需要转义的 shell 特殊字符
  const needsQuoting = /[()$`\\!"'<>|&;*?#~\[\]{}]/.test(macro);
  
  if (needsQuoting) {
    // 如果宏包含双引号，需要先转义双引号
    const escaped = macro.replace(/"/g, '\\"');
    return `"-D${escaped}"`;
  }
  
  return `-D${macro}`;
}