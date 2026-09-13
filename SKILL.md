---
name: harness-creator
description: >-
  构建、审计并改进让 AI 编码代理可靠工作的 harness：AGENTS.md/CLAUDE.md
  指令文件、功能/状态跟踪、验证关卡、范围边界、引用式会话交接、CONTEXT.md 领域语言、
  ADR 决策记录、记忆持久化、上下文预算、工具权限安全以及多代理协调。当编码代理在跨会话中
  表现不可靠时使用本技能——忘记上下文、偏离范围、在测试通过前就声称"完成"，或每次会话的
  起始状态不一致——或在创建或评估 AGENTS.md、CLAUDE.md、feature_list.json、init.sh、
  progress.md、CONTEXT.md 或会话交接约定时使用。即使用户从未说出 "harness" 这个词，也应使用本技能。
license: MIT
---

# Harness Creator

使用本技能让仓库更便于编码代理启动工作、保持在范围内、验证成果并跨会话恢复。harness 应保持足够精简，确保代理真正遵循它。

不适用于模型选择、孤立的提示词调优、聊天 UI 设计或通用应用架构。

## 核心模型

每个有用的编码代理 harness 都包含五个子系统：

| 子系统 | 最小产物 | 用途 |
|---|---|---|
| 指令 | `AGENTS.md` 或 `CLAUDE.md`（路由 `CONTEXT.md` 与 ADR） | 启动路径、工作规则、完成定义 |
| 状态 | `feature_list.json`、`progress.md`（精简版） | 当前功能、状态、证据、下一步 |
| 验证 | `init.sh` 或 CI 门禁 | 声称完成前必须运行的检查；证据由机器承接 |
| 范围 | 功能依赖关系与完成标准 | 防止越界与半途而废的工作 |
| 生命周期 | 会话结束例程（更新状态文件 + 干净提交）；交接文档由用户按需生成，落 `.scratch/` | 让下一次会话可以重新启动 |

## 两种模式

harness 有两种状态治理模式。先用下面的信号探测，无法确定时默认 registry 模式：

**Registry 模式（默认，自包含）**：状态事实来源在仓库内——`feature_list.json` 注册表 + 精简 `progress.md`。适用于任意仓库、任意代理、无 issue tracker 的项目。

**Tracker 模式（Matt 工程流）**：状态与依赖由工单系统承接（本地或仓外，如 to-spec/to-tickets），仓库只保留两类长期资产——`CONTEXT.md`（领域语言，与代码互补）和 ADR（决策史，只增不删）；`.scratch/` 承载任务级材料（spec 草稿、交接文档），随任务或 worktree 删除。探测信号：存在 `CONTEXT.md`、ADR 目录或 `.scratch/`，或用户使用工单工作流。

两种模式共享同一骨架：`AGENTS.md` 路由、验证门禁、范围规则、引用式交接。区别只在状态事实来源的位置。

## 第一步

1. 检查已有内容：指令文件、功能/状态文件、验证命令、文档、`CONTEXT.md`/ADR/`.scratch`、包清单。→ 输出：现有产物清单。
2. 判定模式：有探测信号按信号判；无信号（既无 `feature_list.json` 也无 `CONTEXT.md`/ADR/工单痕迹）时 🔴 CHECKPOINT——询问用户这个仓库用来做什么（产品形态、协作方式、是否有工单系统），据此判定模式，再生成任何文件。→ 输出：模式判定结论。
3. 判定 tracker 模式即默认用户已自行运行 `setup-matt-pocock-skills`：本技能不调用、不询问安装、不提供仓内 tracker 替代。先落地两模式共有骨架（AGENTS.md 路由、`init.sh` 门禁、`.scratch` 约定），状态源绑定工单置于最后——可探测（见第 1 步）则直接绑定，暂未探测到则挂起并提示用户先运行 setup、完成后再补。其余缺失上下文仅在无法安全推断时询问。
4. 优先采用最小化 harness。仅当用户的问题涉及跨会话记忆、工具权限安全、多代理协调或基准测试时，才加载对应参考文档并添加相应产物；除此之外一律不添加。→ 输出：本轮要创建的产物清单。

