import { createHash } from 'crypto';

/**
 * 计算文本的MD5值
 * @param text 要计算MD5的文本
 * @returns MD5哈希值（32位十六进制字符串）
 */
export function calculateMD5(text: string): string {
    return createHash('md5').update(text, 'utf8').digest('hex');
}

/**
 * 计算Buffer的MD5值
 * @param buffer 要计算MD5的Buffer
 * @returns MD5哈希值（32位十六进制字符串）
 */
export function calculateMD5FromBuffer(buffer: Buffer): string {
    return createHash('md5').update(buffer).digest('hex');
}

/**
 * 计算文件内容的MD5值
 * @param content 文件内容（字符串或Buffer）
 * @returns MD5哈希值（32位十六进制字符串）
 */
export function calculateContentMD5(content: string | Buffer): string {
    if (typeof content === 'string') {
        return calculateMD5(content);
    }
    return calculateMD5FromBuffer(content);
}