# 生命周期与启动模式

## 问题

代理运行时需要在不牺牲安全性的前提下获得可扩展性：

- **钩子** —— 在生命周期时点扩展行为（工具执行前/后、会话开始/结束）
- **后台任务** —— 跟踪长时间运行的工作而不阻塞主代理
- **启动引导** —— 跨多种入口模式（CLI、服务器、SDK）结构化初始化

但不受控的可扩展性会造成：
- 不受信任钩子带来的安全漏洞
- 永不完成的任务造成的资源泄漏
- 初始化中的竞态条件

## 黄金法则

### 钩子信任是全有或全无

如果工作区不受信任，**所有钩子都跳过** —— 不只是可疑的那些。会话作用域的钩子是临时的，会话结束时清理。

```typescript
// Example: Hook dispatch with trust gate
async function dispatchHook(
  hookType: HookType,
  context: HookContext
): Promise<HookResult[]> {
  
  // Trust gate: if workspace untrusted, skip ALL hooks
  if (!context.trustBoundary.crossed) {
    logger.warn('Untrusted workspace, skipping hooks');
    return [];
  }
  
  // Session-scoped hooks ephemeral — cleanup on session end
  const sessionHooks = context.hooks.getByScope('session');
  const projectHooks = context.hooks.getByScope('project');
  
  return await Promise.all([
    ...sessionHooks.map(h => h.execute(context)),
    ...projectHooks.map(h => h.execute(context)),
  ]);
}
```

### 长时间运行的工作：带两阶段驱逐的类型化状态机

每个工作单元拥有：
1. **类型化、带前缀的 ID**（如 `extractor-001`、`benchmark-002`）
2. **严格的生命周期**（running → completed | failed | killed）
3. **落盘的输出**（不仅在内存中）

驱逐分两阶段：
1. **磁盘输出**在终止状态时立即清理（eager）
2. **内存记录**在父级收到通知后延迟清理（lazy）

### 启动引导：按依赖排序、记忆化的阶段

多种入口模式（CLI、服务器、SDK）共享同一条引导路径：

```
阶段 1：创建最小上下文（无需信任）
  ↓
阶段 2：加载工具（只读安全）
  ↓
阶段 3：跨越信任边界（用户授予同意）
  ↓
阶段 4：加载安全敏感子系统（遥测、机密环境变量）
```

**关键拐点**：安全敏感子系统在信任建立之前不得激活。

## 何时使用

- 需要在不修改核心代码的情况下扩展代理行为
- 需要跟踪长时间运行的后台工作
- 需要跨多种入口模式的结构化初始化
- 需要在生命周期时点挂载钩子（工具前/后、会话开始/结束）

## 权衡

| 决策 | 收益 | 代价 |
|---|---|---|
| 全有或全无的钩子信任 | 安全边界简单 | 一个不受信任的钩子会禁用整个扩展系统 |
| 任务输出落盘 | 无论并发工作量多少，内存恒定 | I/O 延迟与工作单元数成正比 |
| 按依赖排序的引导 | 多种入口模式共享路径 | 初始启动是串行的（阶段无法并行） |
| 记忆化阶段 | 重新初始化很快 | 配置变更时必须小心地使记忆化失效 |

## 实现模式

### 钩子生命周期

六种钩子类型在定义的时点分发：

```typescript
interface HookRegistry {
  // Session lifecycle
  onSessionStart: (context: SessionContext) => Promise<void>;
  onSessionEnd: (context: SessionContext) => Promise<void>;
  
  // Tool execution
  preToolExecute: (context: ToolContext) => Promise<ToolContext>;
  postToolExecute: (context: ToolResult) => Promise<ToolResult>;
  
  // Prompt submission
  prePromptSubmit: (context: PromptContext) => Promise<PromptContext>;
  postPromptSubmit: (context: ResponseContext) => Promise<ResponseContext>;
}

// Usage: Register hooks via config
// /update-config hooks.preToolExecute = "scripts/audit-tool-call.js"
```

### 长时间运行任务跟踪

