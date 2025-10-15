import { analyzeFileWithDefines, MacroDefinition } from './src/utils/AnalyzeFile';

/**
 * 测试实际的 BlinkerTimer.h 文件
 */
async function testActualBlinkerTimer() {
    console.log('=== 测试实际的 BlinkerTimer.h 文件 ===\n');

    const testFilePath = 'c:\\Users\\coloz\\Documents\\aily-project\\project_oct15a\\.temp\\libraries\\Blinker\\Widgets\\BlinkerTimer.h';

    // ESP32 平台
    console.log('场景1: ESP32 平台');
    const defines1 = new Map<string, MacroDefinition>([
        ['ESP32', { name: 'ESP32', value: '1', isDefined: true }]
    ]);
    
    process.env.DEBUG_EXPR = '1';
    const result1 = await analyzeFileWithDefines(testFilePath, defines1, { throwOnError: true });
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

    // ARDUINO_ARCH_RENESAS 平台
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
}

// 运行测试
(async () => {
    try {
        await testActualBlinkerTimer();
        console.log('\n✅ 测试完成');
    } catch (error) {
        console.error('❌ 测试失败:', error);
        process.exit(1);
    }
})();
