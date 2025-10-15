import { analyzeFileWithDefines, MacroDefinition } from './src/utils/AnalyzeFile';

/**
 * 测试 ESP32 平台的 EMailSender.h - 带完整的常量定义
 */
async function testESP32WithConstants() {
    console.log('=== 测试 ESP32 (带完整常量定义) ===\n');

    const testFilePath = 'c:\\Users\\coloz\\Desktop\\project_oct14f\\.temp\\libraries\\lib-emailsender\\EMailSender.h';

    // ESP32 平台的完整宏定义（包括来自 EMailSenderKey.h 的常量）
    const defines = new Map<string, MacroDefinition>([
        ['ESP32', { name: 'ESP32', value: '1', isDefined: true }],
        ['ARDUINO', { name: 'ARDUINO', value: '10607', isDefined: true }],
        
        // 网络类型常量（通常在 EMailSenderKey.h 中定义）
        ['NETWORK_ESP8266_ASYNC', { name: 'NETWORK_ESP8266_ASYNC', value: '0', isDefined: true }],
        ['NETWORK_ESP8266', { name: 'NETWORK_ESP8266', value: '1', isDefined: true }],
        ['NETWORK_ESP8266_242', { name: 'NETWORK_ESP8266_242', value: '2', isDefined: true }],
        ['NETWORK_W5100', { name: 'NETWORK_W5100', value: '3', isDefined: true }],
        ['NETWORK_ETHERNET_ENC', { name: 'NETWORK_ETHERNET_ENC', value: '4', isDefined: true }],
        ['NETWORK_ETHERNET_GENERIC', { name: 'NETWORK_ETHERNET_GENERIC', value: '5', isDefined: true }],
        ['NETWORK_ENC28J60', { name: 'NETWORK_ENC28J60', value: '6', isDefined: true }],
        ['NETWORK_UIPETHERNET', { name: 'NETWORK_UIPETHERNET', value: '7', isDefined: true }],
        ['NETWORK_ESP32', { name: 'NETWORK_ESP32', value: '8', isDefined: true }],
        ['NETWORK_ESP32_ETH', { name: 'NETWORK_ESP32_ETH', value: '9', isDefined: true }],
        ['NETWORK_ETHERNET_LARGE', { name: 'NETWORK_ETHERNET_LARGE', value: '10', isDefined: true }],
        ['NETWORK_ETHERNET_2', { name: 'NETWORK_ETHERNET_2', value: '11', isDefined: true }],
        ['NETWORK_ETHERNET_STM', { name: 'NETWORK_ETHERNET_STM', value: '12', isDefined: true }],
        ['NETWORK_WiFiNINA', { name: 'NETWORK_WiFiNINA', value: '13', isDefined: true }],
        ['NETWORK_MBED_WIFI', { name: 'NETWORK_MBED_WIFI', value: '14', isDefined: true }],
        
        // 默认网络类型（对应不同平台）
        ['DEFAULT_EMAIL_NETWORK_TYPE_ESP8266', { name: 'DEFAULT_EMAIL_NETWORK_TYPE_ESP8266', value: '1', isDefined: true }],
        ['DEFAULT_EMAIL_NETWORK_TYPE_ESP32', { name: 'DEFAULT_EMAIL_NETWORK_TYPE_ESP32', value: '8', isDefined: true }],
        ['DEFAULT_EMAIL_NETWORK_TYPE_STM32', { name: 'DEFAULT_EMAIL_NETWORK_TYPE_STM32', value: '3', isDefined: true }],
        ['DEFAULT_EMAIL_NETWORK_TYPE_RP2040', { name: 'DEFAULT_EMAIL_NETWORK_TYPE_RP2040', value: '13', isDefined: true }],
        ['DEFAULT_EMAIL_NETWORK_TYPE_SAMD', { name: 'DEFAULT_EMAIL_NETWORK_TYPE_SAMD', value: '13', isDefined: true }],
        ['DEFAULT_EMAIL_NETWORK_TYPE_MBED', { name: 'DEFAULT_EMAIL_NETWORK_TYPE_MBED', value: '14', isDefined: true }],
        ['DEFAULT_EMAIL_NETWORK_TYPE_ARDUINO', { name: 'DEFAULT_EMAIL_NETWORK_TYPE_ARDUINO', value: '3', isDefined: true }],
        
        // 存储类型常量
        ['STORAGE_NONE', { name: 'STORAGE_NONE', value: '0', isDefined: true }],
        ['STORAGE_SPIFFS', { name: 'STORAGE_SPIFFS', value: '1', isDefined: true }],
        ['STORAGE_LITTLEFS', { name: 'STORAGE_LITTLEFS', value: '2', isDefined: true }],
        ['STORAGE_FFAT', { name: 'STORAGE_FFAT', value: '3', isDefined: true }],
        ['STORAGE_SD', { name: 'STORAGE_SD', value: '4', isDefined: true }],
        ['STORAGE_SPIFM', { name: 'STORAGE_SPIFM', value: '5', isDefined: true }],
        ['STORAGE_SDFAT2', { name: 'STORAGE_SDFAT2', value: '6', isDefined: true }],
        ['STORAGE_SDFAT_RP2040_ESP8266', { name: 'STORAGE_SDFAT_RP2040_ESP8266', value: '7', isDefined: true }],
        
        // 默认存储类型
        ['DEFAULT_INTERNAL_ESP32_STORAGE', { name: 'DEFAULT_INTERNAL_ESP32_STORAGE', value: '1', isDefined: true }],
        ['DEFAULT_EXTERNAL_ESP32_STORAGE', { name: 'DEFAULT_EXTERNAL_ESP32_STORAGE', value: '4', isDefined: true }],
    ]);

    console.log('定义的宏数量:', defines.size);
    console.log('');

    // 启用调试输出
    process.env.DEBUG_EXPR = '1';
    
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
        'WiFiClientSecure.h',
        'SPIFFS.h'
    ];

    console.log('验证关键头文件:');
    for (const expected of expectedIncludes) {
        if (result.includes.includes(expected)) {
            console.log(`  ✅ ${expected}`);
        } else {
            console.log(`  ❌ 缺少 ${expected}`);
        }
    }
}

// 运行测试
(async () => {
    try {
        await testESP32WithConstants();
        console.log('\n✅ 测试完成');
    } catch (error) {
        console.error('❌ 测试失败:', error);
        process.exit(1);
    }
})();
