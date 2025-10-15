import { analyzeFileWithDefines, MacroDefinition } from './src/utils/AnalyzeFile';
import path from 'path';

/**
 * 测试 EMailSender.h 文件的解析
 */
async function testEMailSenderHeader() {
    console.log('=== 测试 EMailSender.h 文件解析 ===\n');

    const testFilePath = 'c:\\Users\\coloz\\Desktop\\project_oct14f\\.temp\\libraries\\lib-emailsender\\EMailSender.h';
    
    console.log('测试文件:', testFilePath);
    console.log('');

    // 场景1: ESP32 平台
    console.log('场景1: ESP32 平台');
    const defines1 = new Map<string, MacroDefinition>([
        ['ESP32', { name: 'ESP32', value: '1', isDefined: true }],
        ['ARDUINO', { name: 'ARDUINO', value: '100', isDefined: true }]
    ]);
    
    try {
        const result1 = await analyzeFileWithDefines(testFilePath, defines1);
        console.log('包含的头文件数量:', result1.includes.length);
        console.log('包含的头文件:');
        result1.includes.forEach((inc, idx) => {
            console.log(`  ${idx + 1}. ${inc}`);
        });
        console.log('');
    } catch (error) {
        console.error('错误:', (error as Error).message);
        console.log('');
    }

    // 场景2: ESP8266 平台
    console.log('场景2: ESP8266 平台');
    const defines2 = new Map<string, MacroDefinition>([
        ['ESP8266', { name: 'ESP8266', value: '1', isDefined: true }],
        ['ARDUINO', { name: 'ARDUINO', value: '100', isDefined: true }]
    ]);
    
    try {
        const result2 = await analyzeFileWithDefines(testFilePath, defines2);
        console.log('包含的头文件数量:', result2.includes.length);
        console.log('包含的头文件:');
        result2.includes.forEach((inc, idx) => {
            console.log(`  ${idx + 1}. ${inc}`);
        });
        console.log('');
    } catch (error) {
        console.error('错误:', (error as Error).message);
        console.log('');
    }

    // 场景3: Arduino SAMD 平台
    console.log('场景3: Arduino SAMD 平台 (WiFiNINA)');
    const defines3 = new Map<string, MacroDefinition>([
        ['ARDUINO_ARCH_SAMD', { name: 'ARDUINO_ARCH_SAMD', value: '1', isDefined: true }],
        ['ARDUINO', { name: 'ARDUINO', value: '100', isDefined: true }]
    ]);
    
    try {
        const result3 = await analyzeFileWithDefines(testFilePath, defines3);
        console.log('包含的头文件数量:', result3.includes.length);
        console.log('包含的头文件:');
        result3.includes.forEach((inc, idx) => {
            console.log(`  ${idx + 1}. ${inc}`);
        });
        console.log('');
    } catch (error) {
        console.error('错误:', (error as Error).message);
        console.log('');
    }

    // 场景4: ESP32 + EMAIL_ENABLE_INTERNAL_SSLCLIENT
    console.log('场景4: ESP32 + EMAIL_ENABLE_INTERNAL_SSLCLIENT');
    const defines4 = new Map<string, MacroDefinition>([
        ['ESP32', { name: 'ESP32', value: '1', isDefined: true }],
        ['EMAIL_ENABLE_INTERNAL_SSLCLIENT', { name: 'EMAIL_ENABLE_INTERNAL_SSLCLIENT', value: '1', isDefined: true }],
        ['ARDUINO', { name: 'ARDUINO', value: '100', isDefined: true }]
    ]);
    
    try {
        const result4 = await analyzeFileWithDefines(testFilePath, defines4);
        console.log('包含的头文件数量:', result4.includes.length);
        console.log('包含的头文件:');
        result4.includes.forEach((inc, idx) => {
            console.log(`  ${idx + 1}. ${inc}`);
        });
        console.log('');
        
        // 检查是否包含 sslclient/SSLClient.h
        if (result4.includes.includes('sslclient/SSLClient.h')) {
            console.log('✅ 正确包含了 sslclient/SSLClient.h');
        } else {
            console.log('❌ 未包含 sslclient/SSLClient.h');
        }
        console.log('');
    } catch (error) {
        console.error('错误:', (error as Error).message);
        console.log('');
    }

    // 场景5: ESP32 + ENABLE_ATTACHMENTS + STORAGE_SPIFFS
    console.log('场景5: ESP32 + ENABLE_ATTACHMENTS + 内部存储');
    const defines5 = new Map<string, MacroDefinition>([
        ['ESP32', { name: 'ESP32', value: '1', isDefined: true }],
        ['ARDUINO', { name: 'ARDUINO', value: '100', isDefined: true }],
        ['ENABLE_ATTACHMENTS', { name: 'ENABLE_ATTACHMENTS', value: '1', isDefined: true }],
        ['INTERNAL_STORAGE', { name: 'INTERNAL_STORAGE', value: '1', isDefined: true }],
        ['STORAGE_SPIFFS', { name: 'STORAGE_SPIFFS', value: '1', isDefined: true }]
    ]);
    
    try {
        const result5 = await analyzeFileWithDefines(testFilePath, defines5);
        console.log('包含的头文件数量:', result5.includes.length);
        console.log('包含的头文件:');
        result5.includes.forEach((inc, idx) => {
            console.log(`  ${idx + 1}. ${inc}`);
        });
        console.log('');
    } catch (error) {
        console.error('错误:', (error as Error).message);
        console.log('');
    }
}

// 运行测试
(async () => {
    try {
        await testEMailSenderHeader();
        console.log('\n✅ 测试完成');
    } catch (error) {
        console.error('❌ 测试失败:', error);
        process.exit(1);
    }
})();
