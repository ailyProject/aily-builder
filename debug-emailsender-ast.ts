import Parser, { SyntaxNode } from 'tree-sitter';
import Cpp from 'tree-sitter-cpp';
import { promises as fs } from 'fs';

// 打印AST结构
function printAST(node: SyntaxNode, sourceCode: string, indent = 0, maxDepth = 5) {
    if (indent > maxDepth) return;
    
    const prefix = '  '.repeat(indent);
    const nodeText = sourceCode.substring(node.startIndex, node.endIndex);
    const shortText = nodeText.length > 60 ? nodeText.substring(0, 60) + '...' : nodeText;
    
    console.log(`${prefix}${node.type}: ${shortText.replace(/\n/g, '\\n')}`);
    
    // 只展开预处理节点
    if (node.type.startsWith('preproc_')) {
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child) {
                printAST(child, sourceCode, indent + 1, maxDepth);
            }
        }
    }
}

async function debugEMailSenderStructure() {
    console.log('=== 调试 EMailSender.h 中 WiFiNINA 部分的 AST 结构 ===\n');

    const filePath = 'c:\\Users\\coloz\\Desktop\\project_oct14f\\.temp\\libraries\\lib-emailsender\\EMailSender.h';
    
    const content = await fs.readFile(filePath, 'utf8');
    
    // 查找 WiFiNINA 相关的代码段
    const wifiNinaStart = content.indexOf('#elif(EMAIL_NETWORK_TYPE == NETWORK_WiFiNINA)');
    const wifiNinaEnd = content.indexOf('#elif(EMAIL_NETWORK_TYPE == NETWORK_MBED_WIFI)', wifiNinaStart);
    
    if (wifiNinaStart === -1) {
        console.log('未找到 WiFiNINA 部分');
        return;
    }
    
    const wifiNinaSection = content.substring(wifiNinaStart, wifiNinaEnd > 0 ? wifiNinaEnd : wifiNinaStart + 500);
    console.log('WiFiNINA 代码段:');
    console.log(wifiNinaSection);
    console.log('\n');

    // 解析整个文件的 AST
    const parser = new Parser();
    parser.setLanguage(Cpp);
    const tree = parser.parse(content);
    
    // 查找包含 WiFiNINA 的节点
    function findWiFiNINANode(node: SyntaxNode): SyntaxNode | null {
        const text = content.substring(node.startIndex, node.endIndex);
        if (text.includes('NETWORK_WiFiNINA')) {
            return node;
        }
        
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child) {
                const result = findWiFiNINANode(child);
                if (result) return result;
            }
        }
        
        return null;
    }
    
    const wifiNinaNode = findWiFiNINANode(tree.rootNode);
    if (wifiNinaNode) {
        console.log('\nWiFiNINA 节点的 AST 结构:');
        printAST(wifiNinaNode, content, 0, 8);
    }

    // 查找 STORAGE_INTERNAL_ENABLED 部分
    console.log('\n\n=== 查找 STORAGE_INTERNAL_ENABLED 部分 ===\n');
    const storageStart = content.indexOf('#ifdef STORAGE_INTERNAL_ENABLED');
    const storageEnd = content.indexOf('#endif', storageStart + 1);
    
    if (storageStart !== -1) {
        const storageSection = content.substring(storageStart, storageEnd > 0 ? storageEnd + 6 : storageStart + 800);
        console.log('Storage 代码段:');
        console.log(storageSection.substring(0, 500));
        console.log('...\n');
        
        function findStorageNode(node: SyntaxNode): SyntaxNode | null {
            const text = content.substring(node.startIndex, node.endIndex);
            if (text.includes('STORAGE_INTERNAL_ENABLED') && node.type.startsWith('preproc_')) {
                return node;
            }
            
            for (let i = 0; i < node.childCount; i++) {
                const child = node.child(i);
                if (child) {
                    const result = findStorageNode(child);
                    if (result) return result;
                }
            }
            
            return null;
        }
        
        const storageNode = findStorageNode(tree.rootNode);
        if (storageNode) {
            console.log('\nStorage 节点的 AST 结构:');
            printAST(storageNode, content, 0, 6);
        }
    }
}

(async () => {
    await debugEMailSenderStructure();
})();
