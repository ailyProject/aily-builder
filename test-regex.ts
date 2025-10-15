const testCases = [
    '#if(EMAIL_NETWORK_TYPE == NETWORK_ESP8266)',
    '#if (EMAIL_NETWORK_TYPE == NETWORK_ESP8266)',
    '#elif(EMAIL_NETWORK_TYPE == NETWORK_ESP32)',
    '#elif (EMAIL_NETWORK_TYPE == NETWORK_ESP32)',
];

const regex = /#(?:el)?if\s+(.+?)(?:\/\/|\/\*|$)/;

console.log('测试 extractCondition 的正则表达式:\n');

for (const testCase of testCases) {
    const match = testCase.match(regex);
    console.log(`测试: ${testCase}`);
    console.log(`匹配: ${match ? 'YES' : 'NO'}`);
    if (match) {
        console.log(`提取的条件: "${match[1].trim()}"`);
    }
    console.log('');
}
