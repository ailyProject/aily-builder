import { analyzeFileWithDefines, MacroDefinition } from './src/utils/AnalyzeFile';

/**
 * 测试 ESP32 平台的 EMailSender.h 分析
 */
async function testESP32EmailSender() {
    console.log('=== 测试 ESP32 平台的 EMailSender.h ===\n');

    const testFilePath = 'c:\\Users\\coloz\\Desktop\\project_oct14f\\.temp\\libraries\\lib-emailsender\\EMailSender.h';

    // ESP32 平台的典型宏定义
    const defines = new Map<string, MacroDefinition>([
        ['ESP32', { name: 'ESP32', value: '1', isDefined: true }],
        ['ARDUINO', { name: 'ARDUINO', value: '10607', isDefined: true }], // Arduino 1.6.7+
    ]);

    console.log('定义的宏:');
    for (const [name, def] of defines) {
        console.log(`  ${name} = ${def.value}`);
    }
    console.log('');

    const result = await analyzeFileWithDefines(testFilePath, defines);
    
    console.log('包含的头文件 (' + result.includes.length + ' 个):');
    result.includes.forEach((inc, idx) => {
        console.log(`  ${idx + 1}. ${inc}`);
    });
    console.log('');

    // 检查关键头文件
    const expectedIncludes = [
        'EMailSenderKey.h',
        'Client.h',
        'Arduino.h',
        'WiFi.h',
        'WiFiClientSecure.h'
    ];

    console.log('验证关键头文件:');
    for (const expected of expectedIncludes) {
        if (result.includes.includes(expected)) {
            console.log(`  ✅ ${expected}`);
        } else {
            console.log(`  ❌ 缺少 ${expected}`);
        }
    }
    console.log('');

    // 检查新定义的宏
    console.log('新定义的宏:');
    const newDefines = ['EMAIL_NETWORK_TYPE', 'INTERNAL_STORAGE', 'EXTERNAL_STORAGE'];
    for (const macroName of newDefines) {
        if (result.defines.has(macroName)) {
            const def = result.defines.get(macroName)!;
            console.log(`  ${macroName} = ${def.value}`);
        }
    }
}

// 运行测试
(async () => {
    try {
        // 启用调试输出
        process.env.DEBUG_EXPR = '1';
        await testESP32EmailSender();
        console.log('\n✅ 测试完成');
    } catch (error) {
        console.error('❌ 测试失败:', error);
        process.exit(1);
    }
})();
