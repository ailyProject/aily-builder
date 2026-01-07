/**
 * AstGrepLinter - 基于 ast-grep 的高性能 Arduino 代码检查器
 * 
 * 使用 ast-grep 的 NAPI 绑定进行 AST 级别的代码分析，
 * 相比基于正则的文本分析更准确、更快速。
 * 
 * @author aily-builder
 */

import { Logger } from './utils/Logger';

// ast-grep NAPI 类型定义
// 需要安装: npm install @ast-grep/napi @ast-grep/lang-cpp

// 延迟加载模块
let astGrepNapi: typeof import('@ast-grep/napi') | null = null;
let cppLang: any = null;
let cppRegistered = false;

/**
 * 初始化 ast-grep 和 C++ 语言支持
 */
async function initAstGrep() {
  if (!astGrepNapi) {
    try {
      astGrepNapi = await import('@ast-grep/napi');
    } catch (error) {
      throw new Error('ast-grep/napi not installed. Run: npm install @ast-grep/napi');
    }
  }
  
  // 注册 C++ 语言
  if (!cppRegistered) {
    try {
      const cppModule = await import('@ast-grep/lang-cpp');
      cppLang = cppModule.default || cppModule;
      
      // 注册动态语言
      astGrepNapi.registerDynamicLanguage({ cpp: cppLang });
      cppRegistered = true;
    } catch (error) {
      throw new Error('ast-grep C++ language not installed. Run: npm install @ast-grep/lang-cpp');
    }
  }
  
  return astGrepNapi;
}

/**
 * 解析 C++ 代码
 */
async function parseCpp(code: string) {
  const sg = await initAstGrep();
  return sg.parse('cpp' as any, code);
}

export interface LintError {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  message: string;
  severity: 'error' | 'warning' | 'note';
  code?: string;
  fix?: {
    range: [number, number];
    text: string;
  };
}

export interface AstGrepLintResult {
  success: boolean;
  errors: LintError[];
  warnings: LintError[];
  notes: LintError[];
  executionTime: number;
}

/**
 * 规则配置接口
 */
export interface LintRule {
  id: string;
  severity: 'error' | 'warning' | 'note';
  message: string;
  pattern?: string;
  kind?: string;
  has?: object;
  inside?: object;
  not?: object;
  all?: object[];
  any?: object[];
  fix?: string;
}

/**
 * Arduino 特定的 lint 规则集
 */
const ARDUINO_RULES: LintRule[] = [
  // === 错误级别规则 ===
  
  // 检测未闭合的括号 - 通过检查语法错误节点
  {
    id: 'syntax-error',
    severity: 'error',
    message: 'Syntax error detected',
    kind: 'ERROR'
  },
  
  // 注意：空函数体检测移除，因为 Arduino 的 setup() 和 loop() 经常为空
  // 且很难用简单的 pattern 排除它们
  
  // === 警告级别规则 ===
  
  // 检测 delay() 在循环中的使用（可能阻塞）
  {
    id: 'delay-in-loop',
    severity: 'warning',
    message: 'Using delay() in loop() may block other operations. Consider using millis() for non-blocking delays.',
    pattern: 'delay($MS)',
    inside: {
      kind: 'function_definition',
      has: {
        kind: 'function_declarator',
        pattern: 'loop'
      }
    }
  },
  
  // 检测可能的整数溢出：大数值赋值给小类型
  {
    id: 'potential-overflow',
    severity: 'warning',
    message: 'Potential integer overflow: consider using a larger type',
    pattern: 'byte $VAR = $NUM',
  },
  
  // 注意：Serial.begin() 检测改为在 checkArduinoSpecific 中动态处理
  // 以便能够准确判断 Serial.begin() 是否已在 setup() 中调用
  
  // 检测 digitalWrite/digitalRead 使用硬编码引脚号
  {
    id: 'hardcoded-pin',
    severity: 'note',
    message: 'Consider using a named constant for pin numbers',
    pattern: 'digitalWrite($NUM, $VAL)',
  },
  
  // === 建议级别规则 ===
  
  // 检测 String 类对象（在嵌入式环境中可能导致内存碎片）
  {
    id: 'string-object-warning',
    severity: 'note',
    message: 'String objects can cause memory fragmentation on embedded systems. Consider using char arrays.',
    pattern: 'String $VAR',
  },
  
  // 检测全局变量声明（提示注意内存使用）
  {
    id: 'global-variable',
    severity: 'note',
    message: 'Global variable declared - be mindful of RAM usage on embedded systems',
    kind: 'declaration',
    not: {
      inside: {
        kind: 'function_definition'
      }
    }
  }
];

/**
 * 基于 ast-grep 的 Arduino 代码检查器
 */
export class AstGrepLinter {
  private logger: Logger;
  private rules: LintRule[];
  private initialized: boolean = false;

