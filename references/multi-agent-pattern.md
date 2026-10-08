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

## 多代理所有权边界

### 问题

多个代理在同一份工作区并行时，破坏不来自某个代理写错一行，而来自范围事先没有落到文字上：两个工作者各自合理地编辑同一个文件，协调者直到比对改动清单才发现交集；范围与工作区里已存在的未提交改动重叠，用户在途的修改被悄悄覆盖。`SKILL.md:137` 的反例 #4 把这条列为硬要求：没有所有权边界就不要同时推进多件事。

### 黄金法则

**每个工作者代理的提示词里必须携带一条可被检索到的范围声明行。** 边界只存在于协调者的判断里就不算边界。

### 声明的最小格式

每个工作者的提示词里必须出现下面这一行，四个字段缺一不可：

```
范围：<允许写入的路径>｜禁触：<不允许触碰的路径>｜完成：<可核对的完成判据>｜交接：<交回协调者的形式>
```

- **范围**：允许写入的路径清单。要具体到目录或文件，不写「后端部分」这类不可判定的说法。
- **禁触**：明确不许改的路径，通常是范围之外的邻近文件。
- **完成**：协调者能独立核对的一句话判据，形如「某命令退出码为 0」或「某产物存在且非空」。
- **交接**：交回的形式，形如「改动文件清单 + 命令输出摘要」。

机械判定：检查每个工作者的提示词能否匹配到 `范围：` `禁触：` `完成：` `交接：` 四个字段名，且行内出现三次全角分隔符「｜」。匹配不到即视为未声明，该工作者不得启动。这是本节唯一硬性的形状要求，其余字段可以随项目变化。

### 冲突如何被发现

| 冲突 | 发现时机 | 判定做法 |
|---|---|---|
| 同文件并发写 | 工作者运行期间或收尾时 | 编辑落盘前检查该路径是否已被另一个工作者登记为范围；无法在运行时拦截时，让每个工作者在收尾报告改动清单，由协调者比对清单交集 |
| 范围重叠 | 派发阶段，写第一行代码之前 | 展开所有工作者的「范围」字段为路径集合，两两求交集；交集非空即按下方例外规则裁定 |
| 范围与已有未提交改动重叠 | 派发阶段 | 范围集合与工作区当前脏文件集合求交集；非空说明已有在途改动，该工作者降为只读 |

前两类是代理之间打架，第三类是代理与已有在途改动打架，代价最大，一律判为硬阻断。

### 不做边界的症状与最小修法

| 症状 | 最小修法 |
|---|---|
| 收尾时出现「文件已被另一个代理修改」 | 补齐缺失的禁触字段，并在提示词里点名该文件归谁 |
| 两个工作者的改动清单有交集 | 把范围拆到不同目录，或把其中一个降为只读、由协调者代为写入 |
| 工作区原有改动在收尾时不见了 | 派发前记录脏文件清单，任何工作者不得触碰清单内的路径 |

### 例外与权衡

- **只读与写入重叠**。多个工作者可以共享同一范围，前提是至多一个持有写权限，其余被显式标注为只读。判定规则：范围相同且都声明写权限即冲突；范围相同而写权限唯一即允许。裁决者是协调者，写权限在派发时授予，不在运行时争抢。
- **临时越界**。工作者发现边界切错了任务，例如改一个函数必然牵动范围外的调用点。允许它报告并停手，不得自行扩范围；协调者重新划界后二次派发。代价是重派一轮，换来的是边界声明始终可信。裁决者是协调者。
- **同文件分区追加**。多个工作者允许写同一文件的前提是各自只追加自己独立的区块（如同一份配置的不同键）。任何需要改动他人已写内容的诉求都按越界处理，交回协调者裁决。

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

范围：${authHandlerPath}/refresh*｜禁触：${authHandlerPath}/login*、${authHandlerPath}/logout*｜完成：`npm test -- refresh` 退出码为 0｜交接：改动文件清单 + 测试输出摘要

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
