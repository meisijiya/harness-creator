# harness-creator

一个用于围绕 AI 编码代理构建与审计 harness 的紧凑型技能。

它帮助仓库为代理提供三样必需品：指令、验证与范围边界。**状态与生命周期不由本技能提供**——它们委派给已安装的工程 skill（见「边界」）。

## Harness 哲学

一句话：**让每个事实有且只有一个家，让代理在正确的时间只看到仍然可信的材料。**

### 三个子系统

| 子系统 | 最小产物 | 用途 |
|---|---|---|
| 指令 | `AGENTS.md` 或 `CLAUDE.md` | 启动路径、工作规则、完成定义、承接方指向 |
| 验证 | `init.sh` 或已文档化的命令 | 声称完成前必须运行的检查 |
| 范围 | 工单的依赖/阻塞边与完成标准 | 防止越界与半途而废的工作 |

**状态与生命周期不在表里，这是刻意的。** 上游把两者算作 harness 子系统，本技能的做法是**委派**：状态与阻塞边交给 `to-tickets`，会话交接交给 `handoff`。因此本技能既不落这两类产物，**也不为它们指定位置**——承接方的落点会随版本与变体变化（实测：`handoff` 上游说写 OS 临时目录，本机已装版说写 `docs/handoff-<timestamp>.md`，上游另有 `claude-handoff` 变体），写死必然过期；评估器同样不给它们打分——否则一个委派正确的仓库会被判成坏仓库。

**代码即文档**：代码能表达的事实以代码为唯一载体——业务代码不「归位」、随提交走；只有代码表达不了的内容才需要落到长期产物里。

## 边界：串接，不代做

本技能只做 harness 该做的事。需求对齐、规格、拆分、实现、测试、审查、交接这些**工程环节**由已安装的工程 skill 承担，本技能**不代为发起、不代为执行**，也不为它们的产物指定位置。

承接方是**具名**的，不是"某个工程 skill"：

- **状态与阻塞边** → `to-tickets`：把工作拆成 tracer-bullet 工单，每条自带阻塞边；发布到已配置的 tracker（GitHub / GitLab issues，或仓内本地 markdown）。
- **会话交接** → `handoff`：产物位置与格式由它自己决定，本技能不指定、不代建。
- **共同前置** → `/setup-matt-pocock-skills`：一次性配置 tracker（写 `docs/agents/issue-tracker.md`、`docs/agents/domain.md`，并往指令文件追加 `## Agent skills` 块）。未配置前，状态能力对目标仓库尚不可达。

- **不让代理主动扩范围**：不得因本技能而主动开启与 harness 无关的工作——那会与其他 skill 争抢触发时机，导致系统混乱。
- **同一事实只问一次**：属别的 skill 管辖的问题交由它问。
- **只做用户已对齐的事**：用户未陈述的项目事实一律留空待补，不由技术栈推断代填。

整条边界**写进了生成器自己的 `--help`**，也写进了每个目标仓库的 `AGENTS.md`：跑一次 `--help` 即可核对，不依赖本文。

## 安装

```bash
# 安装（推荐）
npx skills add meisijiya/harness-creator --skill harness-creator

# 升级
npx skills update harness-creator

# 卸载
npx skills remove harness-creator
```

`npx skills add` 会自动探测运行时并把技能放进对应目录。手动安装时，把 `skills/harness-creator/` 复制到所用运行时的技能目录：

| 运行时 | 技能目录 |
|---|---|
| 通用（Agent Skills 标准） | `~/.agents/skills/` |
| Claude Code | `~/.claude/skills/` |

其他 skills-compatible 运行时（Codex、Cursor、OpenClaw、Hermes、Gemini CLI、OpenCode 等）各有自己的技能目录，按其文档指定的路径放置即可。

## 使用

安装后，`harness-creator` 位于所用运行时的技能目录（见上表），例如 `~/.agents/skills/harness-creator/`。

```bash
# 从仓库根运行：使用仓库内的 scripts/
node scripts/create-harness.mjs --target /path/to/project --dry-run
node scripts/create-harness.mjs --target /path/to/project
node scripts/validate-harness.mjs --target /path/to/project
node scripts/run-benchmark.mjs --target /path/to/project --html /path/to/report.html
node scripts/render-assessment-html.mjs --target /path/to/project

# 从技能目录运行：使用已安装的 scripts/
node ~/.agents/skills/harness-creator/scripts/create-harness.mjs --target /path/to/project
node ~/.agents/skills/harness-creator/scripts/validate-harness.mjs --target /path/to/project
```

这些脚本仅使用 Node.js 内置模块，不需要额外安装依赖。

### 写入前的闸门：先预演再落地

`create-harness.mjs` 是唯一会往目标仓库写文件的脚本，它有一道**机械**闸门——不靠提示词约束，靠不写盘：

`--dry-run` 打印真写将要执行的那份计划（每个产物标注 written 或 skipped），**不创建目标目录、不写任何文件**。计划不是静态模板清单——真写之后再预演，已存在的产物会如实报 `SKIPPED`，因此预演与随后的真写逐字一致，可以直接作为写盘前 🔴 CHECKPOINT 的批准对象。

