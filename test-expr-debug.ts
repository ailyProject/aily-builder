import { analyzeFileWithDefines, MacroDefinition } from './src/utils/AnalyzeFile';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * 调试表达式评估
 */
async function debugExpressionEval() {
    console.log('=== 调试表达式评估 ===\n');

    // 创建测试文件
    const testFilePath = path.join(__dirname, 'test-expr-eval.cpp');
    const testContent = `
#if (EMAIL_NETWORK_TYPE == NETWORK_WiFiNINA)
    #include <WiFiNINA.h>
#endif
`;

    await fs.writeFile(testFilePath, testContent, 'utf8');

    // 定义宏
    const defines = new Map<string, MacroDefinition>([
        ['EMAIL_NETWORK_TYPE', { name: 'EMAIL_NETWORK_TYPE', value: '10', isDefined: true }],
        ['NETWORK_WiFiNINA', { name: 'NETWORK_WiFiNINA', value: '10', isDefined: true }]
    ]);
    
    console.log('定义的宏:');
    for (const [name, def] of defines) {
        console.log(`  ${name} = ${def.value}`);
    }
    console.log('');

    console.log('条件表达式: EMAIL_NETWORK_TYPE == NETWORK_WiFiNINA');
    console.log('预期: true (10 == 10)');
    console.log('');

    const result = await analyzeFileWithDefines(testFilePath, defines);
    console.log('包含的头文件:', result.includes);
    
    if (result.includes.includes('WiFiNINA.h')) {
        console.log('✅ 条件评估正确');
    } else {
        console.log('❌ 条件评估失败');
    }

    await fs.unlink(testFilePath);
}

(async () => {
    await debugExpressionEval();
})();
