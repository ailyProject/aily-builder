import { analyzeFileWithDefines, MacroDefinition } from './src/utils/AnalyzeFile';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * 测试简单的 #define 和 #elif 组合
 */
async function testDefineAndElif() {
    console.log('=== 测试 #define 和 #elif 的交互 ===\n');

    // 创建测试文件
    const testFilePath = path.join(__dirname, 'test-define-elif.cpp');
    const testContent = `
#if !defined(EMAIL_NETWORK_TYPE)
    #if defined(ARDUINO_ARCH_SAMD)
        #define EMAIL_NETWORK_TYPE DEFAULT_EMAIL_NETWORK_TYPE_SAMD
    #endif
#endif

#if(EMAIL_NETWORK_TYPE == NETWORK_WiFiNINA)
    #include <WiFiNINA.h>
#elif(EMAIL_NETWORK_TYPE == NETWORK_ESP32)
    #include <WiFi.h>
#endif
`;

    await fs.writeFile(testFilePath, testContent, 'utf8');
    console.log('测试内容:');
    console.log(testContent);
    console.log('');

    // 测试场景1: 定义 ARDUINO_ARCH_SAMD 和相关常量
    console.log('场景1: ARDUINO_ARCH_SAMD + 相关常量');
    const defines1 = new Map<string, MacroDefinition>([
        ['ARDUINO_ARCH_SAMD', { name: 'ARDUINO_ARCH_SAMD', value: '1', isDefined: true }],
        ['DEFAULT_EMAIL_NETWORK_TYPE_SAMD', { name: 'DEFAULT_EMAIL_NETWORK_TYPE_SAMD', value: '10', isDefined: true }],
        ['NETWORK_WiFiNINA', { name: 'NETWORK_WiFiNINA', value: '10', isDefined: true }]
    ]);
    
    const result1 = await analyzeFileWithDefines(testFilePath, defines1);
    console.log('包含的头文件:', result1.includes);
    console.log('定义的宏:');
    for (const [name, def] of result1.defines) {
        if (name === 'EMAIL_NETWORK_TYPE') {
            console.log(`  ${name} = ${def.value} (isDefined: ${def.isDefined})`);
        }
    }
    
    if (result1.includes.includes('WiFiNINA.h')) {
        console.log('✅ 正确包含了 WiFiNINA.h');
    } else {
        console.log('❌ 未包含 WiFiNINA.h');
    }
    console.log('');

    // 测试场景2: 直接定义 EMAIL_NETWORK_TYPE
    console.log('场景2: 直接定义 EMAIL_NETWORK_TYPE');
    const defines2 = new Map<string, MacroDefinition>([
        ['EMAIL_NETWORK_TYPE', { name: 'EMAIL_NETWORK_TYPE', value: '10', isDefined: true }],
        ['NETWORK_WiFiNINA', { name: 'NETWORK_WiFiNINA', value: '10', isDefined: true }]
    ]);
    
    const result2 = await analyzeFileWithDefines(testFilePath, defines2);
    console.log('包含的头文件:', result2.includes);
    
    if (result2.includes.includes('WiFiNINA.h')) {
        console.log('✅ 正确包含了 WiFiNINA.h');
    } else {
        console.log('❌ 未包含 WiFiNINA.h');
    }
    console.log('');

    await fs.unlink(testFilePath);
}

// 运行测试
(async () => {
    try {
        await testDefineAndElif();
        console.log('\n✅ 测试完成');
    } catch (error) {
        console.error('❌ 测试失败:', error);
        process.exit(1);
    }
})();
