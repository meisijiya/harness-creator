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

让仓库更便于编码代理启动工作、保持在范围内、验证成果并跨会话恢复；harness 保持精简，确保被真正遵循。

不适用于模型选择、孤立的提示词调优、聊天 UI 设计或通用应用架构。

## 核心模型

每个 harness 都包含五个子系统：

| 子系统 | 最小产物 | 用途 |
|---|---|---|
| 指令 | `AGENTS.md` 或 `CLAUDE.md`（路由 `CONTEXT.md` 与 ADR） | 启动路径、工作规则、完成定义 |
| 状态 | `feature_list.json`、`progress.md`（精简版） | 当前功能、状态、证据、下一步 |
| 验证 | `init.sh` 或 CI 门禁 | 声称完成前必须运行的检查；证据由机器承接 |
| 范围 | 功能依赖关系与完成标准 | 防止越界与半途而废的工作 |
| 生命周期 | 会话结束例程（更新状态 + 干净提交）；交接文档按需生成 | 让下一次会话可以重新启动 |

## 两种模式

两种状态治理模式，按下表信号探测。**无信号不得自行默认**（见「第一步」第 2 步）：

**Registry 模式（自包含）**：状态事实来源在仓库内——`feature_list.json` 注册表 + 精简 `progress.md`。适用于无 issue tracker 的任意仓库与代理。

**Tracker 模式（Matt 工程流）**：状态与依赖由工单系统承接，仓库只保留 `CONTEXT.md`（领域语言）与 ADR（决策史，只增不删），二者均由上游领域建模 skill **延迟创建**；`.scratch/` 承载任务级材料。探测信号：matt `docs/agents/`、`CONTEXT.md`、ADR 目录，或用户使用工单工作流——`.scratch/` **不算**信号。

两模式共享骨架：`AGENTS.md` 路由、验证门禁、范围规则、引用式交接；区别只在状态来源位置。

## 第一步

1. 检查已有内容：指令文件、功能/状态文件、验证命令、文档、`CONTEXT.md`/ADR/matt `docs/agents/`、包清单。→ 输出：现有产物清单。
2. 判定模式：**有信号**按信号判；**无信号** → 🔴 CHECKPOINT 询问仓库用途（用途、协作、有无工单），**得到答复前不写盘**；**已问过**未获答复才回落 registry；「无法询问」≠「用户未答复」，此时停住写出问题；信号矛盾按最强信号判。→ 输出：模式判定结论。
3. 判定 tracker 即默认用户已运行上游初始化 skill：不调用、不询问安装、不提供仓内替代。matt 名下产物不代建，只落本方骨架，缺失项列待办并指引安装。→ 输出：本轮产物清单。
4. 优先最小化：仅当涉及跨会话记忆、权限安全、多代理协调或基准测试时，才加载对应参考并加产物。其余缺失上下文可自行推断，**🔴 CHECKPOINT 除外**。
5. 追踪对齐（一次性）：写盘前运行 `scripts/check-git-tracking.mjs`；🔴 CHECKPOINT 只问一次，`.gitignore` 命中即判「不跟踪」，结论落 AGENTS.md，其余 skill 只读不问。→ 输出：追踪策略表。

## 常见任务

### 创建 harness

使用随附脚本：

```bash
node skills/harness-creator/scripts/create-harness.mjs --target /path/to/project --mode registry|tracker
```

🔴 CHECKPOINT：先跑 `--dry-run`，把将创建/跳过的产物清单展示给用户，确认后再真正执行。

选项：`--agent-file CLAUDE.md`（面向 Claude 的项目）、`--package-manager`、`--commands "a,b"`；其余见 `--help`。`--force` 覆盖已存在文件——🔴 CHECKPOINT：使用前**必须**获批并列出被覆盖文件；含第三方块的文件一律不用。

模式必须显式：无信号且未传 `--mode` 时脚本拒写，不静默默认。

**与 matt setup 共存**：单一写入者分区——matt 拥有 `docs/agents/*`、`## Agent skills`、`CONTEXT.md`/`docs/adr/`。**AGENTS.md 章节以 `templates/agents.md` 为唯一来源**（审计不校验结构）；已存在时脚本只报告缺失章节、不写盘，合并由代理执行并保留第三方块、不另建等价副本。分区表见 [Matt Coexistence](references/matt-coexistence.md)。

输出：产物清单 + 创建说明。

### 审计现有 harness

运行：

```bash
node skills/harness-creator/scripts/validate-harness.mjs --target /path/to/project
```

报告五子系统得分与前 2-3 项改动建议；两模式与中英文产物同标准。最低分只是候选瓶颈，先确认因果再改。

### 生成报告

需要可分享结果时使用：

```bash
node skills/harness-creator/scripts/render-assessment-html.mjs --target /path/to/project
node skills/harness-creator/scripts/run-benchmark.mjs --target /path/to/project --html /path/to/report.html
```

这是结构性基准测试（自检证明脚本可跑通，非有效性证明）；真实有效性靠前后对照会话。输出：JSON/HTML 报告。

## 何时阅读参考文档

仅加载解决当前问题所需的参考文档：

- 跨会话记忆：`references/memory-persistence-pattern.md`
- 可复用工作流（技能形式）：`references/skill-runtime-pattern.md`
- 权限、工具、并发：`references/tool-registry-pattern.md`
- 上下文预算与渐进式披露：`references/context-engineering-pattern.md`
- 任务委派与并行代理：`references/multi-agent-pattern.md`
- 钩子、启动、长时间运行的工作：`references/lifecycle-bootstrap-pattern.md`
- 不易察觉的失败模式：`references/gotchas.md`
- 会话收尾（收尾意图，**仅本会话产出**）：`references/session-wrapup-pattern.md`，扫描器 `--session-only`
- 整理仓库（**全仓**清账）：`references/housekeeping-pattern.md`，扫描器默认模式
- 非工单模式的任务推进（条目即工单）：`references/task-advancement-pattern.md`
- 上游联动（清单、调用模式、插拔与维护）：`references/upstream-interlock.md`；matt 分区所有权见 `references/matt-coexistence.md`
- 产物落点的 git 跟踪对齐（一次性询问）：`references/git-tracking-alignment.md`

