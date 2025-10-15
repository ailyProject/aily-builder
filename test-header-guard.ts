import { analyzeFileWithDefines, MacroDefinition } from './src/utils/AnalyzeFile';

process.env.DEBUG_CONDITIONAL = '1';

async function testBlinkerTimer() {
    const filePath = 'c:\\Users\\coloz\\Documents\\aily-project\\project_oct15a\\.temp\\libraries\\Blinker\\Widgets\\BlinkerTimer.h';
    
    console.log('=== 测试1: 没有预定义 BLINKER_TIMER_H ===');
    const defines1 = new Map<string, MacroDefinition>();
    defines1.set('ESP32', { name: 'ESP32', value: '1', isDefined: true });
    const result1 = await analyzeFileWithDefines(filePath, defines1, { throwOnError: true });
    console.log('结果:', result1.includes);
    console.log('');

    console.log('=== 测试2: 预定义了 BLINKER_TIMER_H ===');
    const defines2 = new Map<string, MacroDefinition>();
    defines2.set('ESP32', { name: 'ESP32', value: '1', isDefined: true });
    defines2.set('BLINKER_TIMER_H', { name: 'BLINKER_TIMER_H', value: '1', isDefined: true });
    const result2 = await analyzeFileWithDefines(filePath, defines2, { throwOnError: true });
    console.log('结果:', result2.includes);
}

testBlinkerTimer().catch(console.error);
