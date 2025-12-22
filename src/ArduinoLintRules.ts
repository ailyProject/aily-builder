/**
 * Arduino Lint Rules - 基于 ast-grep 的 Arduino 代码检查规则
 * 
 * 规则分类：
 * - syntax: 语法错误检查
 * - arduino: Arduino 特定规则
 * - memory: 内存相关警告
 * - performance: 性能优化建议
 * - style: 代码风格建议
 */

import { LintRule } from './AstGrepLinter';

/**
 * 语法错误规则
 */
export const SYNTAX_RULES: LintRule[] = [
  {
    id: 'missing-semicolon',
    severity: 'error',
    message: 'Missing semicolon at end of statement',
    // ast-grep 会在 ERROR 节点中捕获这类错误
    kind: 'ERROR'
  }
];

/**
 * Arduino 核心规则
 */
export const ARDUINO_CORE_RULES: LintRule[] = [
  // setup/loop 检查在代码中直接实现

  // delay() 使用警告
  {
    id: 'delay-blocking',
    severity: 'warning',
    message: 'delay() blocks execution. Consider using millis() for non-blocking timing.',
    pattern: 'delay($MS)',
  },
  
  // delayMicroseconds 在长时间使用时的警告
  {
    id: 'delay-microseconds-long',
    severity: 'note',
    message: 'For delays > 16383us, consider using delay() or millis() instead',
    pattern: 'delayMicroseconds($US)',
  },
  
  // analogWrite 范围检查
  {
    id: 'analog-write-range',
    severity: 'note',
    message: 'analogWrite() value should be 0-255',
    pattern: 'analogWrite($PIN, $VAL)',
  },
  
  // Serial 初始化
  {
    id: 'serial-begin-baud',
    severity: 'note',
    message: 'Common baud rates: 9600, 115200. Ensure Serial.begin() matches Serial Monitor.',
    pattern: 'Serial.begin($BAUD)',
  },
  
  // 中断函数注意事项
  {
    id: 'interrupt-caution',
    severity: 'note',
    message: 'Interrupt handlers should be short. Avoid delay(), Serial, or long operations.',
    pattern: 'attachInterrupt($$$)',
  },
  
  // noInterrupts/interrupts 配对
  {
    id: 'no-interrupts-warning',
    severity: 'warning',
    message: 'Remember to call interrupts() after noInterrupts() to re-enable interrupts.',
    pattern: 'noInterrupts()',
  }
];

/**
 * 内存相关规则
 */
export const MEMORY_RULES: LintRule[] = [
  // String 对象警告
  {
    id: 'string-fragmentation',
    severity: 'warning',
    message: 'String objects can cause memory fragmentation. Consider using char arrays for embedded systems.',
    pattern: 'String $VAR',
  },
  
  // String 拼接
  {
    id: 'string-concat',
    severity: 'note',
    message: 'String concatenation creates temporary objects. Consider using sprintf or direct char array manipulation.',
    pattern: '$STR + $OTHER',
  },
  
  // 动态内存分配
  {
    id: 'malloc-warning',
    severity: 'warning',
    message: 'Dynamic memory allocation is risky on embedded systems. Consider static allocation.',
    pattern: 'malloc($SIZE)',
  },
  {
    id: 'new-warning',
    severity: 'warning',
    message: 'Dynamic memory allocation is risky on embedded systems. Consider static allocation.',
    pattern: 'new $TYPE',
  },
  
  // 大数组警告
  {
    id: 'large-array',
    severity: 'note',
    message: 'Large arrays consume significant RAM. Consider using PROGMEM for constant data.',
    pattern: '$TYPE $ARR[$SIZE]',
  },
  
  // PROGMEM 使用提示
  {
    id: 'progmem-read',
    severity: 'note',
    message: 'Use pgm_read_byte/word to read PROGMEM data',
    pattern: 'PROGMEM',
  }
];

/**
 * 性能规则
 */
export const PERFORMANCE_RULES: LintRule[] = [
  // 循环中的浮点运算
  {
    id: 'float-in-loop',
    severity: 'note',
    message: 'Floating-point operations are slow on many Arduino boards. Consider using fixed-point math.',
    pattern: 'float $VAR',
    inside: {
      kind: 'for_statement'
    }
  },
  
  // 频繁的 digitalWrite
  {
    id: 'frequent-digital-write',
    severity: 'note',
    message: 'For faster I/O, consider direct port manipulation (PORTB, PORTD, etc.)',
    pattern: 'digitalWrite($$$)',
    inside: {
      kind: 'for_statement'
    }
  },
  
  // 使用 % 运算符
  {
    id: 'modulo-power-of-two',
    severity: 'note',
    message: 'For powers of 2, use bitwise AND (& (n-1)) instead of modulo (%) for better performance',
    pattern: '$VAR % $NUM',
  },
  
  // 除法操作
  {
    id: 'division-operation',
    severity: 'note',
    message: 'Division is slow. For powers of 2, use right shift (>>)',
    pattern: '$VAR / $NUM',
  }
];

/**
 * 代码风格规则
 */