  constructor(logger: Logger, customRules?: LintRule[]) {
    this.logger = logger;
    this.rules = customRules ? [...ARDUINO_RULES, ...customRules] : ARDUINO_RULES;
  }

  /**
   * 初始化 ast-grep（延迟加载）
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await initAstGrep();
      this.initialized = true;
    }
  }

  /**
   * 分析单个文件
   */
  async analyzeFile(filePath: string, content: string): Promise<AstGrepLintResult> {
    const startTime = Date.now();
    
    try {
      await this.ensureInitialized();
      
      // 解析为 AST（使用 C++ 语言解析 Arduino 代码）
      const ast = await parseCpp(content);
      const root = ast.root();
      
      const errors: LintError[] = [];
      const warnings: LintError[] = [];
      const notes: LintError[] = [];
      
      // 1. 检查语法错误节点（ERROR kind）
      this.checkSyntaxErrors(root, filePath, errors);
      
      // 2. 应用规则检查
      for (const rule of this.rules) {
        if (rule.kind === 'ERROR') continue; // 已在上面处理
        
        const matches = this.findMatches(root, rule);
        
        for (const match of matches) {
          const range = match.range();
          const diagnostic: LintError = {
            file: filePath,
            line: range.start.line + 1, // ast-grep 是 0-based
            column: range.start.column + 1,
            endLine: range.end.line + 1,
            endColumn: range.end.column + 1,
            message: this.formatMessage(rule.message, match),
            severity: rule.severity,
            code: rule.id
          };
          
          // 添加自动修复建议（如果规则定义了 fix）
          if (rule.fix) {
            diagnostic.fix = {
              range: [range.start.index, range.end.index],
              text: this.formatMessage(rule.fix, match)
            };
          }
          
          switch (rule.severity) {
            case 'error':
              errors.push(diagnostic);
              break;
            case 'warning':
              warnings.push(diagnostic);
              break;
            case 'note':
              notes.push(diagnostic);
              break;
          }
        }
      }
      
      // 3. Arduino 特定检查
      this.checkArduinoSpecific(root, filePath, warnings, notes);
      
      // 4. 未定义变量检查（错误级别）- 传入源代码以便提取库前缀
      this.checkUndefinedVariables(root, filePath, errors, content);
      
      // 5. 去重
      const uniqueErrors = this.deduplicateDiagnostics(errors);
      const uniqueWarnings = this.deduplicateDiagnostics(warnings);
      const uniqueNotes = this.deduplicateDiagnostics(notes);
      
      return {
        success: uniqueErrors.length === 0,
        errors: uniqueErrors,
        warnings: uniqueWarnings,
        notes: uniqueNotes,
        executionTime: Date.now() - startTime
      };
      
    } catch (error) {
      this.logger.error(`AST analysis failed: ${error instanceof Error ? error.message : error}`);
      
      return {
        success: false,
        errors: [{
          file: filePath,
          line: 1,
          column: 1,
          message: `AST analysis failed: ${error instanceof Error ? error.message : error}`,
          severity: 'error',
          code: 'AST_ERROR'
        }],
        warnings: [],
        notes: [],
        executionTime: Date.now() - startTime
      };
    }
  }

  /**
   * 检查语法错误节点
   */
  private checkSyntaxErrors(root: any, filePath: string, errors: LintError[]): void {
    // 查找所有 ERROR 类型的节点 - 需要使用 rule 包装
    const errorNodes = root.findAll({ rule: { kind: 'ERROR' } });
    
    for (const node of errorNodes) {
      const range = node.range();
      const text = node.text();
      
      errors.push({
        file: filePath,
        line: range.start.line + 1,
        column: range.start.column + 1,
        endLine: range.end.line + 1,
        endColumn: range.end.column + 1,
        message: this.inferSyntaxError(text, node),
        severity: 'error',
        code: 'SYNTAX_ERROR'
      });
    }
  }

  /**
   * 推断语法错误类型
   */
  private inferSyntaxError(text: string, node: any): string {
    // 尝试推断具体的语法错误类型
    if (text.includes('{') && !text.includes('}')) {
      return 'Missing closing brace "}"';
    }
    if (text.includes('(') && !text.includes(')')) {
      return 'Missing closing parenthesis ")"';
    }
    if (text.includes('[') && !text.includes(']')) {
      return 'Missing closing bracket "]"';
    }
    if (!text.endsWith(';') && !text.endsWith('{') && !text.endsWith('}')) {
      return 'Possible missing semicolon ";"';
    }
    
    // 检查上下文
    const parent = node.parent();
    if (parent) {
      const parentKind = parent.kind();
      if (parentKind === 'function_definition') {
        return 'Syntax error in function definition';
      }
      if (parentKind === 'if_statement') {
        return 'Syntax error in if statement';
      }
      if (parentKind === 'for_statement') {
        return 'Syntax error in for loop';
      }
    }
    
    return `Syntax error near: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`;
  }

