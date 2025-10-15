import Parser from 'tree-sitter';
import Cpp from 'tree-sitter-cpp';
import { promises as fs } from 'fs';
import path from 'path';

async function debugParenthesizedIf() {
    console.log('=== 调试带括号的 #if ===\n');

    const testFilePath = path.join(__dirname, 'test-paren-if.cpp');
    const testContent = `
#define A 1
#define B 1

#if(A == B)
    #include <test.h>
#endif
`;

    await fs.writeFile(testFilePath, testContent, 'utf8');

    const parser = new Parser();
    parser.setLanguage(Cpp);
    
    const tree = parser.parse(testContent);
    
    function printNode(node: any, sourceCode: string, indent = 0) {
        const prefix = '  '.repeat(indent);
        const text = sourceCode.substring(node.startIndex, node.endIndex);
        const shortText = text.length > 50 ? text.substring(0, 50) + '...' : text;
        console.log(`${prefix}${node.type}: ${shortText.replace(/\n/g, '\\n')}`);
        
        // 打印所有子节点
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child) {
                printNode(child, sourceCode, indent + 1);
            }
        }
    }
    
    console.log('AST结构:');
    printNode(tree.rootNode, testContent);

    await fs.unlink(testFilePath);
}

(async () => {
    await debugParenthesizedIf();
})();
