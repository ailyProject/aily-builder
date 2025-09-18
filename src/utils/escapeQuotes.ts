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
  
  // 然后处理普通的 -D 宏定义
  const quotedDefineRegex = /-D([A-Z_][A-Z0-9_]*)="([^"]*)"/g;
  return args.replace(quotedDefineRegex, (match, macroName, value) => {
    // 标准处理：转义内部引号，添加外层双引号
    return `"-D${macroName}=\\"${value}\\""`;
  });
}