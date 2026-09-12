# 工具注册与安全模式

## 问题

代理需要工具（shell、文件编辑、搜索等）才能有生产力。但无边界的工具访问会带来风险：

- 破坏性操作（rm -rf、DROP TABLE 等）
- 并发工具调用引发的竞态条件
- 权限配置错误导致的静默策略违规

解决方案是**默认关闭（fail-closed）的注册表**，配合显式的并发分类与多来源权限流水线。

## 黄金法则

### 默认 Fail-Closed

除非显式标记为安全，否则工具一律视为**非并发安全**且**非只读**。这可防止：
- 状态变更操作被意外并行执行
- 并发写入导致的静默数据损坏

### 并发是按调用判定，不是按工具判定

同一工具对某些输入安全，对另一些则不安全：

```
✓ 安全（可并行运行）：
  - cat file1.txt
  - grep "pattern" src/
  - ls -la

✗ 不安全（必须串行运行）：
  - rm -rf build/
  - npm install（网络、文件系统变更）
  - sed -i 's/old/new/g' *.ts
```

运行时将一批工具调用划分为连续的分组：安全调用并行运行；任何不安全调用都会开启一个串行段。

### 权限流水线有副作用

权限评估器是**有状态的** —— 它会：
- 跟踪拒绝记录（用于审计与限流）
- 转换模式（如被拒后从 auto 变为 ask）
- 以副作用方式更新会话状态

**严格的优先级顺序：**
```
策略（组织级）→ 用户设置 → 项目规则 → 本地覆盖 → 会话授权
```

## 何时使用

- 代理运行时需要工具注册
- 需要并行工具调用的并发控制
- 需要权限关卡（自动批准、先询问、拒绝）
- 需要跟踪工具使用以审计

## 权衡

| 决策 | 收益 | 代价 |
|---|---|---|
| Fail-closed 默认值 | 新工具开箱即安全 | 开发者必须主动启用并发 |
| 按调用分类 | 对并行度的细粒度控制 | 需要分析每次调用，而非仅注册工具 |
| 多来源权限分层 | 灵活的策略组合 | 规则冲突时难以调试 |
| 有状态评估器 | 可基于历史调整行为 | 非纯函数——更难测试 |

## 实现模式

### 工具注册

```typescript
// Example: Tool registry entry
interface ToolDefinition {
  name: string;
  description: string;
  handler: (args: any) => Promise<any>;
  
  // Safety classification
  isReadOnly: boolean;       // Default: false
  isConcurrentSafe: boolean; // Default: false
  
  // Optional custom permission logic
  permissionCheck?: (args: any, context: ToolContext) => PermissionResult;
}

// Register tools
registry.register('read_file', {
  name: 'read_file',
  description: 'Read contents of a file',
  handler: readFile,
  isReadOnly: true,
  isConcurrentSafe: true,  // Safe to read multiple files in parallel
});

registry.register('write_file', {
  name: 'write_file',
  description: 'Write or overwrite a file',
  handler: writeFile,
  isReadOnly: false,
  isConcurrentSafe: false, // Must run serially to prevent race conditions
});
```

### 权限流水线

```typescript
// Permission evaluation order
async function evaluatePermission(
  toolCall: ToolCall,
  context: PermissionContext
): Promise<PermissionResult> {
  
  // 1. Policy rules (highest priority, org-wide)
  const policyResult = await policyEngine.check(toolCall, context);
  if (policyResult !== 'defer') return policyResult;
  
  // 2. User settings
  const userResult = await userSettings.check(toolCall, context);
  if (userResult !== 'defer') return userResult;
  
  // 3. Project rules
  const projectResult = await projectRules.check(toolCall, context);
  if (projectResult !== 'defer') return projectResult;
  
  // 4. Local overrides
  const localResult = await localOverrides.check(toolCall, context);
  if (localResult !== 'defer') return localResult;
  
  // 5. Session grants (lowest priority)
  return sessionGrants.check(toolCall, context);
}
```

### 防绕过规则

某些路径或操作永远不应自动批准：

```yaml
# Protected paths (never auto-approve)
protected_paths:
  - /etc/**
  - /usr/**
  - node_modules/**
  - .git/**

# Protected commands (always ask)
protected_commands:
  - "rm -rf*"
  - "DROP TABLE*"
  - "DELETE FROM*"
  - "mkfs*"
```

## 陷阱

1. **大多数异步工作跳过"pending"状态** —— 工作单元直接注册为"running"
2. **权限评估有副作用** —— 不要跨调用缓存结果
3. **并发分类需要分析输入**，而不仅是工具名
4. **工具的默认权限是"allow"** —— 没有自定义逻辑的工具会完全委托给基于规则的系统
5. **驱逐需要通知** —— 终止的工作单元只有在父级收到通知后才可被 GC

## 相关模式

- [生命周期与启动](lifecycle-bootstrap-pattern.md) —— 初始化时如何注册工具，以及工具前后钩子的分发

## 模板：工具安全检查清单

启用新工具前：

```markdown
## 工具安全评审

**工具名称**：[如 execute_shell]

### 分类
- [ ] 已确定是否只读（true / false / 取决于参数）
- [ ] 已确定是否并发安全（true / false / 取决于参数）
- [ ] 已记录不安全的输入模式

### 权限要求
- [ ] 默认模式设为 "ask" 或 "deny"
- [ ] 已定义防绕过的路径/命令
- [ ] 已实现自定义权限逻辑（如需要）
- [ ] 已启用审计日志

### 测试
- [ ] 用安全输入测试（应自动批准）
- [ ] 用不安全输入测试（应询问/拒绝）
- [ ] 测试并发执行（不安全时应串行化）
- [ ] 测试错误处理（失败已记录，状态一致）
```

## 证据

工具注册与安全模式见于生产级代理运行时，包括：
- Claude Code 带显式并发标志的工具注册表
- 多来源权限评估（设置 → 项目 → 会话）
- 可绕过自动批准模式的受保护路径/命令列表
- 按调用分类并发并划分工具批次的机制
