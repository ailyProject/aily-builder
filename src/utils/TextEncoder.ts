import * as iconv from 'iconv-lite';

/**
 * 将 Buffer 解码为 UTF-8 字符串，自动检测并转换编码
 * @param buffer 要解码的 Buffer
 * @returns 解码后的 UTF-8 字符串
 */
export function decodeToUtf8(buffer: Buffer): string {
  try {
    // 首先尝试直接使用 UTF-8 解码
    if (iconv.encodingExists('utf8')) {
      const utf8Text = iconv.decode(buffer, 'utf8');
      
      // 检查是否包含UTF-8替换字符，这通常表示编码问题
      if (!utf8Text.includes('\uFFFD')) {
        return utf8Text;
      }
    }

    // 如果UTF-8解码失败，尝试其他常见编码
    const encodings = ['gbk', 'gb2312', 'big5', 'shift_jis', 'latin1', 'ascii'];
    
    for (const encoding of encodings) {
      try {
        if (iconv.encodingExists(encoding)) {
          const decoded = iconv.decode(buffer, encoding);
          // 简单验证：如果没有替换字符且包含可打印字符，则认为是有效的
          if (!decoded.includes('\uFFFD') && /[\x20-\x7E\u4e00-\u9fff]/.test(decoded)) {
            return decoded;
          }
        }
      } catch (e) {
        continue;
      }
    }
    
    // 如果所有编码都失败，使用 UTF-8 强制解码
    return iconv.decode(buffer, 'utf8');
  } catch (error) {
    // 如果所有方法都失败，返回原始的 latin1 编码
    return buffer.toString('latin1');
  }
}
