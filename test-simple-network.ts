import { analyzeFileWithDefines, MacroDefinition } from './src/utils/AnalyzeFile';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * 测试简化的网络类型检查
 */
async function testSimpleNetworkType() {
    console.log('=== 测试简化的网络类型检查 ===\n');

    const testFilePath = path.join(__dirname, 'test-network-type.cpp');
    const testContent = `
#define EMAIL_NETWORK_TYPE 8
#define NETWORK_ESP32 8

#if(EMAIL_NETWORK_TYPE == NETWORK_ESP32)
    #include <WiFi.h>
    #include <WiFiClientSecure.h>
#endif
`;

    await fs.writeFile(testFilePath, testContent, 'utf8');

    const defines = new Map<string, MacroDefinition>();

    process.env.DEBUG_EXPR = '1';
    const result = await analyzeFileWithDefines(testFilePath, defines);
    
    console.log('包含的头文件:', result.includes);
    
    if (result.includes.includes('WiFi.h') && result.includes.includes('WiFiClientSecure.h')) {
        console.log('✅ 网络类型检查正常');
    } else {
        console.log('❌ 网络类型检查失败');
    }

    await fs.unlink(testFilePath);
}

(async () => {
    await testSimpleNetworkType();
})();
