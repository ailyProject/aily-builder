import Parser, { SyntaxNode } from 'tree-sitter';
import Cpp from 'tree-sitter-cpp';
import { promises as fs } from 'fs';

// 打印AST结构（限定范围）
function printAST(node: SyntaxNode, sourceCode: string, indent = 0, maxDepth = 10) {
    if (indent > maxDepth) return;
    
    const prefix = '  '.repeat(indent);
    const nodeText = sourceCode.substring(node.startIndex, node.endIndex);
    const shortText = nodeText.length > 80 ? nodeText.substring(0, 80) + '...' : nodeText;
    
    console.log(`${prefix}${node.type} [${node.startIndex}-${node.endIndex}]: ${shortText.replace(/\n/g, '\\n')}`);
    
    // 只深入展开预处理节点
    if (node.type.startsWith('preproc_') || indent < 2) {
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child) {
                printAST(child, sourceCode, indent + 1, maxDepth);
            }
        }
    }
}

async function analyzeEMailSenderStructure() {
    console.log('=== 分析 EMailSender.h 的关键条件编译结构 ===\n');

    const filePath = 'c:\\Users\\coloz\\Desktop\\project_oct14f\\.temp\\libraries\\lib-emailsender\\EMailSender.h';
    const sourceCode = await fs.readFile(filePath, 'utf8');
    
    const parser = new Parser();
    parser.setLanguage(Cpp);
    
    const tree = parser.parse(sourceCode);
    
    // 找到关键的条件编译部分（大约在 EMAIL_NETWORK_TYPE == NETWORK_ESP32 的部分）
    const lines = sourceCode.split('\n');
    let targetLineStart = -1;
    let targetLineEnd = -1;
    
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('EMAIL_NETWORK_TYPE == NETWORK_ESP32') && !lines[i].includes('NETWORK_ESP32_ETH')) {
            targetLineStart = i;
            console.log(`找到目标条件编译块，开始行: ${i + 1}`);
            console.log(`内容: ${lines[i]}`);
            
            // 找到对应的 #elif 或 #else
            let depth = 1;
            for (let j = i + 1; j < lines.length && depth > 0; j++) {
                const line = lines[j].trim();
                if (line.startsWith('#if')) {
                    depth++;
                } else if (line.startsWith('#endif')) {
                    depth--;
                    if (depth === 0) {
                        targetLineEnd = j;
                        break;
                    }
                } else if (depth === 1 && (line.startsWith('#elif') || line.startsWith('#else'))) {
                    targetLineEnd = j - 1;
                    break;
                }
            }
            break;
        }
    }
    
    if (targetLineStart >= 0 && targetLineEnd >= 0) {
        console.log(`结束行: ${targetLineEnd + 1}\n`);
        console.log('条件编译块内容:');
        console.log('----------------------------------------');
        for (let i = targetLineStart; i <= targetLineEnd; i++) {
            console.log(`${String(i + 1).padStart(4, ' ')}: ${lines[i]}`);
        }
        console.log('----------------------------------------\n');
    }
    
    // 分析整个文件中与 NETWORK_ESP32 相关的条件编译
    console.log('搜索所有 NETWORK_ESP32 相关的条件:');
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('NETWORK_ESP32')) {
            console.log(`${String(i + 1).padStart(4, ' ')}: ${lines[i]}`);
        }
    }
    console.log('');
    
    // 查找包含 WiFi.h 的部分
    console.log('搜索所有包含 WiFi.h 的位置:');
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('WiFi.h')) {
            console.log(`${String(i + 1).padStart(4, ' ')}: ${lines[i]}`);
            // 显示上下文
            if (i > 0) console.log(`${String(i).padStart(4, ' ')}: ${lines[i-1]}`);
            if (i < lines.length - 1) console.log(`${String(i + 2).padStart(4, ' ')}: ${lines[i+1]}`);
            console.log('');
        }
    }
}

async function testSimpleElifCase() {
    console.log('\n=== 测试简化的 elif 场景 ===\n');
    
    const testContent = `
#if(EMAIL_NETWORK_TYPE == NETWORK_ESP8266)
#include <ESP8266WiFi.h>
#elif(EMAIL_NETWORK_TYPE == NETWORK_ESP32)
#include <WiFi.h>
#include <WiFiClientSecure.h>
#elif(EMAIL_NETWORK_TYPE == NETWORK_ESP32_ETH)
#include <ETH.h>
#else
#error "no network"
#endif
`;

    console.log('测试代码:');
    console.log(testContent);
    
    const parser = new Parser();
    parser.setLanguage(Cpp);
    
    const tree = parser.parse(testContent);
    
    console.log('\nAST 结构:');
    printAST(tree.rootNode, testContent, 0, 8);
}

(async () => {
    await analyzeEMailSenderStructure();
    await testSimpleElifCase();
})();
