# Windows CRLF 换行符修复

## 问题描述

在 Windows 系统中，`BlinkerTimer.h` 和其他实际文件无法被正确分析，返回空的 includes 数组。但相同内容的合成测试文件却可以正常工作。

## 根本原因

### Windows vs Unix 换行符差异

- **Unix/Linux**: 使用 `\n` (LF) 作为换行符
- **Windows**: 使用 `\r\n` (CRLF) 作为换行符

### 问题代码

在 `AnalyzeFile.ts` 的 `extractCondition` 方法中：

```typescript
private extractCondition(node: SyntaxNode): string {
    const text = this.getNodeText(node);
    // 问题：只按 \n 分割，Windows 文件会在每行末尾保留 \r
    const firstLine = text.split('\n')[0];  // ❌
    
    const match = firstLine.match(/#(?:el)?if\s*(.+?)(?:\/\/|\/\*|$)/);
    return match ? match[1].trim() : '';
}
```

### 失败过程

1. Windows 文件内容：`"#if defined(ESP32)\r\n..."`
2. `text.split('\n')` 分割后：`firstLine = "#if defined(ESP32)\r"`
3. 正则 `/#(?:el)?if\s*(.+?)(?:\/\/|\/\*|$)/` 无法匹配
   - `$` 匹配字符串末尾
   - 但 `\r` 在 `$` 之前，所以正则无法匹配到任何内容
4. `match` 为 `null`，返回空字符串
5. 条件评估失败，所有 includes 被跳过

### 调试证据

```
[COND] firstLine: "#if defined(ESP32)\r"  // 注意末尾的 \r
[COND] match result: null                   // 匹配失败
[COND] Extracted condition text: ""
[COND] No condition text extracted!
结果: []                                    // 空数组
```

## 解决方案

修改 `extractCondition` 方法，使用跨平台的换行符分割：

```typescript
private extractCondition(node: SyntaxNode): string {
    const text = this.getNodeText(node);
    // ✅ 使用 /\r?\n/ 同时处理 Windows 和 Unix 换行符
    const firstLine = text.split(/\r?\n/)[0];
    
    const match = firstLine.match(/#(?:el)?if\s*(.+?)(?:\/\/|\/\*|$)/);
    return match ? match[1].trim() : '';
}
```

### 工作过程

1. Windows 文件内容：`"#if defined(ESP32)\r\n..."`
2. `text.split(/\r?\n/)` 分割后：`firstLine = "#if defined(ESP32)"` ✓
3. 正则成功匹配：`match[1] = "defined(ESP32)"` ✓
4. 条件正确评估，includes 正确提取 ✓

## 测试结果

### 修复前
```
结果: []  // 空数组
```

### 修复后
```
场景1: ESP32 平台
包含的头文件: [ 'Ticker.h', 'EEPROM.h' ]
验证: ✓ Ticker.h ✓ EEPROM.h

场景2: ARDUINO_ARCH_RENESAS 平台
包含的头文件: [ 'RenesasTicker.h', 'EEPROM.h' ]
验证: ✓ RenesasTicker.h ✓ EEPROM.h
```

## 影响范围

此修复解决了所有在 Windows 系统上的文件分析问题：
- ✅ BlinkerTimer.h 现在可以正确分析
- ✅ EMailSender.h 仍然正常工作
- ✅ 所有原有测试套件继续通过
- ✅ 跨平台兼容性（Windows/Linux/macOS）

## 关键要点

1. **跨平台开发注意事项**：处理文本文件时，必须考虑不同系统的换行符差异
2. **正则表达式陷阱**：`$` 不会匹配 `\r` 之前的位置
3. **测试盲点**：合成测试文件可能使用 `\n`，而实际文件使用 `\r\n`
4. **修复方法**：使用 `/\r?\n/` 可以同时处理两种换行符格式

## 相关 Bug 修复历史

这是在同一次会话中修复的第4个关键 bug：

1. **Bug #1**: `>=` 运算符被字符串替换破坏
2. **Bug #2**: `#if(...)` 格式（无空格）不被支持
3. **Bug #3**: 宏值未展开，存储的是符号名而非实际值
4. **Bug #4**: Windows CRLF 换行符导致条件提取失败 ← 当前修复