export const STYLE_RULES: LintRule[] = [
  // 魔法数字
  {
    id: 'magic-number-pin',
    severity: 'note',
    message: 'Consider using a named constant for pin numbers (e.g., #define LED_PIN 13)',
    pattern: 'pinMode($NUM, $MODE)',
  },
  
  // 空的 setup 或 loop
  {
    id: 'empty-setup',
    severity: 'note',
    message: 'Empty setup() function - add initialization code or comment explaining why it\'s empty',
    pattern: 'void setup() { }',
  },
  {
    id: 'empty-loop',
    severity: 'note',
    message: 'Empty loop() function - this sketch does nothing continuously',
    pattern: 'void loop() { }',
  },
  
  // 过长的函数
  // 注：这个需要在代码中特殊处理，ast-grep 模式无法直接检测函数长度
  
  // 未使用的变量（简单检测）
  // 注：完整的未使用变量检测需要更复杂的数据流分析
];

/**
 * ESP32 特定规则
 */
export const ESP32_RULES: LintRule[] = [
  // WiFi 相关
  {
    id: 'esp32-wifi-begin',
    severity: 'note',
    message: 'Consider calling WiFi.mode() before WiFi.begin() on ESP32',
    pattern: 'WiFi.begin($$$)',
  },
  
  // FreeRTOS 任务
  {
    id: 'esp32-task-stack',
    severity: 'note',
    message: 'Ensure adequate stack size for xTaskCreate (min 2048 bytes recommended)',
    pattern: 'xTaskCreate($$$)',
  },
  
  // 多核使用
  {
    id: 'esp32-dual-core',
    severity: 'note',
    message: 'ESP32 has dual cores. Consider using xTaskCreatePinnedToCore for CPU affinity.',
    pattern: 'xTaskCreate($$$)',
  },
  
  // 看门狗
  {
    id: 'esp32-watchdog',
    severity: 'note',
    message: 'Long operations may trigger watchdog reset. Consider yield() or esp_task_wdt_reset().',
    pattern: 'while ($COND) { $$$BODY }',
  },
  
  // GPIO 中断
  {
    id: 'esp32-gpio-isr',
    severity: 'warning',
    message: 'Use IRAM_ATTR for interrupt service routines on ESP32 to ensure they run from RAM',
    pattern: 'attachInterrupt($$$)',
  }
];

/**
 * STM32 特定规则
 */
export const STM32_RULES: LintRule[] = [
  // HAL 初始化
  {
    id: 'stm32-hal-init',
    severity: 'note',
    message: 'Ensure HAL_Init() is called at the beginning of main()',
    pattern: 'HAL_$METHOD($$$)',
  },
  
  // 时钟配置
  {
    id: 'stm32-clock-config',
    severity: 'note',
    message: 'Remember to configure system clock (SystemClock_Config) before using peripherals',
    pattern: 'HAL_GPIO_$METHOD($$$)',
  }
];

/**
 * 所有规则集合
 */
export const ALL_RULES: LintRule[] = [
  ...SYNTAX_RULES,
  ...ARDUINO_CORE_RULES,
  ...MEMORY_RULES,
  ...PERFORMANCE_RULES,
  ...STYLE_RULES
];

/**
 * 规则集配置
 */
export interface RuleSetConfig {
  name: string;
  description: string;
  rules: LintRule[];
}

/**
 * 预定义规则集
 */
export const RULE_SETS: Record<string, RuleSetConfig> = {
  minimal: {
    name: 'Minimal',
    description: 'Only syntax errors and critical warnings',
    rules: [
      ...SYNTAX_RULES,
      ...ARDUINO_CORE_RULES.filter(r => r.severity === 'error' || r.id === 'delay-blocking')
    ]
  },
  
  standard: {
    name: 'Standard',
    description: 'Balanced set of rules for general use',
    rules: [
      ...SYNTAX_RULES,
      ...ARDUINO_CORE_RULES,
      ...MEMORY_RULES.filter(r => r.severity !== 'note')
    ]
  },
  
  strict: {
    name: 'Strict',
    description: 'All rules including style and performance hints',
    rules: ALL_RULES
  },
  
  esp32: {
    name: 'ESP32',
    description: 'Standard rules plus ESP32-specific checks',
    rules: [
      ...ALL_RULES,
      ...ESP32_RULES
    ]
  },
  
  stm32: {
    name: 'STM32',
    description: 'Standard rules plus STM32-specific checks',
    rules: [
      ...ALL_RULES,
      ...STM32_RULES
    ]
  }
};

/**
 * 根据名称获取规则集
 */
export function getRuleSet(name: keyof typeof RULE_SETS): LintRule[] {
  return RULE_SETS[name]?.rules || ALL_RULES;
}

/**
 * 创建自定义规则集
 */
export function createCustomRuleSet(
  baseRules: LintRule[],
  additionalRules?: LintRule[],
  excludeRuleIds?: string[]
): LintRule[] {
  let rules = [...baseRules];
  
  // 添加额外规则
  if (additionalRules) {
    rules = [...rules, ...additionalRules];
  }
  
  // 排除指定规则
  if (excludeRuleIds && excludeRuleIds.length > 0) {
    rules = rules.filter(r => !excludeRuleIds.includes(r.id));
  }
  
  return rules;
}
