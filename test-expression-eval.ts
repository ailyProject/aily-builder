import { MacroDefinition } from './src/utils/AnalyzeFile';

/**
 * 复制表达式评估器的逻辑进行调试
 */
function testExpressionEvaluation() {
    console.log('=== 测试表达式评估逻辑 ===\n');

    // 模拟宏定义
    const defines = new Map<string, string | number>([
        ['EMAIL_NETWORK_TYPE', 'NETWORK_ESP32'],
        ['NETWORK_ESP8266', '1'],
        ['NETWORK_ESP32', '1'],
        ['NETWORK_ESP32_ETH', '1']
    ]);

    console.log('定义的宏:');
    for (const [key, value] of defines) {
        console.log(`  ${key} = ${value}`);
    }
    console.log('');

    // 测试条件表达式
    const conditions = [
        'EMAIL_NETWORK_TYPE == NETWORK_ESP8266',
        'EMAIL_NETWORK_TYPE == NETWORK_ESP32',
        'EMAIL_NETWORK_TYPE == NETWORK_ESP32_ETH'
    ];

    for (const condition of conditions) {
        console.log(`\n测试条件: ${condition}`);
        
        // 步骤1: 处理 defined()
        let processed = condition;
        console.log(`  1. 原始: ${processed}`);
        
        // 步骤2: 替换宏
        const macroRegex = /\b([A-Za-z_][A-Za-z0-9_]*)\b/g;
        const replacedMacros = new Set<string>();
        
        for (let i = 0; i < 10; i++) {
            let changed = false;
            processed = processed.replace(macroRegex, (match) => {
                if (replacedMacros.has(match)) {
                    return match;
                }
                
                if (defines.has(match)) {
                    const value = defines.get(match);
                    const stringValue = String(value);
                    if (stringValue !== match) {
                        changed = true;
                        replacedMacros.add(match);
                        console.log(`     替换: ${match} -> ${stringValue}`);
                        return stringValue;
                    }
                }
                // 未定义的标识符替换为0
                if (!/^\d+$/.test(match)) {
                    console.log(`     未定义: ${match} -> 0`);
                    return '0';
                }
                return match;
            });
            
            if (!changed) break;
        }
        
        console.log(`  2. 宏替换后: ${processed}`);
        
        // 步骤3: 处理运算符
        processed = processed
            .replace(/==/g, '===')
            .replace(/!=/g, '!==')
            .replace(/&&/g, '&&')
            .replace(/\|\|/g, '||')
            .replace(/&/g, '&&')
            .replace(/\|/g, '||')
            .replace(/~/g, '!');
        
        console.log(`  3. 运算符处理后: ${processed}`);
        
        // 步骤4: 评估
        try {
            const result = new Function('return (' + processed + ')')();
            console.log(`  4. 评估结果: ${result} (布尔值: ${result !== 0 && result !== false})`);
        } catch (e) {
            console.log(`  4. 评估失败: ${(e as Error).message}`);
        }
    }
}

testExpressionEvaluation();
