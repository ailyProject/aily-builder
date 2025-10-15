import { analyzeFileWithDefines, MacroDefinition } from './src/utils/AnalyzeFile';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * 测试 BlinkerTimer.h 的条件编译
 */
async function testBlinkerTimer() {
    console.log('=== 测试 BlinkerTimer.h 条件编译 ===\n');

    // 创建测试文件
    const testFilePath = path.join(__dirname, 'test-blinker-timer.h');
    const testContent = `
#ifndef BLINKER_TIMER_H
#define BLINKER_TIMER_H

#if defined(ESP32)

#include <Ticker.h>
#include <EEPROM.h>

#elif defined(ARDUINO_ARCH_RENESAS)

#include "RenesasTicker.h"
#include <EEPROM.h>

// 为Renesas平台定义Ticker别名，确保与ESP32兼容
typedef RenesasTicker Ticker;

#endif

#if defined(ESP32) || defined(ARDUINO_ARCH_RENESAS)

extern Ticker cdTicker;
extern Ticker lpTicker;
extern Ticker tmTicker;

#endif

#endif
`;

    await fs.writeFile(testFilePath, testContent, 'utf8');
    console.log('测试文件已创建');
    console.log('');

    // 场景1: ESP32 平台
    console.log('场景1: ESP32 平台');
    const defines1 = new Map<string, MacroDefinition>([
        ['ESP32', { name: 'ESP32', value: '1', isDefined: true }]
    ]);
    
    process.env.DEBUG_EXPR = '1';
    const result1 = await analyzeFileWithDefines(testFilePath, defines1);
    delete process.env.DEBUG_EXPR;
    
    console.log('包含的头文件:', result1.includes);
    console.log('');
    
    const expectedESP32 = ['Ticker.h', 'EEPROM.h'];
    console.log('验证:');
    for (const expected of expectedESP32) {
        if (result1.includes.includes(expected)) {
            console.log(`  ✅ ${expected}`);
        } else {
            console.log(`  ❌ 缺少 ${expected}`);
        }
    }
    console.log('');

    // 场景2: ARDUINO_ARCH_RENESAS 平台
    console.log('场景2: ARDUINO_ARCH_RENESAS 平台');
    const defines2 = new Map<string, MacroDefinition>([
        ['ARDUINO_ARCH_RENESAS', { name: 'ARDUINO_ARCH_RENESAS', value: '1', isDefined: true }]
    ]);
    
    const result2 = await analyzeFileWithDefines(testFilePath, defines2);
    
    console.log('包含的头文件:', result2.includes);
    console.log('');
    
    const expectedRenesas = ['RenesasTicker.h', 'EEPROM.h'];
    console.log('验证:');
    for (const expected of expectedRenesas) {
        if (result2.includes.includes(expected)) {
            console.log(`  ✅ ${expected}`);
        } else {
            console.log(`  ❌ 缺少 ${expected}`);
        }
    }
    console.log('');

    // 场景3: 无任何宏定义
    console.log('场景3: 无任何宏定义');
    const defines3 = new Map<string, MacroDefinition>();
    
    const result3 = await analyzeFileWithDefines(testFilePath, defines3);
    
    console.log('包含的头文件:', result3.includes);
    console.log('预期: [] (空，因为条件都不满足)');
    console.log('');

    await fs.unlink(testFilePath);
}

// 运行测试
(async () => {
    try {
        await testBlinkerTimer();
        console.log('✅ 测试完成');
    } catch (error) {
        console.error('❌ 测试失败:', error);
        process.exit(1);
    }
})();
