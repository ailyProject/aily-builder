import Parser from 'tree-sitter';
import Cpp from 'tree-sitter-cpp';
import { promises as fs } from 'fs';

async function debugBlinkerTimerAST() {
    console.log('=== 调试 BlinkerTimer.h 的 AST ===\n');

    const filePath = 'c:\\Users\\coloz\\Documents\\aily-project\\project_oct15a\\.temp\\libraries\\Blinker\\Widgets\\BlinkerTimer.h';
    
    const content = await fs.readFile(filePath, 'utf8');
    console.log('文件长度:', content.length);
    console.log('前100个字符:', content.substring(0, 100).replace(/\n/g, '\\n'));
    console.log('');

    const parser = new Parser();
    parser.setLanguage(Cpp);
    
    const tree = parser.parse(content);
    
    function printNode(node: any, sourceCode: string, indent = 0, maxDepth = 3) {
        if (indent > maxDepth) return;
        
        const prefix = '  '.repeat(indent);
        const text = sourceCode.substring(node.startIndex, node.endIndex);
        const shortText = text.length > 60 ? text.substring(0, 60) + '...' : text;
        console.log(`${prefix}${node.type}: ${shortText.replace(/\n/g, '\\n')}`);
        
        if (node.type.startsWith('preproc_')) {
            for (let i = 0; i < node.childCount; i++) {
                const child = node.child(i);
                if (child) {
                    printNode(child, sourceCode, indent + 1, maxDepth);
                }
            }
        }
    }
    
    console.log('AST 根节点:');
    printNode(tree.rootNode, content, 0, 2);
    
    // 查找第一个 preproc_ifdef
    function findFirstIfdef(node: any): any {
        if (node.type === 'preproc_ifdef') {
            return node;
        }
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child) {
                const found = findFirstIfdef(child);
                if (found) return found;
            }
        }
        return null;
    }
    
    const firstIfdef = findFirstIfdef(tree.rootNode);
    if (firstIfdef) {
        console.log('\n第一个 #ifdef 节点详细结构:');
        printNode(firstIfdef, content, 0, 5);
    }
}

(async () => {
    try {
        await debugBlinkerTimerAST();
    } catch (error) {
        console.error('错误:', error);
    }
})();