已有文件默认跳过；`--force` 会覆盖，用前须列出将被覆盖的文件并获批。含第三方块的文件（如 `## Agent skills`）一律不用 `--force`。

## 它会创建什么

目标仓库里**只有两个产物**：

- `AGENTS.md` 或 `CLAUDE.md`——**薄内核**：只写路由与不变量（项目蓝图、验证命令、启动工作流、状态与交接的承接方指向、工作规则、完成定义、会话结束）
- `init.sh`——声称完成前必须跑通的验证门禁

状态与交接产物**不在其中**：由 `to-tickets` / `handoff` 产生，落点由它们自己决定，本技能不指定。

**指令文件是路由层，不是手册。** 它每次会话被完整读取，所以只放「每次动作都可能需要」的内容。判据是「每次动作是否可能需要」，不是「段落有多长」；移出与删除是两件事，移出只是改变加载时机。详见 [`references/context-engineering-pattern.md`](references/context-engineering-pattern.md) 的「指令文件的抽离与维护」。

**「项目蓝图」节只回答两个问题：这个项目是什么、最终交付什么。** 它是描述，不是需求——不定义产品形式、不定义实现路径、不拆工单。内容由你陈述、经 `--blueprint` 落盘；省略时保留可见的**待补**占位，不代填、不由技术栈推断。**需求固化即越权**：需求对齐与设计不归本技能，蓝图只记对齐结论。本技能**不派生任何条目、验收标准或决策**——那是 `to-tickets` 从对齐结论派生的事。

已有 `CLAUDE.md` 时**沿用并编辑它，不另建 `AGENTS.md`**——两份指令文件就是两张互相矛盾的指路表。已存在的指令文件保持**逐字节不变**，脚本只**报告**它缺失的 harness 章节，合并由代理执行（报告 ≠ 改写）。这条规则也让第三方块（如别的 skill 拥有的 `## Agent skills`）得以保留。

`create-harness.mjs` 可检测常见的项目类型与包管理器。在基础验证命令层面支持 Node/npm/pnpm/yarn/bun、Python、Go、Rust、Maven、Gradle 和 .NET。

## 它会检查什么

`validate-harness.mjs` 对**三个** harness 子系统进行评分：

1. 指令
2. 验证
3. 范围

得分是结构性的。它告诉你 harness 是否存在且自洽；不能替代真实的前后对照代理会话测试。评分器**不读状态或生命周期产物**：那两类已委派，把它们计入分数会让"没有仓内台账"被扣两次分。

报告会给出得分最低的子系统——**并列最低时全部列出**，不会从并列里挑一个当成"瓶颈"：单点结论只在某个子系统确实弱于其余时才成立。最低分只是候选瓶颈，改动前先确认因果。

`run-benchmark.mjs` 在此之上先跑一遍**工具链自检**：每个关卡一条独立断言；任一项 FAIL 都会让脚本以退出码 1 结束。这些关卡守的是技能自己的不变量：

| 关卡 | 守住什么 |
|---|---|
| 字节上限 | `SKILL.md` 与**生成的 `AGENTS.md`** 都不超各自基线 15%（脚本运行时打印实际值与剩余量），按 **LF 归一化**计量——同一 commit 在 CRLF 检出上不该多算出每行 1 字节的余量。生成物另加**行数**与**工作规则条数**上限 |
| 生成物不可发现内容 | 指令文件不得复述代理自己读得到的东西（目录树、技术栈、重述的安装/快速开始章节）；检测器另用一份**故意违规的样本**自证有牙，否则一条永远抓不到东西的检查和一个干净的模板无法区分 |
| 范围边界 | 生成的指令文件必须**具名**写出承接方（`to-tickets`、`handoff`、`/setup-matt-pocock-skills`）——"某个工程 skill 管"不可证伪且让代理无处可查；**且**不得携带已移除的治理学说（仓内台账、落点、产物追踪策略、受控放行、模式开关、分册）。两向都要断言：只禁不立会被空文件满足，只立不禁会被"继续派活"的模板满足；检测器同样用一份故意违规的样本自证有牙。注意 `.scratch/`、`docs/agents/`、`ADR`、`CONTEXT.md` **不再属于违规**——它们是承接方自己的产物，点名它们正是委派句要干的事 |
| `--dry-run` | 零副作用；计划反映目标真实状态；计划与真写逐字一致 |
| 自引用可达性 | 技能打印的每条命令都能在目标仓直接跑起来 |
| 审计瓶颈 | 并列最低须列全（三个都点名）、唯一最低仍点名一个、全部满分须报「无」 |
| 空项目门禁 | 两臂都必须以非 0 退出，**永不失败的门禁不是门禁**：无 manifest 时的占位验证步骤，以及**有 manifest 但 check/typecheck/lint/test/build 一个都没定义**时（此时只剩安装步骤，`init.sh` 会跑完并退出 0，而一次真检查都没做）。同时反向断言：真定义了一个脚本的仓库仍照常运行 |
| 蓝图槽 | 省略 `--blueprint` 时必须留下可见的**待补**占位，而不是技术栈推断出来的文本；给了蓝图则必须**逐字**进 `AGENTS.md` |
| 指令文件不变量 | 已有 `CLAUDE.md` 时不得在其旁再建 `AGENTS.md`；已有指令文件保持逐字节不变，而其缺失章节仍被报告 |
| 报告覆盖 | 每个自检分组都有绑定的检查、都进 pass 合取、都有可分享报告的行——三者集合相等。只有控制台、漏进合取、或报告行指向已不存在的分组，任一情形都会 FAIL 并点名 |

