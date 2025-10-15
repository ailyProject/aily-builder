import { analyzeFileWithDefines, MacroDefinition } from './src/utils/AnalyzeFile';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * 测试链式 elif 的解析
 */
async function testChainedElif() {
    console.log('=== 测试链式 elif 解析 ===\n');

    const testFilePath = path.join(__dirname, 'test-chained-elif.cpp');
    const testContent = `
#include "base.h"

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

#include "end.h"
`;

    await fs.writeFile(testFilePath, testContent, 'utf8');
    console.log('测试内容:');
    console.log(testContent);
    console.log('\n');

    // 场景1: EMAIL_NETWORK_TYPE == NETWORK_ESP8266
    console.log('场景1: EMAIL_NETWORK_TYPE = NETWORK_ESP8266');
    const defines1 = new Map<string, MacroDefinition>([
        ['EMAIL_NETWORK_TYPE', { name: 'EMAIL_NETWORK_TYPE', value: 'NETWORK_ESP8266', isDefined: true }],
        ['NETWORK_ESP8266', { name: 'NETWORK_ESP8266', value: '1', isDefined: true }]
    ]);
    const result1 = await analyzeFileWithDefines(testFilePath, defines1);
    console.log('包含的头文件:', result1.includes);
    console.log('预期: ["base.h", "ESP8266WiFi.h", "end.h"]');
    console.log('结果:', result1.includes.includes('ESP8266WiFi.h') ? '✅' : '❌');
    console.log('');

    // 场景2: EMAIL_NETWORK_TYPE == NETWORK_ESP32
    console.log('场景2: EMAIL_NETWORK_TYPE = NETWORK_ESP32');
    const defines2 = new Map<string, MacroDefinition>([
        ['EMAIL_NETWORK_TYPE', { name: 'EMAIL_NETWORK_TYPE', value: 'NETWORK_ESP32', isDefined: true }],
        ['NETWORK_ESP32', { name: 'NETWORK_ESP32', value: '1', isDefined: true }]
    ]);
    const result2 = await analyzeFileWithDefines(testFilePath, defines2);
    console.log('包含的头文件:', result2.includes);
    console.log('预期: ["base.h", "WiFi.h", "WiFiClientSecure.h", "end.h"]');
    const hasWiFi = result2.includes.includes('WiFi.h');
    const hasWiFiSecure = result2.includes.includes('WiFiClientSecure.h');
    console.log('结果:', (hasWiFi && hasWiFiSecure) ? '✅' : '❌');
    if (!hasWiFi) console.log('  ❌ 缺少 WiFi.h');
    if (!hasWiFiSecure) console.log('  ❌ 缺少 WiFiClientSecure.h');
    console.log('');

    // 场景3: EMAIL_NETWORK_TYPE == NETWORK_ESP32_ETH
    console.log('场景3: EMAIL_NETWORK_TYPE = NETWORK_ESP32_ETH');
    const defines3 = new Map<string, MacroDefinition>([
        ['EMAIL_NETWORK_TYPE', { name: 'EMAIL_NETWORK_TYPE', value: 'NETWORK_ESP32_ETH', isDefined: true }],
        ['NETWORK_ESP32_ETH', { name: 'NETWORK_ESP32_ETH', value: '1', isDefined: true }]
    ]);
    const result3 = await analyzeFileWithDefines(testFilePath, defines3);
    console.log('包含的头文件:', result3.includes);
    console.log('预期: ["base.h", "ETH.h", "end.h"]');
    console.log('结果:', result3.includes.includes('ETH.h') ? '✅' : '❌');
    console.log('');

    // 场景4: 无匹配（走 else）
    console.log('场景4: EMAIL_NETWORK_TYPE = OTHER (走else分支)');
    const defines4 = new Map<string, MacroDefinition>([
        ['EMAIL_NETWORK_TYPE', { name: 'EMAIL_NETWORK_TYPE', value: 'OTHER', isDefined: true }],
        ['OTHER', { name: 'OTHER', value: '1', isDefined: true }]
    ]);
    const result4 = await analyzeFileWithDefines(testFilePath, defines4);
    console.log('包含的头文件:', result4.includes);
    console.log('预期: ["base.h", "end.h"] (else 分支有 #error，不应有其他 include)');
    console.log('结果:', result4.includes.length === 2 ? '✅' : '❌');
    console.log('');

    await fs.unlink(testFilePath);
    console.log('测试文件已删除\n');
}

// 运行测试
(async () => {
    try {
        await testChainedElif();
        console.log('✅ 测试完成');
    } catch (error) {
        console.error('❌ 测试失败:', error);
        process.exit(1);
    }
})();