  /**
   * 查找匹配规则的节点
   */
  private findMatches(root: any, rule: LintRule): any[] {
    try {
      if (rule.pattern) {
        // 使用模式匹配
        const config: any = {
          rule: {
            pattern: rule.pattern
          }
        };
        
        // 添加额外约束
        if (rule.inside) {
          config.rule.inside = rule.inside;
        }
        if (rule.has) {
          config.rule.has = rule.has;
        }
        if (rule.not) {
          config.rule.not = rule.not;
        }
        
        return root.findAll(config);
      } else if (rule.kind) {
        // 使用 kind 匹配 - 需要包装在 rule 对象中
        return root.findAll({ rule: { kind: rule.kind } });
      } else if (rule.all || rule.any) {
        // 组合规则
        const config: any = { rule: {} };
        if (rule.all) config.rule.all = rule.all;
        if (rule.any) config.rule.any = rule.any;
        return root.findAll(config);
      }
      
      return [];
    } catch (error) {
      this.logger.debug(`Rule ${rule.id} matching failed: ${error}`);
      return [];
    }
  }

  /**
   * 格式化消息（替换变量）
   */
  private formatMessage(template: string, node: any): string {
    let result = template;
    
    // 替换 $VAR, $FUNC 等模式变量
    const varPattern = /\$(\w+)/g;
    let match;
    
    while ((match = varPattern.exec(template)) !== null) {
      const varName = match[1];
      const matchedNode = node.getMatch(varName);
      if (matchedNode) {
        result = result.replace(match[0], matchedNode.text());
      }
    }
    
    return result;
  }

  /**
   * Arduino 特定检查
   */
  private checkArduinoSpecific(root: any, filePath: string, warnings: LintError[], notes: LintError[]): void {
    // 检查是否有 setup() 函数 - 使用嵌套 has 规则
    const setupFunc = root.find({
      rule: {
        kind: 'function_definition',
        has: {
          kind: 'function_declarator',
          has: {
            kind: 'identifier',
            regex: '^setup$'
          }
        }
      }
    });
    
    if (!setupFunc) {
      warnings.push({
        file: filePath,
        line: 1,
        column: 1,
        message: 'Missing required setup() function',
        severity: 'warning',
        code: 'MISSING_SETUP'
      });
    }
    
    // 检查是否有 loop() 函数
    const loopFunc = root.find({
      rule: {
        kind: 'function_definition',
        has: {
          kind: 'function_declarator',
          has: {
            kind: 'identifier',
            regex: '^loop$'
          }
        }
      }
    });
    
    if (!loopFunc) {
      warnings.push({
        file: filePath,
        line: 1,
        column: 1,
        message: 'Missing required loop() function',
        severity: 'warning',
        code: 'MISSING_LOOP'
      });
    }
    
    // 检查 Serial.begin() 是否在 setup() 中调用
    this.checkSerialBegin(root, filePath, warnings);
    
    // 检查 pinMode 使用
    this.checkPinModeUsage(root, filePath, notes);
  }

  /**
   * 检查 Serial.begin() 是否正确调用
   */
  private checkSerialBegin(root: any, filePath: string, warnings: LintError[]): void {
    // 检查是否有 Serial 使用
    const serialCalls = root.findAll({ rule: { kind: 'call_expression', pattern: 'Serial.$METHOD($$$)' } });
    if (serialCalls.length === 0) {
      return; // 没有使用 Serial，不需要检查
    }
    
    // 检查 setup() 中是否有 Serial.begin()
    const setupFunc = root.find({
      rule: {
        kind: 'function_definition',
        has: {
          kind: 'function_declarator',
          has: { kind: 'identifier', regex: '^setup$' }
        }
      }
    });
    
    if (!setupFunc) {
      // 没有 setup 函数，已经在其他地方警告了
      return;
    }
    
    // 在 setup 函数体内查找 Serial.begin
    const serialBeginInSetup = setupFunc.find({
      rule: { pattern: 'Serial.begin($$$)' }
    });
    
    if (!serialBeginInSetup) {
      // setup() 中没有 Serial.begin()，警告所有 Serial 使用
      // 只警告一次
      warnings.push({
        file: filePath,
        line: 1,
        column: 1,
        message: 'Serial functions used but Serial.begin() not found in setup()',
        severity: 'warning',
        code: 'SERIAL_NO_BEGIN'
      });
    }
    // 如果 Serial.begin() 存在，不需要任何警告
  }

