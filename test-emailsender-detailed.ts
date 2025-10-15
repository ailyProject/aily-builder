import { analyzeFileWithDefines, MacroDefinition } from './src/utils/AnalyzeFile';

/**
 * 详细测试 EMailSender.h 的条件编译逻辑
 */
async function testEMailSenderDetailed() {
    console.log('=== 详细测试 EMailSender.h 条件编译 ===\n');

    const testFilePath = 'c:\\Users\\coloz\\Desktop\\project_oct14f\\.temp\\libraries\\lib-emailsender\\EMailSender.h';

    // 测试 WiFiNINA 网络类型
    console.log('测试1: Arduino SAMD + WiFiNINA');
    const defines1 = new Map<string, MacroDefinition>([
        ['ARDUINO_ARCH_SAMD', { name: 'ARDUINO_ARCH_SAMD', value: '1', isDefined: true }],
        ['ARDUINO', { name: 'ARDUINO', value: '100', isDefined: true }]
    ]);
    
    const result1 = await analyzeFileWithDefines(testFilePath, defines1);
    console.log('包含的头文件:', result1.includes);
    console.log('新定义的宏:');
    for (const [name, def] of result1.defines) {
        if (defines1.has(name)) continue; // 跳过原有的
        console.log(`  ${name} = ${def.value}`);
    }
    
    // 检查预期的头文件
    const expectedIncludes1 = ['WiFiNINA.h'];
    for (const expected of expectedIncludes1) {
        if (result1.includes.includes(expected)) {
            console.log(`✅ 包含了 ${expected}`);
        } else {
            console.log(`❌ 缺少 ${expected}`);
        }
    }
    console.log('');

    // 测试 ENABLE_ATTACHMENTS + SPIFFS
    console.log('测试2: ESP32 + ENABLE_ATTACHMENTS (SPIFFS)');
    const defines2 = new Map<string, MacroDefinition>([
        ['ESP32', { name: 'ESP32', value: '1', isDefined: true }],
        ['ARDUINO', { name: 'ARDUINO', value: '100', isDefined: true }],
        ['ENABLE_ATTACHMENTS', { name: 'ENABLE_ATTACHMENTS', value: '1', isDefined: true }]
    ]);
    
    const result2 = await analyzeFileWithDefines(testFilePath, defines2);
    console.log('包含的头文件:', result2.includes);
    console.log('新定义的宏:');
    for (const [name, def] of result2.defines) {
        if (defines2.has(name)) continue;
        console.log(`  ${name} = ${def.value}`);
    }
    
    // 检查预期的头文件
    const expectedIncludes2 = ['SPIFFS.h', 'SPI.h'];
    for (const expected of expectedIncludes2) {
        if (result2.includes.includes(expected)) {
            console.log(`✅ 包含了 ${expected}`);
        } else {
            console.log(`❌ 缺少 ${expected}`);
        }
    }
    console.log('');

    // 测试 MBED WiFi
    console.log('测试3: Arduino MBED + WiFi');
    const defines3 = new Map<string, MacroDefinition>([
        ['ARDUINO_ARCH_MBED', { name: 'ARDUINO_ARCH_MBED', value: '1', isDefined: true }],
        ['ARDUINO', { name: 'ARDUINO', value: '100', isDefined: true }]
    ]);
    
    const result3 = await analyzeFileWithDefines(testFilePath, defines3);
    console.log('包含的头文件:', result3.includes);
    console.log('新定义的宏:');
    for (const [name, def] of result3.defines) {
        if (defines3.has(name)) continue;
        console.log(`  ${name} = ${def.value}`);
    }
    
    const expectedIncludes3 = ['WiFi.h', 'WiFiSSLClient.h'];
    for (const expected of expectedIncludes3) {
        if (result3.includes.includes(expected)) {
            console.log(`✅ 包含了 ${expected}`);
        } else {
            console.log(`❌ 缺少 ${expected}`);
        }
    }
    console.log('');

    // 测试 W5100 以太网
    console.log('测试4: Arduino + W5100 以太网 (通过 EMAIL_NETWORK_TYPE)');
    const defines4 = new Map<string, MacroDefinition>([
        ['ARDUINO', { name: 'ARDUINO', value: '100', isDefined: true }],
        ['EMAIL_NETWORK_TYPE', { name: 'EMAIL_NETWORK_TYPE', value: '1', isDefined: true }], // NETWORK_W5100
        ['NETWORK_W5100', { name: 'NETWORK_W5100', value: '1', isDefined: true }]
    ]);
    
    const result4 = await analyzeFileWithDefines(testFilePath, defines4);
    console.log('包含的头文件:', result4.includes);
    
    const expectedIncludes4 = ['Ethernet.h', 'SPI.h'];
    for (const expected of expectedIncludes4) {
        if (result4.includes.includes(expected)) {
            console.log(`✅ 包含了 ${expected}`);
        } else {
            console.log(`❌ 缺少 ${expected}`);
        }
    }
    console.log('');

    // 测试 LITTLEFS on ESP32
    console.log('测试5: ESP32 + ENABLE_ATTACHMENTS + LITTLEFS');
    const defines5 = new Map<string, MacroDefinition>([
        ['ESP32', { name: 'ESP32', value: '1', isDefined: true }],
        ['ARDUINO', { name: 'ARDUINO', value: '100', isDefined: true }],
        ['ENABLE_ATTACHMENTS', { name: 'ENABLE_ATTACHMENTS', value: '1', isDefined: true }],
        ['ESP_ARDUINO_VERSION_MAJOR', { name: 'ESP_ARDUINO_VERSION_MAJOR', value: '2', isDefined: true }]
    ]);
    
    const result5 = await analyzeFileWithDefines(testFilePath, defines5);
    console.log('包含的头文件:', result5.includes);
    console.log('新定义的宏:');
    for (const [name, def] of result5.defines) {
        if (defines5.has(name)) continue;
        console.log(`  ${name} = ${def.value}`);
    }
    
    // 应该包含 FS.h 和 LittleFS.h
    const expectedIncludes5 = ['FS.h', 'LittleFS.h', 'SPI.h'];
    for (const expected of expectedIncludes5) {
        if (result5.includes.includes(expected)) {
            console.log(`✅ 包含了 ${expected}`);
        } else {
            console.log(`❌ 缺少 ${expected}`);
        }
    }
    console.log('');

    // 测试外部存储 SD
    console.log('测试6: ESP32 + ENABLE_ATTACHMENTS + 外部SD存储');
    const defines6 = new Map<string, MacroDefinition>([
        ['ESP32', { name: 'ESP32', value: '1', isDefined: true }],
        ['ARDUINO', { name: 'ARDUINO', value: '100', isDefined: true }],
        ['ENABLE_ATTACHMENTS', { name: 'ENABLE_ATTACHMENTS', value: '1', isDefined: true }]
    ]);
    
    const result6 = await analyzeFileWithDefines(testFilePath, defines6);
    console.log('包含的头文件:', result6.includes);
    console.log('新定义的宏:');
    for (const [name, def] of result6.defines) {
        if (defines6.has(name)) continue;
        console.log(`  ${name} = ${def.value}`);
    }
    
    // 应该包含 SD.h 或 SdFat.h
    const expectedIncludes6 = ['SPI.h'];
    for (const expected of expectedIncludes6) {
        if (result6.includes.includes(expected)) {
            console.log(`✅ 包含了 ${expected}`);
        } else {
            console.log(`❌ 缺少 ${expected}`);
        }
    }
    console.log('');
}

// 运行测试
(async () => {
    try {
        await testEMailSenderDetailed();
        console.log('\n✅ 所有详细测试完成');
    } catch (error) {
        console.error('❌ 测试失败:', error);
        process.exit(1);
    }
})();
