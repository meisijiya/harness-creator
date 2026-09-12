# harness-creator

一个用于围绕 AI 编码代理构建与审计 harness 的紧凑型技能。

它帮助仓库为代理提供五样必需品：指令、状态、验证、范围边界与生命周期交接。

## Harness 哲学

一句话：**让每个事实有且只有一个家，让代理在正确的时间只看到仍然可信的材料。**

### 状态产物：五个落点

任何产物（无论本技能生成还是第三方 skill 产生）的合法落点只有五个：

| 落点 | 内容 | 生命周期 |
|---|---|---|
| `.scratch/` | spec 草稿、调研笔记、交接文档 | 临时：任务完成即删（随 worktree） |
| `CONTEXT.md` | 领域语言：与代码互补的规范用语，不重复代码 | 长期：持续更新 |
| ADR（`docs/adr/`） | 决策及理由 | 长期：只增不删 |
| `init.sh` / CI | 可执行约束（测试、Schema、门禁） | 长期：违反即报错 |
| 工单 / `feature_list.json` | 状态与依赖 | tracker 模式用工单；registry 模式用仓内注册表 |

第三方 skill 的产物落不进五个落点之一，**拒绝引入**——他人的 skill 无法改造，只能选或拒。

### 文档产物：项目文档层

`design.md`、`docs/` 等是合法资产，但必须有生命周期：

- 经 `AGENTS.md` 路由**按需读取**，不进默认上下文（更多上下文 ≠ 更多理解）
- 按性质拆分：可执行约束 → 门禁；术语 → `CONTEXT.md`；决策 → ADR
- 意图/体验类活文档（代码表达不了的内容）指定 owner，持续更新
- 与代码重复视为双写（漂移源）；过时即归档

路线组合：任务 spec 临时化（Ephemeral）+ 长期约束可执行化（Executable）+ 其余材料归档按需读。

## 安装

```bash
npx skills add walkinglabs/learn-harness-engineering --skill harness-creator
```

或将 `skills/harness-creator/` 复制到你的技能路径中。

## 使用

```bash
node skills/harness-creator/scripts/create-harness.mjs --target /path/to/project
node skills/harness-creator/scripts/validate-harness.mjs --target /path/to/project
node skills/harness-creator/scripts/run-benchmark.mjs --target /path/to/project --html /path/to/report.html
```

这些脚本仅使用 Node.js 内置模块。将技能目录复制到其他仓库后即可直接运行。

## 它会创建什么

- `AGENTS.md` 或 `CLAUDE.md`
- `feature_list.json`
- `progress.md`（精简版：当前状态、证据、阻塞、下一步）
- `init.sh`

会话交接是约定而非仓库文件：引用式交接文档写在 `.scratch/handoff.md` 或临时目录。tracker 模式（`CONTEXT.md` + ADR + issue tracker 承接状态）见 SKILL.md 的"两种模式"一节。

`create-harness.mjs` 可检测常见的项目类型与包管理器。在基础验证命令层面支持 Node/npm/pnpm/yarn/bun、Python、Go、Rust、Maven、Gradle 和 .NET。

## 它会检查什么

`validate-harness.mjs` 对五个 harness 子系统进行评分：

1. 指令
2. 状态
3. 验证
4. 范围
5. 生命周期

得分是结构性的。它告诉你 harness 是否存在且自洽；不能替代真实的前后对照代理会话测试。

## 技能生态搭配

harness-creator 管"产物落在哪、代理怎么启动、完成怎么验证"；怎么访谈、怎么拆工单、怎么写代码，交给专业 skill。

### 主体系：[mattpocock/skills](https://github.com/mattpocock/skills)

tracker 模式的默认搭配：

| 环节 | 技能 | 产物落点 |
|---|---|---|
| 初始化工单基础设施 | `setup-matt-pocock-skills` | issue tracker、标签、领域文档布局 |
| 需求访谈与领域建模 | `grill-me` / `grill-with-docs` | `CONTEXT.md` + ADR |
| spec 与拆单 | `to-spec` / `to-tickets` | 工单（含 blocking 边） |
| 实现与验证 | `implement` / `tdd` / `code-review` | 代码 + CI 证据 |
| 会话交接 | `handoff` | `.scratch/handoff.md`（引用式） |
| 大块工作规划 | `wayfinder` | 工单决策地图 |

无信号的新仓库：harness-creator 先问"仓库用来做什么"判定模式；判 tracker 则先调 `setup-matt-pocock-skills` 初始化工单基础设施，再回到本技能继续 harness 初始化。

### 补充：[addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)

经五落点审查后的筛选结论：

- **可用（14）**：`constraint-driven-development`（约束转门禁，最契合）、`ci-cd-and-automation`、`security-and-hardening`、`observability-and-instrumentation`、`shipping-and-launch`、`browser-testing-with-devtools`、`frontend-ui-engineering`、`api-and-interface-design`、`incremental-implementation`、`code-simplification`、`source-driven-development`、`deprecation-and-migration`、`git-workflow-and-versioning`、`doubt-driven-development`（高风险场景）
- **改造后用（2）**：`spec-driven-development`（PRD 必须落 `.scratch`，不留仓内）、`idea-refine`（限概念萌芽期，进入设计即切 grill）
- **不引入（8）**：`using-agent-skills`、`interview-me`、`planning-and-task-breakdown`、`test-driven-development`、`context-engineering`、`code-review-and-quality`、`debugging-and-error-recovery`、`documentation-and-adrs`——与 matt 体系或本技能职责重复，或理念冲突（测试配额 vs 测试克制、行内文档标准 vs 代码即文档）

## 状态

- [x] 最小化 harness 脚手架
- [x] 五子系统验证
- [x] HTML 评估报告
- [x] 结构性基准报告
- [x] 10+ 个评估用例（含 tracker 模式集成）
- [x] 双模式治理：registry（仓内注册表）与 tracker（工单驱动，CONTEXT.md + ADR）
- [x] 常见技术栈的通用验证检测
- [ ] 可选的真实前后对照代理会话回放

## 文件

```text
harness-creator/
├── SKILL.md
├── test-prompts.json
├── agents/openai.yaml
├── scripts/
│   ├── create-harness.mjs
│   ├── validate-harness.mjs
│   ├── render-assessment-html.mjs
│   ├── run-benchmark.mjs
│   └── lib/harness-utils.mjs
├── templates/
│   ├── agents.md
│   ├── feature-list.json
│   ├── feature-list.schema.json
│   ├── init.sh
│   └── progress.md
├── references/
└── evals/evals.json
```

## 边界

本技能用于 harness 工程，而非模型选择、单纯的提示词调优或应用架构。项目特定的事实应保留在目标仓库中。
