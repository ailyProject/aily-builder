import Parser, { SyntaxNode } from 'tree-sitter';
import Cpp from 'tree-sitter-cpp';
import { promises as fs } from 'fs';
import path from 'path';

// 打印AST结构
function printAST(node: SyntaxNode, sourceCode: string, indent = 0) {
    const prefix = '  '.repeat(indent);
    const nodeText = sourceCode.substring(node.startIndex, node.endIndex);
    const shortText = nodeText.length > 50 ? nodeText.substring(0, 50) + '...' : nodeText;
    
    console.log(`${prefix}${node.type} [${node.startIndex}-${node.endIndex}]: ${shortText.replace(/\n/g, '\\n')}`);
    
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) {
            printAST(child, sourceCode, indent + 1);
        }
    }
}

async function debugNestedConditional() {
    console.log('=== 调试嵌套条件编译的AST结构 ===\n');

    const testFilePath = path.join(__dirname, 'test-debug.cpp');
    const testContent = `
#include "Blinker/BlinkerApi.h"
#if defined(BLINKER_WIFI)
    #if defined(ESP32)
        #if defined(BLINKER_WIFI_MULTI)
            extern WiFiMulti wifiMulti;
        #endif
    #elif defined(ARDUINO_ARCH_RENESAS)
        #include "RTC.h"
        #include "../modules/NTPClient/NTPClient.h"
    #endif
#endif
`;

    await fs.writeFile(testFilePath, testContent, 'utf8');
    
    const parser = new Parser();
    parser.setLanguage(Cpp);
    
    const tree = parser.parse(testContent);
    
    console.log('AST结构:');
    printAST(tree.rootNode, testContent);
    
    await fs.unlink(testFilePath);
}

async function debugSimpleElif() {
    console.log('\n\n=== 调试简单#elif的AST结构 ===\n');

    const testFilePath = path.join(__dirname, 'test-elif.cpp');
    const testContent = `
#include "base.h"
#if defined(A)
    #include "a.h"
#elif defined(D)
    #include "d.h"
#else
    #include "default.h"
#endif
`;

    await fs.writeFile(testFilePath, testContent, 'utf8');
    
    const parser = new Parser();
    parser.setLanguage(Cpp);
    
    const tree = parser.parse(testContent);
    
    console.log('AST结构:');
    printAST(tree.rootNode, testContent);
    
    await fs.unlink(testFilePath);
}

(async () => {
    await debugNestedConditional();
    await debugSimpleElif();
})();