**权威清单不在本文**：关卡的唯一来源是 `runSelfCheck()` 里的 `SELF_CHECK_GROUPS` 与各 `check*` 函数。跑一次脚本即逐条打印 `<关卡>: PASS/FAIL`，`--help` 给出流程编号。**本文不复述条数**——改一次关卡就要改一次数字，而复述的数字没有机械载体，只会静默漂移。

带 `--html` 时这些结果一并进报告——关卡结论若只出现在控制台，在事后复盘的产物里就等于不存在。

## 它会收尾什么

「收尾」作用于**本次会话的产出**，不是整个仓库：按产物性质归位（可执行约束 → `init.sh`/CI，跨会话长期不变量 → `AGENTS.md` 的工作规则，状态与证据 → 承接方的 tracker 工单，业务代码随提交走），清掉本次会话已无价值的临时材料，再按 `AGENTS.md` 的「会话结束」记账收口。

- 删除前必经 🔴 CHECKPOINT 列「将删 / 将留」清单获批。
- 不 prune 历史工单、不做全仓审计——那些独立一轮，走 `validate-harness.mjs` / `run-benchmark.mjs`。
- 作用域由**会话起始 commit** 界定：范围 = `git diff --name-only <起始 commit>` ∪ 未跟踪文件。未提供 ref 时**不假设 `HEAD`**——只有未提交改动算本会话，其余标「无法判定」而非「陈旧」，以免把已提交的本会话内容误判为历史。

**交接是上下文，不是命令队列**：跨会话交接由 `handoff` 按需产生，本技能不主动创建；下一个会话里若用户未显式要求推进本任务，代理不得自行续跑——即使 tracker 工单里的「下一步」写着明确的动作。这条边界写进目标仓库的 `AGENTS.md` 的**工作规则**（「推进需显式授权」），而不是只留在这里。

## 技能生态搭配

harness-creator 管"harness 产物落在哪、代理怎么启动、完成怎么验证"；怎么访谈、怎么拆单、怎么写代码，交给专业工程 skill：

- **[mattpocock/skills](https://github.com/mattpocock/skills)**——**唯一的强相关伙伴**。本技能与之的分工是硬边界：状态与阻塞边（`to-tickets`）、会话交接（`handoff`）、tracker 配置（`/setup-matt-pocock-skills`）全部由它承担，本技能**不再复制**任何一份仓内台账。
- **[addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)**——**只取其中 matt 未覆盖的工程能力**，且只作为可选项，不写进本技能：本技能不点名、不依赖、不为其产物指定位置。

交界只有一条，且是单向的：**别的 skill 管"活怎么干"，本技能管"harness 文件就位，并把它们串起来"**。本技能不复制任何工程 skill 的产物，也不为其产物指定位置——两个写入者会让同一份内容长出两种方言。`AGENTS.md` 本身可与其他 skill 的块共存（脚本只报告缺失章节、合并由代理执行）。

## 状态

- [x] 最小化 harness 脚手架（**只出 `AGENTS.md` + `init.sh` 两个产物**）
- [x] 三子系统验证
- [x] HTML 评估报告
- [x] 结构性基准报告
- [x] 状态与交接的**具名委派**：指令文件点名 `to-tickets` / `handoff` 与其前置 `/setup-matt-pocock-skills`；本技能不落仓内替代品，评估器也不给已委派的子系打分
- [x] 评估用例与覆盖契约——**双向成对**：每条用例各有条目引用（孤儿用例由守卫点名 FAIL），每条条目恰匹配一条用例。用例条数与覆盖检查条数均由脚本实时统计打印；**本文不复述这两个数字**，权威来源是 `evals/evals.json` 与 `scoreEvals()` 的 `familyEntries`
- [x] 需求固化即越权：蓝图只记「项目是什么、交付什么」，`--blueprint` 是唯一通路，省略时留可见「待补」占位；本技能不派生条目或验收标准
- [x] 范围边界：生成物**具名**写明承接方，且不得携带与 harness 无关的治理学说（带两向断言与反证样本）
- [x] 工具链自检（每项附反证，**权威清单见上「它会检查什么」节**——本节只列覆盖的能力面，不写条数）
- [x] 交接后的会话边界：推进需**显式授权**，交接与工单都只是上下文而非待办队列
- [x] 决策权交回用户：该问的拒写而非静默默认；审计结论不虚构排名（并列全部列出，不从并列里挑一个）
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
│   └── init.sh
├── references/
└── evals/evals.json
```

## 边界

本技能用于 harness 工程，而非模型选择、单纯的提示词调优或应用架构。项目特定的事实应保留在目标仓库中。
