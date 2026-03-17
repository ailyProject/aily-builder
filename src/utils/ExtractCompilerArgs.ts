export function removeCompilerPath(str: string): string {
  if (!str || typeof str !== 'string') {
    return '';
  }

  let endIdx: number;
  if (str.startsWith('"')) {
    // 引号包围的编译器路径：找到对应的闭合引号
    const closeQuote = str.indexOf('"', 1);
    if (closeQuote === -1) {
      return '';
    }
    endIdx = closeQuote + 1;
  } else {
    // 无引号：找第一个空格
    endIdx = str.indexOf(' ');
    if (endIdx === -1) {
      return '';
    }
  }

  // 跳过编译器路径后的空格
  if (str[endIdx] === ' ') {
    return str.substring(endIdx + 1);
  }
  return str.substring(endIdx + 1);
}