  /**
   * 从代码中提取 #include 的库，并生成对应的符号前缀模式
   * 这样可以自动识别库中定义的符号，避免误报
   */
  private extractLibraryPrefixes(content: string): string[] {
    const prefixes: string[] = [];
    
    // 库名到符号前缀的映射规则
    // 格式: 库名(不区分大小写) -> 符号前缀数组
    const libraryPrefixMap: Record<string, string[]> = {
      // 显示库
      'u8g2lib': ['u8g2_', 'u8x8_', 'U8G2_', 'U8X8_'],
      'u8g2': ['u8g2_', 'u8x8_', 'U8G2_', 'U8X8_'],
      'u8x8lib': ['u8x8_', 'U8X8_'],
      'adafruit_gfx': ['GFX', 'Adafruit_'],
      'adafruit_ssd1306': ['SSD1306_', 'Adafruit_'],
      'tft_espi': ['TFT_', 'tft_'],
      'lvgl': ['lv_', 'LV_'],
      'lv_conf': ['lv_', 'LV_'],
      
      // 传感器库
      'dht': ['DHT', 'dht_'],
      'adafruit_dht': ['DHT'],
      'adafruit_bme280': ['BME280_', 'Adafruit_'],
      'adafruit_bmp280': ['BMP280_', 'Adafruit_'],
      
      // 通信库
      'wifi': ['WIFI_', 'WiFi'],
      'wificlient': ['WiFi'],
      'wifiserver': ['WiFi'],
      'esp8266wifi': ['WiFi', 'ESP8266'],
      'esp32wifi': ['WiFi'],
      'pubsubclient': ['MQTT_', 'PubSub'],
      'arduinojson': ['JSON_', 'Json'],
      'httpclient': ['HTTP_'],
      'esp_http_client': ['esp_http_', 'ESP_HTTP_'],
      'websocketsclient': ['WebSocket'],
      
      // 存储库
      'sd': ['SD_', 'File'],
      'spiffs': ['SPIFFS_'],
      'littlefs': ['LittleFS_'],
      'preferences': ['Preferences'],
      'eeprom': ['EEPROM_'],
      
      // 电机/舵机库
      'servo': ['Servo'],
      'esp32servo': ['Servo'],
      'stepper': ['Stepper'],
      'accelstepper': ['AccelStepper'],
      
      // LED库
      'adafruit_neopixel': ['NEO_', 'Adafruit_'],
      'fastled': ['CRGB', 'CHSV', 'FastLED', 'FASTLED_'],
      
      // FreeRTOS
      'freertos': ['pdTRUE', 'pdFALSE', 'pdPASS', 'pdFAIL', 'portMAX_DELAY', 
                   'xTask', 'vTask', 'xQueue', 'xSemaphore', 'xMutex', 'xTimer',
                   'portTICK_', 'configMAX_', 'task', 'queue'],
      
      // ESP-IDF
      'esp_system': ['esp_', 'ESP_'],
      'esp_wifi': ['esp_wifi_', 'WIFI_', 'wifi_'],
      'esp_event': ['esp_event_', 'ESP_EVENT_'],
      'esp_log': ['ESP_LOG', 'esp_log_'],
      'driver/gpio': ['gpio_', 'GPIO_'],
      'driver/i2c': ['i2c_', 'I2C_'],
      'driver/spi': ['spi_', 'SPI_'],
      'driver/uart': ['uart_', 'UART_'],
      'driver/ledc': ['ledc_', 'LEDC_'],
      'driver/adc': ['adc_', 'ADC_'],
      'driver/dac': ['dac_', 'DAC_'],
      'driver/timer': ['timer_', 'TIMER_'],
      'driver/pcnt': ['pcnt_', 'PCNT_'],
      'driver/mcpwm': ['mcpwm_', 'MCPWM_'],
      'nvs_flash': ['nvs_', 'NVS_'],
      'nvs': ['nvs_', 'NVS_'],
    };
    
    // 提取所有 #include 指令
    const includeRegex = /#include\s*[<"]([^>"]+)[>"]/g;
    let match;
    
    while ((match = includeRegex.exec(content)) !== null) {
      const includePath = match[1];
      
      // 提取库名（去除路径和扩展名）
      const libName = includePath
        .replace(/.*\//, '')      // 去除路径
        .replace(/\.[^.]+$/, '')  // 去除扩展名
        .toLowerCase();
      
      // 查找匹配的前缀
      if (libraryPrefixMap[libName]) {
        prefixes.push(...libraryPrefixMap[libName]);
      }
      
      // 对于未知库，尝试从库名推断前缀
      // 例如: MyLib.h -> MyLib_, mylib_
      if (!libraryPrefixMap[libName]) {
        const baseName = includePath
          .replace(/.*\//, '')
          .replace(/\.[^.]+$/, '');
        
        // 添加常见的命名模式
        if (baseName.length > 2) {
          prefixes.push(baseName + '_');           // MyLib_
          prefixes.push(baseName.toUpperCase() + '_'); // MYLIB_
          prefixes.push(baseName.toLowerCase() + '_'); // mylib_
        }
      }
    }
    
    // 去重
    return [...new Set(prefixes)];
  }

  /**
   * 检查符号是否匹配任意库前缀
   */
  private isLibrarySymbol(name: string, libraryPrefixes: string[]): boolean {
    for (const prefix of libraryPrefixes) {
      if (name.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 检查未定义变量
   * 通过收集声明和使用来检测可能未定义的变量
   * 未定义变量是错误级别，会导致编译失败
   */
  private checkUndefinedVariables(root: any, filePath: string, errors: LintError[], sourceContent?: string): void {
    // Arduino/C++ 内置标识符和常用库函数
    const builtins = new Set([
      // Arduino 核心
      'HIGH', 'LOW', 'INPUT', 'OUTPUT', 'INPUT_PULLUP', 'INPUT_PULLDOWN',
      'LED_BUILTIN', 'LED_BUILTIN_RX', 'LED_BUILTIN_TX',
      'A0', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7',
      'true', 'false', 'NULL', 'nullptr',
      // Arduino 函数
      'pinMode', 'digitalWrite', 'digitalRead', 'analogRead', 'analogWrite',
      'delay', 'delayMicroseconds', 'millis', 'micros',
      'Serial', 'Serial1', 'Serial2', 'Serial3',
      'Wire', 'SPI', 'WiFi', 'Ethernet',
      'setup', 'loop', 'main',
      'attachInterrupt', 'detachInterrupt', 'interrupts', 'noInterrupts',
      'tone', 'noTone', 'pulseIn', 'pulseInLong',
      'shiftIn', 'shiftOut',
      'map', 'constrain', 'min', 'max', 'abs', 'pow', 'sqrt', 'sq',
      'sin', 'cos', 'tan', 'random', 'randomSeed',
      'bitRead', 'bitWrite', 'bitSet', 'bitClear', 'bit',
      'lowByte', 'highByte', 'word',
      'sizeof', 'typeof',
      // math.h 函数（Arduino.h 已包含）
      'isnan', 'isinf', 'isfinite', 'fpclassify',
      'floor', 'ceil', 'round', 'trunc', 'fabs', 'fmod',
      'exp', 'log', 'log10', 'log2',
      'asin', 'acos', 'atan', 'atan2',
      'sinh', 'cosh', 'tanh',
      'ldexp', 'frexp', 'modf', 'fmin', 'fmax',
      'copysign', 'nan', 'signbit', 'hypot',
      // C/C++ 标准
      'printf', 'sprintf', 'snprintf', 'scanf', 'sscanf',
      'malloc', 'free', 'realloc', 'calloc',
      'memcpy', 'memset', 'memmove', 'memcmp',
      'strlen', 'strcpy', 'strcat', 'strcmp', 'strncpy', 'strncmp',
      // 类型
      'int', 'float', 'double', 'char', 'byte', 'boolean', 'bool',
      'void', 'long', 'short', 'unsigned', 'signed', 'const', 'static',
      'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t',
      'int8_t', 'int16_t', 'int32_t', 'int64_t',
      'size_t', 'String', 'string',
      // 关键字
      'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
      'break', 'continue', 'return', 'goto',
      'struct', 'class', 'enum', 'union', 'typedef',
      'public', 'private', 'protected', 'virtual', 'override',
      'new', 'delete', 'this', 'template', 'typename',
      'try', 'catch', 'throw', 'namespace', 'using',
      'extern', 'volatile', 'register', 'inline', 'auto',
      // ESP32 特定
      'ESP', 'esp_restart', 'esp_deep_sleep', 'esp_sleep_enable_timer_wakeup',
      'xTaskCreate', 'xTaskCreatePinnedToCore', 'vTaskDelay', 'vTaskDelete',
      'portTICK_PERIOD_MS', 'IRAM_ATTR',
      // 常用宏
      'F', 'PROGMEM', 'pgm_read_byte', 'pgm_read_word',
      'EEPROM', 'SD', 'LittleFS', 'SPIFFS',
      // I2C/Wire 常量
      'SCL', 'SDA', 'SCL1', 'SDA1'
    ]);
    
    // 从源代码提取库前缀（如果提供了源代码）
    const libraryPrefixes = sourceContent ? this.extractLibraryPrefixes(sourceContent) : [];
    
    // ====== 作用域感知的变量收集 ======
    
    // 全局变量（在函数外部定义）
    const globalVars = new Set<string>();
    
    // 每个函数的局部变量和参数: funcName -> Set<varName>
    const functionScopes = new Map<string, Set<string>>();
    
    // 1. 收集全局变量（不在任何函数内部的声明）
    const allDecls = root.findAll({ rule: { kind: 'declaration' } });
    for (const decl of allDecls) {
      // 检查是否在函数内部
      const parentFunc = this.findParentFunction(decl);
      
      if (!parentFunc) {
        // 这是全局声明
        this.extractDeclaredVars(decl, globalVars);
      }
    }
    
    // 2. 收集每个函数的局部变量和参数
    const funcDefs = root.findAll({ rule: { kind: 'function_definition' } });
    for (const funcDef of funcDefs) {
      const funcName = this.getFunctionName(funcDef);
      if (!funcName) continue;
      
      const localVars = new Set<string>();
      
      // 2a. 收集函数参数
      const funcDeclarator = funcDef.find({ rule: { kind: 'function_declarator' } });
      if (funcDeclarator) {
        const params = funcDeclarator.findAll({ rule: { kind: 'parameter_declaration' } });
        for (const param of params) {
          const id = param.find({ rule: { kind: 'identifier' } });
          if (id) {
            localVars.add(id.text());
          }
        }
      }
      
      // 2b. 收集函数体内的局部变量
      const body = funcDef.find({ rule: { kind: 'compound_statement' } });
      if (body) {
        const localDecls = body.findAll({ rule: { kind: 'declaration' } });
        for (const decl of localDecls) {
          this.extractDeclaredVars(decl, localVars);
        }
        
        // 2c. for 循环中的变量也是局部变量
        const forStmts = body.findAll({ rule: { kind: 'for_statement' } });
        for (const forStmt of forStmts) {
          const initDecl = forStmt.find({ rule: { kind: 'declaration' } });
          if (initDecl) {
            this.extractDeclaredVars(initDecl, localVars);
          }
        }
      }
      
      functionScopes.set(funcName, localVars);
    }
    
    // ====== 检查变量使用 ======
    
    // 辅助函数：检查变量在指定位置是否可见
    const isVariableVisible = (varName: string, node: any): boolean => {
      // 检查内置符号
      if (builtins.has(varName)) return true;
      
      // 检查全局变量
      if (globalVars.has(varName)) return true;
      
      // 检查库符号
      if (this.isLibrarySymbol(varName, libraryPrefixes)) return true;
      
      // 检查当前函数的局部变量
      const parentFunc = this.findParentFunction(node);
      if (parentFunc) {
        const funcName = this.getFunctionName(parentFunc);
        if (funcName) {
          const localVars = functionScopes.get(funcName);
          if (localVars && localVars.has(varName)) return true;
        }
      }
      
      return false;
    };

    // 5. 查找所有标识符使用（在函数调用参数中）
    const callExprs = root.findAll({ rule: { kind: 'call_expression' } });
    const reportedVars = new Set<string>(); // 避免重复报告
    
    for (const call of callExprs) {
      const args = call.find({ rule: { kind: 'argument_list' } });
      if (!args) continue;
      
      // 获取参数中的标识符
      const identifiers = args.findAll({ rule: { kind: 'identifier' } });
      
      for (const id of identifiers) {
        const name = id.text();
        const range = id.range();
        
        // 使用作用域感知的可见性检查
        if (isVariableVisible(name, id) || reportedVars.has(name)) {
          continue;
        }
        
        // 检查是否是成员访问的一部分（如 Serial.println 中的 Serial）
        const parent = id.parent();
        if (parent && parent.kind() === 'field_expression') {
          continue;
        }
        
        // 检查是否是函数名
        const callParent = id.parent();
        if (callParent && callParent.kind() === 'call_expression') {
          const funcId = callParent.child(0);
          if (funcId && funcId.text() === name) {
            continue; // 这是函数调用，不是变量使用
          }
        }
        
        reportedVars.add(name);
        errors.push({
          file: filePath,
          line: range.start.line + 1,
          column: range.start.column + 1,
          message: `Undefined variable: '${name}'`,
          severity: 'error',
          code: 'UNDEFINED_VAR'
        });
      }
    }
    
    // 5.5 检查二元表达式中的变量（如 temperature > HIGH_TEMP）
    const binaryExprs = root.findAll({ rule: { kind: 'binary_expression' } });
    for (const binExpr of binaryExprs) {
      const identifiers = binExpr.findAll({ rule: { kind: 'identifier' } });
      
      for (const id of identifiers) {
        const name = id.text();
        const range = id.range();
        
        // 跳过已检查或可见的变量
        if (isVariableVisible(name, id) || reportedVars.has(name)) {
          continue;
        }
        
        // 检查是否是成员访问的一部分
        const parent = id.parent();
        if (parent && parent.kind() === 'field_expression') {
          continue;
        }
        
        reportedVars.add(name);
        errors.push({
          file: filePath,
          line: range.start.line + 1,
          column: range.start.column + 1,
          message: `Undefined variable: '${name}' - variable is out of scope or not declared`,
          severity: 'error',
          code: 'UNDEFINED_VAR'
        });
      }
    }
    
    // 6. 检查赋值表达式中的变量
    const assignments = root.findAll({ rule: { kind: 'assignment_expression' } });
    
    for (const assign of assignments) {
      const children = assign.children();
      if (children.length >= 3) {
        // 左侧是第一个子节点 - 检查赋值目标是否已声明
        const lhs = children[0];
        if (lhs && lhs.kind() === 'identifier') {
          const name = lhs.text();
          const range = lhs.range();
          
          // 如果左侧变量未声明，这是一个错误（C++中不能给未声明的变量赋值）
          if (!isVariableVisible(name, lhs) && !reportedVars.has(name)) {
            reportedVars.add(name);
            errors.push({
              file: filePath,
              line: range.start.line + 1,
              column: range.start.column + 1,
              message: `Undefined variable: '${name}' - did you forget to declare it?`,
              severity: 'error',
              code: 'UNDEFINED_VAR'
            });
          }
        }
        
        // 右侧是第三个子节点 - 检查使用的变量是否已声明
        const rhs = children[2];
        if (rhs && rhs.kind() === 'identifier') {
          const name = rhs.text();
          const range = rhs.range();
          
          if (!isVariableVisible(name, rhs) && !reportedVars.has(name)) {
            reportedVars.add(name);
            errors.push({
              file: filePath,
              line: range.start.line + 1,
              column: range.start.column + 1,
              message: `Undefined variable: '${name}'`,
              severity: 'error',
              code: 'UNDEFINED_VAR'
            });
          }
        }
      }
    }

    // 7. 检查 field_expression 中的对象（如 http.begin() 中的 http）
    const fieldExprs = root.findAll({ rule: { kind: 'field_expression' } });
    for (const field of fieldExprs) {
      const children = field.children();
      if (children.length >= 1) {
        const obj = children[0];
        if (obj && obj.kind() === 'identifier') {
          const name = obj.text();
          const range = obj.range();
          
          // 使用作用域感知的可见性检查，并避免重复报告
          if (isVariableVisible(name, obj) || reportedVars.has(name)) {
            continue;
          }
          
          reportedVars.add(name);
          errors.push({
            file: filePath,
            line: range.start.line + 1,
            column: range.start.column + 1,
            message: `Undefined object: '${name}'`,
            severity: 'error',
            code: 'UNDEFINED_VAR'
          });
        }
      }
    }
  }

  /**
   * 查找节点所属的父函数定义
   */
  private findParentFunction(node: any): any {
    let current = node.parent();
    while (current) {
      if (current.kind() === 'function_definition') {
        return current;
      }
      current = current.parent();
    }
    return null;
  }

  /**
   * 获取函数定义的名称
   */
  private getFunctionName(funcDef: any): string | null {
    const funcDeclarator = funcDef.find({ rule: { kind: 'function_declarator' } });
    if (funcDeclarator) {
      const id = funcDeclarator.find({ rule: { kind: 'identifier' } });
      if (id) {
        return id.text();
      }
    }
    return null;
  }

  /**
   * 从声明节点中提取变量名到指定集合
   */
  private extractDeclaredVars(decl: any, vars: Set<string>): void {
    // 1. init_declarator 形式: int x = 0;
    const declarators = decl.findAll({ rule: { kind: 'init_declarator' } });
    for (const d of declarators) {
      const id = d.find({ rule: { kind: 'identifier' } });
      if (id) {
        vars.add(id.text());
      }
    }
    
    // 2. 构造函数式声明: ClassName obj(args);
    const funcDeclaratorInDecl = decl.find({ rule: { kind: 'function_declarator' } });
    if (funcDeclaratorInDecl) {
      const id = funcDeclaratorInDecl.find({ rule: { kind: 'identifier' } });
      if (id) {
        vars.add(id.text());
      }
    }
    
    // 3. 简单声明（无初始化）: int x;
    const simpleIds = decl.children().filter((c: any) => c.kind() === 'identifier');
    for (const id of simpleIds) {
      vars.add(id.text());
    }
  }

  /**
   * 检查 pinMode 使用情况
   */
  private checkPinModeUsage(root: any, filePath: string, notes: LintError[]): void {
    // 查找所有 digitalWrite 和 digitalRead 调用 - 使用 rule 包装
    const digitalCalls = root.findAll({ rule: { pattern: 'digitalWrite($PIN, $VAL)' } });
    const digitalReads = root.findAll({ rule: { pattern: 'digitalRead($PIN)' } });
    
    // 查找所有 pinMode 调用
    const pinModes = root.findAll({ rule: { pattern: 'pinMode($PIN, $MODE)' } });
    
    // 提取已配置的引脚
    const configuredPins = new Set<string>();
    for (const pm of pinModes) {
      const pin = pm.getMatch('PIN');
      if (pin) {
        configuredPins.add(pin.text());
      }
    }
    
    // 检查使用的引脚是否都已配置
    for (const call of [...digitalCalls, ...digitalReads]) {
      const pin = call.getMatch('PIN');
      if (pin && !configuredPins.has(pin.text())) {
        const range = call.range();
        // 只对数字引脚提示（不对变量名提示）
        const pinText = pin.text();
        if (/^\d+$/.test(pinText) || /^[A-Z]\d+$/.test(pinText)) {
          notes.push({
            file: filePath,
            line: range.start.line + 1,
            column: range.start.column + 1,
            message: `Pin ${pinText} used but pinMode() not found - ensure it's set in setup()`,
            severity: 'note',
            code: 'PIN_MODE_MISSING'
          });
        }
      }
    }
  }

  /**
   * 去重诊断信息
   */
  private deduplicateDiagnostics(diagnostics: LintError[]): LintError[] {
    const seen = new Set<string>();
    return diagnostics.filter(d => {
      const key = `${d.file}:${d.line}:${d.column}:${d.code}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  /**
   * 批量分析多个文件
   */
  async analyzeFiles(files: Array<{ path: string; content: string }>): Promise<Map<string, AstGrepLintResult>> {
    const results = new Map<string, AstGrepLintResult>();
    
    // 并行分析所有文件
    const analysisPromises = files.map(async (file) => {
      const result = await this.analyzeFile(file.path, file.content);
      return { path: file.path, result };
    });
    
    const analyses = await Promise.all(analysisPromises);
    
    for (const { path, result } of analyses) {
      results.set(path, result);
    }
    
    return results;
  }

  /**
   * 添加自定义规则
   */
  addRule(rule: LintRule): void {
    this.rules.push(rule);
  }

  /**
   * 移除规则
   */
  removeRule(ruleId: string): void {
    this.rules = this.rules.filter(r => r.id !== ruleId);
  }

  /**
   * 获取所有规则
   */
  getRules(): LintRule[] {
    return [...this.rules];
  }

  /**
   * 禁用特定规则
   */
  disableRule(ruleId: string): void {
    const rule = this.rules.find(r => r.id === ruleId);
    if (rule) {
      (rule as any)._disabled = true;
    }
  }

  /**
   * 启用特定规则
   */
  enableRule(ruleId: string): void {
    const rule = this.rules.find(r => r.id === ruleId);
    if (rule) {
      delete (rule as any)._disabled;
    }
  }
}

/**
 * 创建一个简单的 Logger 实例用于测试
 */
function createSimpleLogger(): Logger {
  return {
    debug: () => {},
    verbose: () => {},
    info: () => {},
    warn: () => {},
    error: console.error,
    // 添加 Logger 接口需要的其他属性
    isVerbose: false,
    logFilePath: null,
    logToFile: () => {},
    colors: { reset: '', red: '', green: '', yellow: '', blue: '', cyan: '' },
    formatTime: () => '',
    setVerbose: () => {},
    setLogFile: () => {},
    close: () => {},
    success: () => {}
  } as unknown as Logger;
}

/**
 * 快速分析函数 - 简化的接口
 */
export async function quickLint(
  content: string,
  filePath: string = 'sketch.ino',
  logger?: Logger
): Promise<AstGrepLintResult> {
  const defaultLogger = logger || createSimpleLogger();
  
  const linter = new AstGrepLinter(defaultLogger);
  return linter.analyzeFile(filePath, content);
}

/**
 * 创建预配置的 Arduino linter 实例
 */
export function createArduinoLinter(logger: Logger): AstGrepLinter {
  return new AstGrepLinter(logger);
}

/**
 * 创建带有 ESP32 特定规则的 linter
 */
export function createESP32Linter(logger: Logger): AstGrepLinter {
  const esp32Rules: LintRule[] = [
    {
      id: 'esp32-wifi-mode',
      severity: 'note',
      message: 'WiFi.mode() should be called before WiFi.begin()',
      pattern: 'WiFi.begin($$$)',
    },
    {
      id: 'esp32-task-delay',
      severity: 'warning',
      message: 'Consider using vTaskDelay() instead of delay() in FreeRTOS tasks',
      pattern: 'delay($MS)',
      inside: {
        kind: 'function_definition',
        not: {
          has: {
            kind: 'function_declarator',
            any: [{ pattern: 'setup' }, { pattern: 'loop' }]
          }
        }
      }
    },
    {
      id: 'esp32-gpio-interrupt',
      severity: 'note',
      message: 'Remember to use IRAM_ATTR for interrupt handlers on ESP32',
      pattern: 'attachInterrupt($$$)',
    }
  ];
  
  return new AstGrepLinter(logger, esp32Rules);
}