```typescript
interface TaskRegistry {
  // Typed prefixed IDs
  registerWork(
    type: 'extraction' | 'benchmark' | 'indexing',
    outputType: 'json' | 'text' | 'file'
  ): string; // Returns typed ID: `extraction-001`
  
  // Strict state machine
  updateState(
    taskId: string,
    state: 'running' | 'completed' | 'failed' | 'killed',
    output?: any
  ): void;
  
  // Two-phase eviction
  evictTask(taskId: string): void;
  // 1. Clean disk output (eager, at terminal state)
  // 2. Clean in-memory record (lazy, after parent notified)
}
```

### 引导序列

```typescript
// Example: Dependency-ordered initialization
class AgentBootstrap {
  private stages = new Map<string, Stage>();
  private memoizedCallers = new Map<string, any>();
  
  async bootstrap(entryMode: 'cli' | 'server' | 'sdk'): Promise<AgentContext> {
    
    // Stage 1: Minimal context (no trust required)
    await this.runStage('minimal-context', async () => {
      return {
        cwd: process.cwd(),
        entryMode,
        trustBoundary: { crossed: false },
      };
    });
    
    // Stage 2: Load tools (read-only safe)
    await this.runStage('load-tools', async (context) => {
      context.tools = await this.loadSafeTools();
      return context;
    });
    
    // Stage 3: Trust boundary (user grants consent)
    await this.runStage('trust-boundary', async (context) => {
      const consent = await this.requestConsent();
      context.trustBoundary = { crossed: consent };
      return context;
    });
    
    // Stage 4: Security-sensitive subsystems (requires trust)
    if (context.trustBoundary.crossed) {
      await this.runStage('load-sensitive', async (context) => {
        context.telemetry = await this.loadTelemetry();
        context.secretEnvVars = await this.loadSecrets();
        return context;
      });
    }
    
    return context;
  }
  
  private async runStage(
    name: string,
    fn: (context: AgentContext) => Promise<AgentContext>
  ): Promise<void> {
    // Memoized: skip if already run
    if (this.stages.has(name) && this.stages.get(name).complete) {
      return;
    }
    
    // Run stage
    const stage = { name, complete: false, running: true };
    this.stages.set(name, stage);
    
    try {
      await fn(this.context);
      stage.complete = true;
    } finally {
      stage.running = false;
    }
  }
}
```

## 陷阱

1. **钩子信任是全有或全无** —— 一个不受信任的钩子会禁用整个扩展系统
2. **大多数异步工作跳过"pending"状态** —— 工作单元直接注册为"running"
3. **驱逐需要通知** —— 终止的工作单元只有在父级收到通知后才可被 GC
4. **快速路径分发** —— 记忆化的调用方必须处理并发调用而不重复运行阶段
5. **钩子类型必须互不相交** —— 不要创建重叠的钩子作用域

## 相关模式

- [工具注册](tool-registry-pattern.md) —— 工具如何在引导时注册
- [记忆持久化](memory-persistence-pattern.md) —— 初始化时如何加载记忆

## 模板：引导检查清单

宣布引导完成之前：

```markdown
## 引导验证

### 阶段 1：最小上下文
- [ ] 工作目录已确认
- [ ] 入口模式已确定（cli / server / sdk）
- [ ] 未跨越信任边界（未加载机密）

### 阶段 2：工具已加载
- [ ] 只读工具已注册（read、search、glob）
- [ ] 写入工具尚未注册（edit、shell）
- [ ] 工具权限设为默认值（ask / deny）

### 阶段 3：信任边界
- [ ] 已请求用户同意（交互式或配置标志）
- [ ] 同意已记录到会话状态
- [ ] 安全审计已记录

### 阶段 4：敏感子系统
- [ ] 遥测已初始化（如已同意）
- [ ] 机密环境变量已加载（如已同意）
- [ ] 写入工具已注册（edit、shell、exec）
- [ ] 钩子系统已启用（如工作区受信任）

### 阶段 5：后台任务
- [ ] 任务注册表已初始化
- [ ] 清理处理器已注册
- [ ] 关停时排空（drain-on-shutdown）已配置

## 如果任何阶段失败

- 引导立即中止
- 会话保持安全模式（只读）
- 错误连同阶段名与失败原因一并记录
```

## 证据

生命周期与引导模式见于生产级运行时，其中：
- 钩子分发基于工作区信任全有或全无
- 长时间运行的任务使用类型化带前缀 ID 与落盘输出
- 引导按依赖排序并使用记忆化阶段
- 信任边界是安全敏感子系统的显式拐点
