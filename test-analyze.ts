import { analyzeFileWithDefines, MacroDefinition } from './src/utils/AnalyzeFile';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * 测试嵌套条件编译的解析
 */
async function testNestedConditionals() {
    console.log('=== 测试嵌套条件编译解析 ===\n');

    // 创建测试文件
    const testFilePath = path.join(__dirname, 'test-nested-conditional.cpp');
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
        #include <WiFiS3.h>
        #include <WiFiUdp.h>
    #endif
#endif
`;

    await fs.writeFile(testFilePath, testContent, 'utf8');
    console.log('测试文件已创建:', testFilePath);
    console.log('测试内容:');
    console.log(testContent);
    console.log('\n');

    // 场景1: BLINKER_WIFI + ESP32 (不包含BLINKER_WIFI_MULTI)
    console.log('场景1: BLINKER_WIFI=1, ESP32=1');
    const defines1 = new Map<string, MacroDefinition>([
        ['BLINKER_WIFI', { name: 'BLINKER_WIFI', value: '1', isDefined: true }],
        ['ESP32', { name: 'ESP32', value: '1', isDefined: true }]
    ]);
    const result1 = await analyzeFileWithDefines(testFilePath, defines1);
    console.log('包含的头文件:', result1.includes);
    console.log('预期: ["Blinker/BlinkerApi.h"]');
    console.log('');

    // 场景2: BLINKER_WIFI + ESP32 + BLINKER_WIFI_MULTI
    console.log('场景2: BLINKER_WIFI=1, ESP32=1, BLINKER_WIFI_MULTI=1');
    const defines2 = new Map<string, MacroDefinition>([
        ['BLINKER_WIFI', { name: 'BLINKER_WIFI', value: '1', isDefined: true }],
        ['ESP32', { name: 'ESP32', value: '1', isDefined: true }],
        ['BLINKER_WIFI_MULTI', { name: 'BLINKER_WIFI_MULTI', value: '1', isDefined: true }]
    ]);
    const result2 = await analyzeFileWithDefines(testFilePath, defines2);
    console.log('包含的头文件:', result2.includes);
    console.log('预期: ["Blinker/BlinkerApi.h"]');
    console.log('');

    // 场景3: BLINKER_WIFI + ARDUINO_ARCH_RENESAS (elif分支)
    console.log('场景3: BLINKER_WIFI=1, ARDUINO_ARCH_RENESAS=1');
    const defines3 = new Map<string, MacroDefinition>([
        ['BLINKER_WIFI', { name: 'BLINKER_WIFI', value: '1', isDefined: true }],
        ['ARDUINO_ARCH_RENESAS', { name: 'ARDUINO_ARCH_RENESAS', value: '1', isDefined: true }]
    ]);
    const result3 = await analyzeFileWithDefines(testFilePath, defines3);
    console.log('包含的头文件:', result3.includes);
    console.log('预期: ["Blinker/BlinkerApi.h", "RTC.h", "../modules/NTPClient/NTPClient.h", "WiFiS3.h", "WiFiUdp.h"]');
    console.log('');

    // 场景4: 没有定义任何宏
    console.log('场景4: 没有定义任何宏');
    const defines4 = new Map<string, MacroDefinition>();
    const result4 = await analyzeFileWithDefines(testFilePath, defines4);
    console.log('包含的头文件:', result4.includes);
    console.log('预期: ["Blinker/BlinkerApi.h"]');
    console.log('');

    // 场景5: 只定义BLINKER_WIFI
    console.log('场景5: 只定义BLINKER_WIFI=1');
    const defines5 = new Map<string, MacroDefinition>([
        ['BLINKER_WIFI', { name: 'BLINKER_WIFI', value: '1', isDefined: true }]
    ]);
    const result5 = await analyzeFileWithDefines(testFilePath, defines5);
    console.log('包含的头文件:', result5.includes);
    console.log('预期: ["Blinker/BlinkerApi.h"]');
    console.log('');

    // 清理测试文件
    await fs.unlink(testFilePath);
    console.log('测试文件已删除');
}

/**
 * 测试更复杂的嵌套情况
 */
async function testComplexNesting() {
    console.log('\n=== 测试复杂嵌套场景 ===\n');

    const testFilePath = path.join(__dirname, 'test-complex-nested.cpp');
    const testContent = `
#include "base.h"

#if defined(A)
    #include "a1.h"
    #if defined(B)
        #include "a-b.h"
    #elif defined(C)
        #include "a-c.h"
    #else
        #include "a-other.h"
    #endif
    #include "a2.h"
#elif defined(D)
    #include "d.h"
#else
    #include "default.h"
#endif

#include "end.h"
`;

    await fs.writeFile(testFilePath, testContent, 'utf8');
    console.log('测试文件已创建:', testFilePath);
    console.log('测试内容:');
    console.log(testContent);
    console.log('\n');

    // 场景1: A + B
    console.log('场景1: A=1, B=1');
    const defines1 = new Map<string, MacroDefinition>([
        ['A', { name: 'A', value: '1', isDefined: true }],
        ['B', { name: 'B', value: '1', isDefined: true }]
    ]);
    const result1 = await analyzeFileWithDefines(testFilePath, defines1);
    console.log('包含的头文件:', result1.includes);
    console.log('预期: ["base.h", "a1.h", "a-b.h", "a2.h", "end.h"]');
    console.log('');

    // 场景2: A + C
    console.log('场景2: A=1, C=1');
    const defines2 = new Map<string, MacroDefinition>([
        ['A', { name: 'A', value: '1', isDefined: true }],
        ['C', { name: 'C', value: '1', isDefined: true }]
    ]);
    const result2 = await analyzeFileWithDefines(testFilePath, defines2);
    console.log('包含的头文件:', result2.includes);
    console.log('预期: ["base.h", "a1.h", "a-c.h", "a2.h", "end.h"]');
    console.log('');

    // 场景3: A (无B和C，走else)
    console.log('场景3: A=1 (无B和C)');
    const defines3 = new Map<string, MacroDefinition>([
        ['A', { name: 'A', value: '1', isDefined: true }]
    ]);
    const result3 = await analyzeFileWithDefines(testFilePath, defines3);
    console.log('包含的头文件:', result3.includes);
    console.log('预期: ["base.h", "a1.h", "a-other.h", "a2.h", "end.h"]');
    console.log('');

    // 场景4: D
    console.log('场景4: D=1');
    const defines4 = new Map<string, MacroDefinition>([
        ['D', { name: 'D', value: '1', isDefined: true }]
    ]);
    const result4 = await analyzeFileWithDefines(testFilePath, defines4);
    console.log('包含的头文件:', result4.includes);
    console.log('预期: ["base.h", "d.h", "end.h"]');
    console.log('');

    // 场景5: 无任何宏定义
    console.log('场景5: 无任何宏定义');
    const defines5 = new Map<string, MacroDefinition>();
    const result5 = await analyzeFileWithDefines(testFilePath, defines5);
    console.log('包含的头文件:', result5.includes);
    console.log('预期: ["base.h", "default.h", "end.h"]');
    console.log('');

    // 清理测试文件
    await fs.unlink(testFilePath);
    console.log('测试文件已删除');
}

// 运行测试
(async () => {
    try {
        await testNestedConditionals();
        await testComplexNesting();
        console.log('\n✅ 所有测试完成');
    } catch (error) {
        console.error('❌ 测试失败:', error);
        process.exit(1);
    }
})();
