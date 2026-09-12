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
| 生命周期 | 引用式交接约定（`.scratch/handoff.md` 或临时目录）、会话结束例程 | 让下一次会话可以重新启动 |

## 两种模式

harness 有两种状态治理模式。先用下面的信号探测，无法确定时默认 registry 模式：

**Registry 模式（默认，自包含）**：状态事实来源在仓库内——`feature_list.json` 注册表 + 精简 `progress.md`。适用于任意仓库、任意代理、无 issue tracker 的项目。

**Tracker 模式（Matt 工程流）**：状态与依赖由 issue tracker 承接（如 to-spec/to-tickets），仓库只保留两类长期资产——`CONTEXT.md`（领域语言，与代码互补）和 ADR（决策史，只增不删）；`.scratch/` 承载任务级材料（spec 草稿、交接文档），随任务或 worktree 删除。探测信号：存在 `CONTEXT.md`、ADR 目录或 `.scratch/`，或用户使用工单工作流。

两种模式共享同一骨架：`AGENTS.md` 路由、验证门禁、范围规则、引用式交接。区别只在状态事实来源的位置。

## 第一步

1. 检查已有内容：指令文件、功能/状态文件、验证命令、文档、`CONTEXT.md`/ADR/`.scratch`、包清单。→ 输出：现有产物清单。
2. 判定模式：有探测信号按信号判；无信号（既无 `feature_list.json` 也无 `CONTEXT.md`/ADR/工单痕迹）时 🔴 CHECKPOINT——询问用户这个仓库用来做什么（产品形态、协作方式、是否有工单系统），据此判定模式，再生成任何文件。→ 输出：模式判定结论。
3. 判定 tracker 模式且仓库尚无工单基础设施：先调用 `setup-matt-pocock-skills`（假设已安装）初始化工单基础设施（issue tracker、标签、领域文档布局），再回到本技能继续；未安装则提示安装或经同意回退 registry 模式。其余缺失上下文仅在无法安全推断时询问。
4. 优先采用最小化 harness。仅当用户的问题涉及跨会话记忆、工具权限安全、多代理协调或基准测试时，才加载对应参考文档并添加相应产物；除此之外一律不添加。→ 输出：本轮要创建的产物清单。

## 常见任务

### 创建 harness

在本地仓库上工作时使用随附脚本：

```bash
node skills/harness-creator/scripts/create-harness.mjs --target /path/to/project
```

选项：

- `--agent-file CLAUDE.md` 用于面向 Claude 的项目。
- `--package-manager npm|pnpm|yarn|bun` 用于自动检测结果不正确时。
- `--commands "cmd one,cmd two"` 用于自定义验证命令。
- `--force` 覆盖已存在文件。🔴 CHECKPOINT：使用 `--force` 前**必须**获得用户明确批准，并在执行前列出将被覆盖的文件清单。

脚本创建 registry 模式的最小骨架。tracker 模式在其基础上：删除 `feature_list.json`/`progress.md` 的强制要求，改为建立 `CONTEXT.md`、`docs/adr/` 与 `.scratch/`，并把状态跟踪指向 issue tracker。

输入：目标仓库路径、（可选）包管理器与验证命令。输出：四个产物 + 创建说明（含占位条目替换指引）。

### 审计现有 harness

运行：

```bash
node skills/harness-creator/scripts/validate-harness.mjs --target /path/to/project
```

报告五个子系统的得分、得分最低的领域，以及最能提升可靠性的前 2-3 项改动。打分对两种模式与中英文产物同样适用（Matt 技能生态的英文产出可直接审计，benchmark 自检含英文 tracker 夹具常驻回归）。将最低分视为候选瓶颈；在声称因果关系之前，先用失败记录、日志或任务结果加以确认。

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

## 异常与边界条件

流程假设环境理想，实操必有异常。按下表处理，先告知用户再执行，绝不静默跳过。

| 触发条件 | 一线修复 | 仍失败兜底 |
|---|---|---|
| `create-harness` 目标已有同名文件 | 默认跳过并告知用户 | 🔴 批准后才用 `--force`，先列覆盖清单 |
| 无法识别项目栈或包管理器 | 用 `--package-manager` 与 `--commands` 显式指定 | 退化为占位验证命令，交付说明中标记必须替换 |
| `validate` 总分 < 70 | 最低分子系统作为候选瓶颈，给前 2-3 项改动 | 先用失败记录确认因果再改；不堆关键词刷分 |
| 模式探测信号矛盾或缺失 | 按信号重判：`CONTEXT.md`/ADR/`.scratch`/issue tracker | 转「第一步」第 2 步的 🔴 CHECKPOINT |
| 无法创建文件（权限/只读） | 改为输出确切文件内容与命令 | 全部以文本交付并标注目标路径 |
| 运行环境无 Node，脚本不可用 | 按 `templates/` 手工创建四个产物 | 交付模板内容与手工验证命令 |
| `run-benchmark` 自检 FAIL | 视为 skill 自身损坏，先修脚本再交付 | 不交付未通过自检的模板改动 |
| `init.sh` 基线验证失败 | 先修复基线，再添加新工作范围 | 标记需人工评审，不叠加新功能 |

## 设计规则

正向规则如下；"不要做什么"见「反例黑名单」。

- 根指令文件保持简短：只做路由与不变量，而不是完整手册。
- `CONTEXT.md` 承载领域语言：与代码互补的规范化用语，不重复代码已表达的内容。
- 决策进 ADR，不进进度日志；进度日志只留当前状态、证据、阻塞、下一步。
- 项目文档（`design.md`、`docs/` 等）纳入治理：可执行约束进门禁，术语进 `CONTEXT.md`，决策进 ADR，意图类活文档指定 owner；与代码重复视为双写，过时即归档。
- 任务级材料（spec 草稿、调研笔记）放 `.scratch/`，任务完成即删除。
- 验证命令必须明确且可直接运行。
- 状态文件追加/更新，不依赖聊天历史。

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
| 7 | 静默覆盖已有文件、静默跳过异常 | 破坏用户工作且无法追溯 | 默认跳过+告知；`--force` 走 🔴 CHECKPOINT；异常按上表先告知再处理 |
| 8 | 把文字说明当约束的唯一载体 | 代理可能没读到或误解说明 | 能写成测试/Schema/门禁的约束一律进 `init.sh`/CI，文字只是指针 |
| 9 | 引入产物落在五个落点之外的第三方 skill | 制造第六个事实来源；他人 skill 无法改造 | 产物能落进五个落点之一才引入，否则拒绝——没有例外 |

## 交付清单

一个可用的最小化 harness 应为目标项目留下：

**Registry 模式（基础）**

- [ ] `AGENTS.md` 或 `CLAUDE.md`（路由状态产物与 `CONTEXT.md`/ADR）
- [ ] `feature_list.json`
- [ ] `progress.md`（精简版：当前状态、证据、阻塞、下一步）
- [ ] `init.sh`
- [ ] 引用式交接约定（`.scratch/handoff.md`，按需生成）

**Tracker 模式（附加或替代）**

- [ ] `CONTEXT.md`（领域语言）
- [ ] `docs/adr/`（决策记录）
- [ ] `.scratch/`（任务级暂存区，随任务删除）
- [ ] 状态与依赖指向 issue tracker（如 to-spec / to-tickets 工作流）
- [ ] CI 或 `init.sh` 机器门禁承接完成证据

如果无法创建文件，则改为提供确切的文件内容与命令。
