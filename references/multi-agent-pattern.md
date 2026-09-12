# 多代理协调模式

## 问题

单代理会遇到极限：
- **上下文极限** —— 无法在一个会话中装下完整的调研 + 实现
- **专业化** —— 需要独立的研究者、实现者、评审者
- **并行性** —— 希望同时探索多种方案

但多代理系统会引入混乱：
- 工作者重复彼此的调研
- 协调者把理解外包出去，而不是做综合
- 上下文继承指数级爆炸

## 黄金法则

### 协调者必须做综合，而不是把理解委派出去

**反模式：**
> "根据你的发现，修复认证系统。"

**正确模式：**
> "调研识别出 3 个认证流程：登录、登出、令牌刷新。只实现令牌刷新处理器，使用 [调研输出] 中记录的 JWT 策略。返回：实现 diff + 测试结果。"

协调者（编排者）的价值在于：先把工作者的结果消化成精确的规格，再派发实现。

### 三种委派模式

| 模式 | 上下文共享 | 最适合 | 约束 |
|---------|----------------|----------|-------------|
| **协调者** | 无 —— 工作者从零开始 | 复杂多阶段任务（调研 → 综合 → 实现 → 验证） | 最慢但最安全 |
| **分叉** | 完整 —— 子级继承父级历史 | 共享已加载上下文的快速并行拆分 | **仅限单层** —— 递归分叉会让上下文成本倍增 |
| **蜂群** | 通过共享任务列表点对点 | 长时间运行的独立工作流 | **扁平名册** —— 队友不能再派生队友 |

### 结果异步到达；即发即忘的注册立即返回 ID

```typescript
// Example: Spawn worker, get ID back immediately
const taskId = await coordinator.spawn({
  type: 'research',
  prompt: 'Analyze auth flows...',
  toolFilter: ['read', 'search'], // Restrict tools
});

// Parent can continue working while worker runs
// Results arrive via callback or polling
```

## 何时使用

- 任务太大，单代理会话装不下
- 需要并行探索（如为多种方案做原型）
- 需要持久的专业化队友（研究者、实现者、评审者）
- 复杂的多阶段工作流

## 权衡

| 模式 | 速度 | 安全性 | 上下文成本 |
|---------|-------|--------|--------------|
| **协调者** | 最慢 | 最安全 | 最低（零继承） |
| **分叉** | 最快 | 中等 | 最高（全继承） |
| **蜂群** | 中等 | 中等 | 中等（仅共享状态） |

## 实现模式

### 协调者模式（复杂任务推荐）

分阶段工作流：

```
阶段 1：调研
  ↓（综合发现）
阶段 2：规划
  ↓（精确规格）
阶段 3：实现
  ↓（验证）
阶段 4：评审
```

```typescript
// Example: Coordinator workflow
const research = await coordinator.spawn({
  role: 'researcher',
  prompt: `Analyze existing authentication in ${authDir}.
  Find: login flow, logout flow, token handling.
  Return: structured findings only. NO implementation suggestions.`,
  toolFilter: ['read', 'search', 'glob'], // Can't write
});

await coordinator.synthesize(research.results);

const implement = await coordinator.spawn({
  role: 'implementer',
  prompt: `Implement token refresh handler using the JWT strategy
  from [Phase 2 findings]. 
  Constraints: Use existing AuthService patterns, add tests.`,
  toolFilter: ['read', 'search', 'edit', 'test'], // Can write
});
```

### 分叉模式（仅限单层）

```typescript
// Parent spawns children for parallel work
const forks = await Promise.all([
  coordinator.fork({
    prompt: 'Implement login handler',
    inheritContext: true, // Full parent history
  }),
  coordinator.fork({
    prompt: 'Implement logout handler',
    inheritContext: true,
  }),
]);

// CRITICAL: Children must not fork recursively
// If allowed, context cost multiplies: parent + child1 + child2 + ...
```

### 蜂群模式（扁平名册）

```typescript
// Swarm: persistent team with shared task list
const swarm = new Swarm([
  { id: 'researcher', specialty: 'research' },
  { id: 'implementer', specialty: 'implementation' },
  { id: 'reviewer', specialty: 'verification' },
]);

// Agents pick tasks from shared queue
// Results posted back to shared state
await swarm.dispatch({
  taskId: 'feat-001',
  pickedBy: 'implementer',
});
```

## 陷阱

1. **分叉的子级不得再分叉** —— 递归守卫维护单层不变量。分叉工具保留在子级工具池中（便于提示词缓存共享），但在调用时拦截。
2. **协调者的工作者从零上下文开始** —— 只传递显式的提示词。不要假设子级能看到父级积累的调研。
3. **蜂群队友不能派生其他队友** —— 名册扁平以防失控增长。
4. **编写自包含的提示词** —— "根据你的发现"是反模式。协调者必须先消化。
5. **过滤每个工作者的工具集** —— 研究者不需要写权限；实现者不需要宽泛搜索。

## 相关模式

- [上下文工程](context-engineering-pattern.md) —— 委派的隔离模式
- [生命周期与启动](lifecycle-bootstrap-pattern.md) —— 代理如何在初始化时派生

## 模板：工作者提示词结构

```markdown
# 自包含的工作者提示词

## 上下文（复制自协调者综合结果）

**任务**：实现令牌刷新处理器
**背景**：调研识别出基于 JWT 的认证，访问令牌有效期 24 小时。
**决策**：使用刷新令牌轮换（每次刷新签发新刷新令牌）。

## 你的角色

你是**实现者**。你的工作是按照上述规格编写生产级代码。

## 约束

- 沿用 `${authServicePath}` 中的现有模式
- 为成功与失败场景添加测试
- 不要修改登录/登出处理器（属于另一项任务）

## 你的工具

- read、search、edit、test
- Shell：仅限 npm test、npm run check

## 交付物

返回：
1. 实现 diff（变更的文件）
2. 测试结果（通过/失败）
3. 任何阻塞或需要澄清的问题

**不要返回**：调研发现、架构争论、替代设计。
```

## 证据

多代理协调模式见于生产系统，其中：
- 协调者的工作者以零上下文继承启动
- 分叉被限制为单层以控制上下文爆炸
- 蜂群代理通过共享任务列表而非直接提示词通信
- 结果异步到达，注册即发即忘