## 常见任务

### 创建 harness

在本地仓库上工作时使用随附脚本：

```bash
node skills/harness-creator/scripts/create-harness.mjs --target /path/to/project
```

🔴 CHECKPOINT：写盘前先向用户展示将创建/跳过的产物清单，确认后再执行。

选项：

- `--agent-file CLAUDE.md` 用于面向 Claude 的项目。
- `--package-manager npm|pnpm|yarn|bun` 用于自动检测结果不正确时。
- `--commands "cmd one,cmd two"` 用于自定义验证命令。
- `--force` 覆盖已存在文件。🔴 CHECKPOINT：使用 `--force` 前**必须**获得用户明确批准，并在执行前列出将被覆盖的文件清单。

脚本创建 registry 模式最小骨架。tracker 模式改以 `CONTEXT.md`、`docs/adr/`、`.scratch/` 为仓内长期资产，状态指向工单系统，不强制 `feature_list.json`/`progress.md`。

**AGENTS.md 章节级所有权**（tracker 模式与 matt setup 共存时）：matt 拥有 `## Agent skills` 块与 `docs/agents/*`；harness 拥有其余章节（启动工作流、工作规则、必需产物、完成定义、会话结束、验证命令、升级处理）。AGENTS.md 已存在时**合并而非跳过或覆写**：保留现有内容，只追加缺失的本方章节；CONTEXT.md/ADR 路由两处出现属互补（matt 定义布局，harness 定义阅读时机），不构成双写。

输入：目标仓库路径、（可选）包管理器与验证命令。输出：四个产物 + 创建说明（含占位条目替换指引）。

### 审计现有 harness

运行：

```bash
node skills/harness-creator/scripts/validate-harness.mjs --target /path/to/project
```

报告五子系统得分、最低分子系统与最能提升可靠性的前 2-3 项改动。打分对两模式与中英文产物同样适用（benchmark 自检含英文 tracker 夹具常驻回归）。最低分只是候选瓶颈；先用失败记录或任务结果确认因果，再改。

输入：目标仓库。输出：五子系统得分、候选瓶颈、前 2-3 项改动。

### 生成报告

当用户需要可分享的评估结果时使用：

```bash
node skills/harness-creator/scripts/render-assessment-html.mjs --target /path/to/project
node skills/harness-creator/scripts/run-benchmark.mjs --target /path/to/project --html /path/to/report.html
```

需明确说明这是一种结构性基准测试：自检先搭一次性 harness 验证脚本端到端可用，再对目标与 eval 覆盖率评分；真实有效性仍需前后对照代理会话验证。

输入：目标仓库与报告路径。输出：JSON/HTML 报告与结构性结论。

## 何时阅读参考文档

仅加载解决当前问题所需的参考文档：

- 跨会话记忆：[Memory Persistence](references/memory-persistence-pattern.md)
- 可复用工作流（技能形式）：[Skill Runtime](references/skill-runtime-pattern.md)
- 权限、工具、并发：[Tool Registry & Safety](references/tool-registry-pattern.md)
- 上下文预算与渐进式披露：[Context Engineering](references/context-engineering-pattern.md)
- 任务委派与并行代理：[Multi-Agent Coordination](references/multi-agent-pattern.md)
- 钩子、启动、长时间运行的工作：[Lifecycle & Bootstrap](references/lifecycle-bootstrap-pattern.md)
- 不易察觉的失败模式：[Gotchas](references/gotchas.md)
- 整理仓库（清账，用户显式触发）：[Housekeeping](references/housekeeping-pattern.md)

## 异常与边界条件

创建与审计中的异常处理（已有文件、栈识别失败、低分、模式信号矛盾、无权限、无 Node、自检失败、基线失败）见 [Failure Modes](references/failure-modes.md)。原则：先告知用户再执行，绝不静默跳过或静默降级。

## 设计规则

