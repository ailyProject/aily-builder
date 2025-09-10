export function removeCompilerPath(str: string): string {
  if (!str || typeof str !== 'string') {
    return '';
  }
  
  const firstSpaceIndex = str.indexOf(' ');
  if (firstSpaceIndex === -1) {
    // 如果没有空格，说明只有一个参数，返回空字符串
    return '';
  }
  
  return str.substring(firstSpaceIndex + 1);
}