## 异常与边界条件

创建与审计中的异常见 [Failure Modes](references/failure-modes.md)。以下任一情况**先读它再动手**：已有同名文件或第三方块、模式信号矛盾或缺失、追踪报 `stray`/`unknown`、第三方产物出落点、`validate` 低于阈值、环境无 Node。**第三方工具存在不构成模式信号**——无信号即走第 2 步的 🔴 CHECKPOINT。原则：一般异常先告知再执行；**🔴 CHECKPOINT 必须先获批**，能推断不是跳过理由，无法询问就停在原地写出问题。绝不静默跳过或降级。

## 设计规则

- 根指令文件保持简短：只做路由与不变量，不做完整手册。
- `CONTEXT.md` 承载领域语言：与代码互补、不重复代码已表达的内容；格式归上游，本技能引用不复制。
- 决策进 ADR，不进进度日志；进度日志只留当前状态、证据、阻塞、下一步。
- 项目文档（`design.md`、`docs/`）纳入治理：约束进门禁、术语进 `CONTEXT.md`、决策进 ADR、活文档指定 owner；与代码重复视为双写，过时即归档。
- 任务级材料（spec 草稿、调研笔记）放 `.scratch/`，任务完成或 worktree 关闭即删。
- 交接文档由用户按需生成（上游交接 skill 或等价技能），代理不主动创建；格式引用而不复制。交接是上下文、不是待办队列：用户未显式推进时不续跑原任务。
- 验证命令必须明确且可直接运行。
- 状态文件追加/更新，不依赖聊天历史。
- 三种收敛别混：**收尾**仅本会话产出，**整理**清全仓状态落点，**优化**才全仓审计。ADR、`CONTEXT.md` 永不清，删除前必经 🔴 CHECKPOINT 列清单获批准。

## 反例黑名单

harness 设计中不要做的事；交付前对照一次。

产物的合法落点只有五个：`.scratch/`（临时材料）、`CONTEXT.md`（领域语言）、ADR（决策）、`init.sh`/CI（可执行约束）、工单（状态与依赖）。

| # | 反模式 | 为什么不要做 | 替代做法 |
|---|---|---|---|
| 1 | 状态双写：同一事实记在注册表、进度、交接文档多处 | 双写必然漂移，代理读到互相矛盾的材料 | 每个事实只有一个落点：状态→注册表，证据→`progress.md`/CI，决策→ADR，变更→git |
| 2 | 把会话交接长期留在仓库默认上下文（如仓内 `session-handoff.md` 常驻） | 过期交接成为噪声事实来源 | 引用式交接到 `.scratch/` 或临时目录：只写增量，用路径/URL 引用 spec、ADR、提交与 diff，不复制内容；完成即删 |
| 3 | 无证据标记功能完成 | "声称完成但测试没过"是头号失败 | `evidence` 必填：命令+结果摘要或 CI 链接；无证据不得标 `done` |
| 4 | 把项目事实写进本 skill 或让 skill 引用特定项目 | 混入项目事实即腐化 | 项目事实只放目标仓库的 `AGENTS.md`/`CONTEXT.md`/ADR |
| 5 | 无多代理所有权边界时同时推进多个功能 | 越界与半途工作的主要来源 | 一次一个活动功能；多代理必须先定义所有权边界 |
| 6 | 为通过 `validate` 审计堆砌关键词 | 审计只看结构化行，堆词无效 | 真实落地 harness，审计只是体检不是目标 |
| 7 | 静默覆盖已有文件、静默跳过异常 | 破坏用户工作且无法追溯 | 默认跳过+告知；`--force` 走 🔴 CHECKPOINT；异常按 failure-modes 处理 |
| 8 | 把文字说明当约束的唯一载体 | 代理可能没读到或误解说明 | 能写成测试/Schema/门禁的约束一律进 `init.sh`/CI，文字只是指针 |
| 9 | 引入产物落在五个落点之外的第三方 skill | 制造第六个事实来源；他人 skill 无法改造 | 先路由回落点；skill 自带硬约束时**受控放行**（放行不治理、登记豁免、用户裁决、追踪有结论），其余拒绝 |
| 10 | 让第三方 skill 自行询问产物追踪策略 | 重复询问，结论分散成第二事实源 | 本技能独占询问一次；结论落 AGENTS.md，其余 skill 只读不问 |

## 交付清单

最小化 harness 应为目标项目留下：

**Registry 模式（基础）**

- [ ] `AGENTS.md` 或 `CLAUDE.md`（含仓库结构与一次性追踪策略，路由状态产物与 `CONTEXT.md`/ADR）
- [ ] `feature_list.json` + `progress.md`（精简版）
- [ ] `init.sh`
- [ ] 交接落点约定（`.scratch/handoff.md`，启动时若存在必读）

**Tracker 模式（附加或替代）**

- [ ] `CONTEXT.md`（领域语言）、`docs/adr/`（决策记录）——matt 延迟创建，不预建
- [ ] `.scratch/`（任务级暂存区，随任务删除）——约定文档化，不预建空目录
- [ ] 状态与依赖指向工单系统（本地或仓外）
- [ ] CI 或 `init.sh` 机器门禁承接完成证据

无法创建文件时，改为提供确切的文件内容与命令。