- 根指令文件保持简短：只做路由与不变量，而不是完整手册。
- `CONTEXT.md` 承载领域语言：与代码互补的规范化用语，不重复代码已表达的内容。
- 决策进 ADR，不进进度日志；进度日志只留当前状态、证据、阻塞、下一步。
- 项目文档（`design.md`、`docs/` 等）纳入治理：可执行约束进门禁，术语进 `CONTEXT.md`，决策进 ADR，意图类活文档指定 owner；与代码重复视为双写，过时即归档。
- 任务级材料（spec 草稿、调研笔记）放 `.scratch/`，任务完成即删除。
- 交接文档由用户按需生成（matt handoff 或等价技能），代理不主动创建；格式引用而不复制——这是无 handoff 技能时的兜底原则。
- 验证命令必须明确且可直接运行。
- 状态文件追加/更新，不依赖聊天历史。
- 整理（清账）只作用于状态落点：ADR 与 `CONTEXT.md` 永不清，删除前必经 🔴 CHECKPOINT 列清单获批准。

## 反例黑名单

harness 设计中不要做的事；交付前对照一次。

产物的合法落点只有五个：`.scratch/`（临时材料）、`CONTEXT.md`（领域语言）、ADR（决策）、`init.sh`/CI（可执行约束）、工单（状态与依赖）。

| # | 反模式 | 为什么不要做 | 替代做法 |
|---|---|---|---|
| 1 | 状态双写：同一事实同时记在 `feature_list.json`、`progress.md`、交接文档多处 | 双写必然漂移，代理读到互相矛盾的材料 | 每个事实只有一个落点：状态→`feature_list.json`，证据→`progress.md`/CI，决策→ADR，文件变更→git |
| 2 | 把会话交接长期留在仓库默认上下文（如仓内 `session-handoff.md` 常驻） | 过期交接成为噪声事实来源 | 引用式交接到 `.scratch/` 或临时目录：只写增量信息，用路径或 URL 引用 spec、ADR、提交与 diff，不复制其内容；任务完成即删 |
| 3 | 无证据标记功能完成 | "声称完成但测试没过"是要防的头号失败 | `evidence` 必填：命令+结果摘要或 CI 链接；无证据不得标 `done` |
| 4 | 把项目事实写进本 skill 或让 skill 引用特定项目 | 混入项目事实即腐化 | 项目事实只放目标仓库的 `AGENTS.md`/`CONTEXT.md`/ADR |
| 5 | 无多代理所有权边界时同时推进多个功能 | 越界与半途工作的主要来源 | 一次一个活动功能；多代理必须先定义所有权边界 |
| 6 | 为通过 `validate` 审计堆砌关键词 | 审计只看结构化行，堆词无效 | 真实落地 harness，审计只是体检不是目标 |
| 7 | 静默覆盖已有文件、静默跳过异常 | 破坏用户工作且无法追溯 | 默认跳过+告知；`--force` 走 🔴 CHECKPOINT；异常按 failure-modes 表先告知再处理 |
| 8 | 把文字说明当约束的唯一载体 | 代理可能没读到或误解说明 | 能写成测试/Schema/门禁的约束一律进 `init.sh`/CI，文字只是指针 |
| 9 | 引入产物落在五个落点之外的第三方 skill | 制造第六个事实来源；他人 skill 无法改造 | 产物能落进五个落点之一才引入，否则拒绝——没有例外 |

## 交付清单

一个可用的最小化 harness 应为目标项目留下：

**Registry 模式（基础）**

- [ ] `AGENTS.md` 或 `CLAUDE.md`（路由状态产物与 `CONTEXT.md`/ADR）
- [ ] `feature_list.json`
- [ ] `progress.md`（精简版：当前状态、证据、阻塞、下一步）
- [ ] `init.sh`
- [ ] 交接落点约定（`.scratch/handoff.md`）：用户按需生成，代理启动时若存在必读

**Tracker 模式（附加或替代）**

- [ ] `CONTEXT.md`（领域语言）
- [ ] `docs/adr/`（决策记录）
- [ ] `.scratch/`（任务级暂存区，随任务删除）
- [ ] 状态与依赖指向工单系统（本地或仓外）
- [ ] CI 或 `init.sh` 机器门禁承接完成证据

如果无法创建文件，则改为提供确切的文件内容与命令。
