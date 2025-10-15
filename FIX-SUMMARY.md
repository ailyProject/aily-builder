# 预编译条件语句解析修复

## 问题描述

原代码无法正确解析嵌套的预编译条件语句，特别是包含 `#elif` 的复杂嵌套结构，例如：

```cpp
#include "Blinker/BlinkerApi.h"
#if defined(BLINKER_WIFI)
    #if defined(ESP32)
        #if defined(BLINKER_WIFI_MULTI)
            extern WiFiMulti wifiMulti;
        #endif
    #elif defined(ARDUINO_ARCH_RENESAS)
        #include "RTC.h"
        #include "../modules/NTPClient/NTPClient.h"
        #include <WiFiS3.h>
        #include <WiFiUdp.h>
    #endif
#endif
```

## 问题根源

通过 AST 结构调试发现：

1. **`preproc_elif` 是 `preproc_if` 的子节点**，而不是兄弟节点
2. **`preproc_else` 可能是 `preproc_elif` 的子节点**
3. 原代码的递归遍历逻辑没有正确处理这种嵌套的 AST 结构

## 解决方案

### 1. 重构条件编译管理器

#### `handleElif` 方法简化
- 移除了复杂的栈帧查找逻辑
- 直接在当前栈帧上处理 elif 逻辑
- 正确处理 `hadTrueBranch` 标志，确保只有在之前没有分支为真时才执行 elif

```typescript
handleElif(conditionMet: boolean): boolean {
    const currentFrame = this.getCurrentFrame();
    if (!currentFrame) {
        return false;
    }

    // 如果之前的分支已经为真，则elif不会被执行
    if (currentFrame.hadTrueBranch) {
        currentFrame.active = false;
        return false;
    }

    // 计算elif条件是否激活：父条件必须激活且当前条件满足
    const newActive = currentFrame.parentActive && conditionMet;
    currentFrame.active = newActive;
    
    if (conditionMet) {
        currentFrame.hadTrueBranch = true;
    }

    return newActive;
}
```

#### `handleElse` 方法优化
- 确保 else 分支只在之前没有分支为真时激活
- 正确使用 `parentActive` 来确定 else 分支的激活状态

```typescript
handleElse(): boolean {
    const currentFrame = this.getCurrentFrame();
    if (!currentFrame) {
        return true;
    }

    // 如果之前有分支为真，else不会被执行
    if (currentFrame.hadTrueBranch) {
        currentFrame.active = false;
    } else {
        // 否则，else分支激活状态取决于父条件
        currentFrame.active = currentFrame.parentActive;
        currentFrame.hadTrueBranch = true;
    }

    return currentFrame.active;
}
```

### 2. 重写 AST 遍历逻辑

创建了新的 `processConditionalBlock` 方法，专门处理完整的条件编译块：

```typescript
private processConditionalBlock(node: SyntaxNode, parentConditionActive: boolean): void {
    // 1. 处理 #if 或 #ifdef，推入条件栈
    // 2. 遍历子节点，特殊处理：
    //    - preproc_elif: 调用 handleElif，处理其子节点
    //    - preproc_else: 调用 handleElse，处理其子节点
    //    - 其他节点: 在当前激活条件下递归遍历
    // 3. 弹出条件栈
}
```

关键改进：
- **不再简单递归**：识别条件编译块的完整结构
- **正确处理 elif 和 else**：作为 if 块的一部分统一处理
- **维护正确的激活状态**：在处理每个分支时更新并传递正确的激活状态

### 3. 修改主遍历函数

```typescript
walkNode(node: SyntaxNode, parentConditionActive = true): void {
    // 特殊处理条件编译节点
    if (node.type === 'preproc_if' || node.type === 'preproc_ifdef') {
        this.processConditionalBlock(node, parentConditionActive);
        return;
    }

    // 对于其他预处理指令，正常处理
    // 对于非预处理节点，递归遍历子节点
}
```

## 测试验证

创建了完整的测试套件 `test-analyze.ts`，包含两类测试场景：

### 场景1：嵌套条件编译（原问题）
- ✅ BLINKER_WIFI + ESP32
- ✅ BLINKER_WIFI + ESP32 + BLINKER_WIFI_MULTI  
- ✅ BLINKER_WIFI + ARDUINO_ARCH_RENESAS (elif分支)
- ✅ 无宏定义
- ✅ 只有 BLINKER_WIFI

### 场景2：复杂嵌套场景
- ✅ A + B (嵌套 if 走 if 分支)
- ✅ A + C (嵌套 if 走 elif 分支)
- ✅ A (嵌套 if 走 else 分支)
- ✅ D (外层 elif 分支)
- ✅ 无宏 (外层 else 分支)

所有测试场景均通过！

## 使用方法

运行测试：
```bash
npx ts-node test-analyze.ts
```

调试 AST 结构：
```bash
npx ts-node debug-ast.ts
```

## 技术要点

1. **理解 tree-sitter-cpp 的 AST 结构**：条件编译的分支是父子关系而非兄弟关系
2. **维护条件栈**：使用 `hadTrueBranch` 标志确保互斥分支的正确性
3. **父条件传递**：确保嵌套条件正确继承父条件的激活状态
4. **完整块处理**：将 if-elif-else 作为一个整体处理，而不是独立的预处理指令

## 文件修改

- `src/utils/AnalyzeFile.ts` - 核心修复
- `test-analyze.ts` - 测试脚本（新增）
- `debug-ast.ts` - AST 调试脚本（新增）
