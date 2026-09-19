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
| 工单 / `feature_list.json` | 状态与依赖 | tracker 模式用工单系统（本地或仓外）；registry 模式用仓内注册表 |

第三方 skill 的产物先**路由**进五个落点之一；路由不进、而产出 skill 自带**硬约束**（落点由它自身规定、不可改造）时**受控放行**；两者都不成立才**拒绝引入**。三步的判定门槛见「它会对齐什么」。

### 文档产物：项目文档层

`design.md`、`docs/` 等是合法资产，但必须有生命周期：

- 经 `AGENTS.md` 路由**按需读取**，不进默认上下文（更多上下文 ≠ 更多理解）
- 按性质拆分：可执行约束 → 门禁；术语 → `CONTEXT.md`；决策 → ADR
- 意图/体验类活文档（代码表达不了的内容）指定 owner，持续更新
- 与代码重复视为双写（漂移源）；过时即归档

路线组合：任务 spec 临时化（Ephemeral）+ 长期约束可执行化（Executable）+ 其余材料归档按需读。

## 安装

### 安装（推荐）

```bash
npx skills add meisijiya/harness-creator --skill harness-creator
```

### 升级

```bash
npx skills update harness-creator
```

### 卸载

```bash
npx skills remove harness-creator
```

### 手动安装

`npx skills add` 会自动探测运行时并把技能放进对应目录。手动安装时，把 `skills/harness-creator/` 复制到所用运行时的技能目录：

| 运行时 | 技能目录 |
|---|---|
| 通用（Agent Skills 标准） | `~/.agents/skills/` |
| Claude Code | `~/.claude/skills/` |

其他 skills-compatible 运行时（Codex、Cursor、OpenClaw、Hermes、Gemini CLI、OpenCode 等）各有自己的技能目录，按其文档指定的路径放置即可。

## 使用

安装后，`harness-creator` 位于所用运行时的技能目录（见上表），例如 `~/.agents/skills/harness-creator/`。

### 运行脚本

```bash
# 从仓库根运行：使用仓库内的 scripts/
node scripts/create-harness.mjs --target /path/to/project --mode registry --dry-run
node scripts/create-harness.mjs --target /path/to/project --mode registry
node scripts/validate-harness.mjs --target /path/to/project
node scripts/check-git-tracking.mjs --target /path/to/project
node scripts/run-benchmark.mjs --target /path/to/project --html /path/to/report.html
node scripts/render-assessment-html.mjs --target /path/to/project
node scripts/scan-housekeeping.mjs --target /path/to/project

# 从技能目录运行：使用已安装的 scripts/
node ~/.agents/skills/harness-creator/scripts/create-harness.mjs --target /path/to/project --mode registry
node ~/.agents/skills/harness-creator/scripts/validate-harness.mjs --target /path/to/project
node ~/.agents/skills/harness-creator/scripts/check-git-tracking.mjs --target /path/to/project
node ~/.agents/skills/harness-creator/scripts/run-benchmark.mjs --target /path/to/project --html /path/to/report.html
node ~/.agents/skills/harness-creator/scripts/render-assessment-html.mjs --target /path/to/project
node ~/.agents/skills/harness-creator/scripts/scan-housekeeping.mjs --target /path/to/project
```

这些脚本仅使用 Node.js 内置模块，不需要额外安装依赖。

### 写入前的两道闸门

`create-harness.mjs` 是唯一会往目标仓库写文件的脚本，它有两道**机械**闸门——不靠提示词约束，靠退出码：

1. **模式必须显式**。`--mode` 缺省且仓库里探测不到任何模式信号时，脚本**拒写并退出码 1**，只打印探测到的东西，不创建任何文件。理由是模式决定写哪套文件，而模式选择属于用户：问清楚仓库用途，再用 `--mode registry` 或 `--mode tracker` 重跑。显式写 `--mode auto` 同样是推断，不会绕过这道闸门。
2. **先预演再落地**。`--dry-run` 打印真写将要执行的那份计划（每个产物标注 written 或 skipped），**不创建目标目录、不写任何文件、退出码 0**。计划不是静态模板清单——真写之后再预演，已存在的产物会如实报 `SKIPPED`，因此预演与随后的真写逐字一致，可以直接作为写盘前 🔴 CHECKPOINT 的批准对象。

已有文件默认跳过；`--force` 会覆盖，用前须列出将被覆盖的文件并获批。含第三方块的文件（如 matt 的 `## Agent skills`）一律不用 `--force`。

## 它会创建什么

- `AGENTS.md` 或 `CLAUDE.md`（含「项目蓝图」「仓库结构」「产物追踪策略」等节，见下）
- `init.sh`
- `feature_list.json` 与 `progress.md`（精简版：当前状态、证据、阻塞、下一步）——**仅 registry 模式**；tracker 模式的状态在工单系统，写出这两个文件会制造第二状态源，因此脚本在该模式下跳过它们

**「项目蓝图」节只回答两个问题：这个项目是什么、最终交付什么。** 它是描述，不是需求——不定义产品形式、不定义实现路径、不拆工单。内容由你陈述、经 `--blueprint` 落盘；省略时保留可见的**待补**占位，不代填、不由技术栈推断。**需求固化即越权**：需求对齐与设计不归本技能，蓝图只记对齐结论，且在结论产生前不得新增或改写任何条目。因此**首次会话的注册表刻意是空的**——只留「项目初始化」与一条示例，项目特有的功能条目由你在对齐后自行补入。最小化骨架是正确且刻意的，但它**不等于懂你的项目**。

会话交接是**落点规则而非固定文件名**：引用式交接文档落在 `.scratch/` 下（文件名随意，`handoff.md`、带时间戳的都行）——仓根与 `docs/` 都不是五个落点之一，生成方若默认写到那里，改写到 `.scratch/` 即可。tracker 模式（`CONTEXT.md` + ADR + 工单系统承接状态，工单可本地可仓外）见 SKILL.md 的"两种模式"一节。与 matt setup 共存时按**单一写入者**分工：matt 拥有 `docs/agents/*`、`CONTEXT.md`、`docs/adr/`、`## Agent skills` 块（其中 `CONTEXT.md`/ADR 由上游领域建模 skill **延迟创建**），本技能不代建，只落自己的章节与 `init.sh`；详见 `references/matt-coexistence.md`。

`create-harness.mjs` 可检测常见的项目类型与包管理器。在基础验证命令层面支持 Node/npm/pnpm/yarn/bun、Python、Go、Rust、Maven、Gradle 和 .NET。

## 它会检查什么

`validate-harness.mjs` 对五个 harness 子系统进行评分：

1. 指令
2. 状态
3. 验证
4. 范围
5. 生命周期

得分是结构性的。它告诉你 harness 是否存在且自洽；不能替代真实的前后对照代理会话测试。

报告会给出得分最低的子系统——**并列最低时全部列出**，不会从并列里挑一个当成"瓶颈"：单点结论只在某个子系统确实弱于其余时才成立。最低分只是候选瓶颈，改动前先确认因果。

`run-benchmark.mjs` 在此之上先跑一遍**工具链自检**：**16 项断言**（14 个独立检查 + 脚手架打分 + 双语打分），外加 eval 覆盖计分；任一项 FAIL 都会让脚本以退出码 1 结束。这些关卡守的是技能自己的不变量：

| 关卡 | 守住什么 |
|---|---|
| 脚手架 + 双语打分 | 脚本端到端可跑；生成的骨架能过五子系统评分；英文 tracker 骨架与中文 registry 骨架同标准 |
| 字节上限 | `SKILL.md` 不超基线 150%，按 **LF 归一化**计量——同一 commit 在 CRLF 检出上不该多算出每行 1 字节的余量 |
| 生成物字节上限 | 技能 ship 进每个目标仓的**最大**产物是 `AGENTS.md`，它按渲染后的默认形态计量（字节 + 行数 + 工作规则条数）。在此之前它没有任何关卡，而审计对指令文件的检查**全是存在性检查**——长文本只会加分，所以激励梯度单向偏向"多写" |
| 生成物不可发现内容 | 指令文件不得复述代理自己读得到的东西（目录树、技术栈、重述的安装/快速开始章节）；检测器另用一份**故意违规的样本**自证有牙，否则一条永远抓不到东西的检查和一个干净的模板无法区分 |
| 产物护栏 | 生成物不含只在技能仓内才解析的技能仓相对路径；tracker 模式不吐 registry 状态文件；tracker 骨架得分不低于阈值 |
| 模式闸门 | 无信号且未显式 `--mode` 时必须拒写（同时断言两条合法路径不被误伤） |
| `--dry-run` | 零副作用；计划反映目标真实状态；计划与真写逐字一致 |
| 自引用可达性 | 技能打印的每条命令都能在目标仓直接跑起来 |
| 审计瓶颈 | 并列最低须列全、唯一最低仍点名一个、全部满分须报「无」 |
| 空项目门禁 | 空项目下的占位验证步骤必须以非 0 退出（**永不失败的门禁不是门禁**），同时断言真实命令仍照常运行 |
| 交接识别 | `.scratch/` 下带时间戳等任意文件名的交接文档必须被识别，而落在五落点之外的交接文档必须被忽略 |
| 蓝图槽 | 省略 `--blueprint` 时必须留下可见的**待补**占位，而不是技术栈推断出来的文本；给了蓝图则必须**逐字**进 `AGENTS.md` |
| 条目模板克制 | 新骨架不得自带项目形态的功能条目（首次会话刻意是空的），且必须先写明「对齐后方可新增」的规则 |
| 指令文件不变量 | 已有 `CLAUDE.md` 时不得在其旁再建 `AGENTS.md`（两份指令文件＝两张互相矛盾的指路表）；已有指令文件保持**逐字节不变**，而其缺失章节仍被报告——报告 ≠ 改写 |
| 收尾 / 整理扫描器安全 | 唯一一个「以删除为目的」看产物的脚本：必须**只读**；无 `--session-ref` 时只许标「无法判定」而非「陈旧」；给了 ref 仍须能标出历史（抑制不得是永久的）；收尾须抑制 prune 而整理仍须产出候选；`done` 无 evidence 在任何模式下都不得进删除候选；并须报告指令文件自身的健康度——节体积排序、**指向已消失路径的豁免登记行**、未定稿占位符——且只报告不改写（区分"该报的报出"与"不该报的不报"） |

带 `--html` 时这些结果一并进报告——关卡结论若只出现在控制台，在事后复盘的产物里就等于不存在。格式守卫本身也该有守卫：每道关卡都配了反证测试（把旧行为塞回去，关卡必须 FAIL 并点名）。

## 它会对齐什么（只问一次）

五个落点是产物的合法落点，但"落在仓库里"不等于"该进版本控制"。`check-git-tracking.mjs` 是**只读**探测器，逐落点给出五种状态：

| 状态 | 含义 | 是否询问 |
|---|---|---|
| `tracked` | 已在 git 索引中 | 不问 |
| `ignored` | 被 ignore 源命中（`.gitignore`、`.git/info/exclude`、全局 excludes） | **视为用户已选择「不跟踪」**，不问 |
| `stray` | 存在，却既未提交也未忽略（游离态） | 🔴 必问 |
| `absent` | 尚未产生，按默认语义执行 | 不问 |
| `unknown` | git 不可用或非仓库 | 🔴 问一次 |

**询问职责唯一**：这次对齐由 harness-creator **独占处理，且每个项目只问一次**。结论有两处载体——`.gitignore`（机制）与 AGENTS.md 的「产物追踪策略」节（指针与不变量）；后者存在即表示已对齐，因此其他 skill（含上游教学 skill）**只读不问**，避免同一策略被反复询问、结论分散成第二事实源。

第三条边界值得单独说：`.gitignore` **只对未跟踪路径有效**。已提交的路径即使写进 `.gitignore` 也仍被跟踪，探测器会报 `ineffective opt-out`——此时不能判为「不跟踪」，要么按跟踪处理，要么由用户决定 `git rm --cached`（本技能不代做）。

覆盖范围不止五个落点，还包括会往仓库里写东西的第三方 skill。处理顺序是**先路由、再放行、最后拒绝**：

1. **先路由**：产物落点可配置、可重定向 → 路由进五落点之一（多数情况）。
2. **受控放行**：产出 skill 自带**硬约束**（落点由它自身规定、不可改造，如上游教学 skill 的「以当前目录为工作区」）→ 放行，但 harness **不治理**其内容与形态（由产出 skill 自治理），只**审视**：登记豁免清单、由用户裁决"原样保留"还是"收归治理"，并给出追踪结论。
3. **拒绝**：既路由不进、也援引不出硬约束 → 拒绝引入（反例 #9）。

放行不是第六个落点，也**不是"不用管"**：门槛有三条（硬约束 / 该产物只服务 skill 自身会话 / 能一行登记），漏掉登记、裁决、追踪结论任何一项即回落为"拒绝引入"。豁免项一旦被代理当作项目知识读取（承担状态、决策或术语职责），立即收归五落点。

逐 skill 的产物落点表（谁写什么、该落在哪）只维护一份，见 [`references/upstream-interlock.md`](references/upstream-interlock.md) 的「产物落点视图」；判定顺序、放行门槛、路由理由、反例与边界见 [`references/git-tracking-alignment.md`](references/git-tracking-alignment.md)。

## 它会收尾什么

「收尾」与「整理」共用同一份只读扫描，**差别只在作用域**——这是唯一分界：

| 意图 | 典型说法 | 作用域 | 动作 | 扫描 |
|---|---|---|---|---|
| **会话收尾** | "收尾"、"结束这次会话" | **本会话产出**（会话起始 ref 之后的改动与新增） | 定界 → 归位 → 清场 → 记账 → 收口 | `--session-only` |
| **整理仓库** | "整理仓库"、"清账" | **全仓「状态」一族**（状态落点 + 指令文件的失效登记行，含历史累积） | 清账 / 查漏 / 补齐 | 默认 |
| **优化 / 审计** | "优化 harness"、"评估一下" | **全仓 harness 质量** | 五子系统审计 + 改进落地 | `validate-harness.mjs` |

会话收尾只处理**这次会话产出的东西**：按五个落点归类（决策→ADR、术语→`CONTEXT.md`、可执行约束→`init.sh`/CI、状态→注册表或工单、任务草稿→`.scratch/`），清掉本次会话已无价值的临时材料，再按 AGENTS.md 的「会话结束」记账收口。它**不 prune 历史条目、不跑全仓审计**——那分别属于整理与优化。三者不叠加：用户同时说"收尾，顺便优化一下"时拆开执行，不把审计结果混进收尾。

```bash
node ~/.agents/skills/harness-creator/scripts/scan-housekeeping.mjs --target /path/to/project --session-ref <会话起始 commit> --session-only
```

`--session-only` 把本会话产出映射到五个落点，标出落在落点之外的会话产出（文档类文件优先复核是不是没归位的知识材料），并**抑制**全仓 prune 候选。范围外的文件一律不碰；`--session-ref` 同样不默认 `HEAD`——省略时只有未提交改动算本会话，其余标「无法判定」而非「陈旧」。删除前仍必经 🔴 CHECKPOINT 列清单获批，ADR 与 `CONTEXT.md` 永不清。完整流程（含五步、非目标与反例）见 `references/session-wrapup-pattern.md`。

## 它会整理什么

`scan-housekeeping.mjs` 是「整理仓库」的**只读**扫描器——用户显式请求时使用，用于把仓库收敛回五个落点：

```bash
node ~/.agents/skills/harness-creator/scripts/scan-housekeeping.mjs --target /path/to/project --session-ref <会话起始 commit>
```

它只输出清单、不删任何东西：治理模式、五个落点的缺失项、`feature_list.json` 中「done 且有证据」（可清）／「done 无证据」（**不可清**，先补证据）／未完成的条目、`.scratch/` 的分级（current／stale／unverified），以及自 `--session-ref` 以来改动的文件（即本会话范围）。`--session-ref` 必须是**本会话起始 commit**，**不默认 `HEAD`**——省略时只有未提交改动算本会话，其余标为「无法判定」而非「陈旧」，以免把已提交的本会话内容误判为历史。

清账的作用域是**「状态」一族**——仓内的状态落点，加上指令文件里承担状态职责的那张登记表（完整口径以 `references/housekeeping-pattern.md` 为准）：ADR（只增不删）与 `CONTEXT.md`（持续更新）永不清；删除前必须列出「将删/将留」清单并经 🔴 CHECKPOINT 批准。沉淀按需进行——默认你已在需求对齐后用上游的沉淀 skill 完成，本技能只补缺口、不代调用他人 skill。完整流程见 `references/housekeeping-pattern.md`。

## 技能生态搭配

harness-creator 管"产物落在哪、代理怎么启动、完成怎么验证"；怎么访谈、怎么拆工单、怎么写代码，交给专业 skill。

**两套上游的联动清单（skill 名、调用模式、插拔规则、上游变更维护流程）集中在 [`references/upstream-interlock.md`](references/upstream-interlock.md)**；本节只讲分工与取舍，**不复述名单**——名单存两份必然分叉，而上游是活跃仓库。

### 主体系：[mattpocock/skills](https://github.com/mattpocock/skills)

tracker 模式的默认搭配：初始化工作区（用户自行运行）→ 需求访谈与领域建模 → spec 与拆单 → 实现与验证 → 交接。各环节由上游 skill 承接，产物落在本技能约定的五个落点内；其中部分 skill 由用户显式调用，代理不代发起。

上游的教学 skill 是这一层里最需要约定的一个：它把**当前目录**当作有状态教学工作区（这是它的硬约束，不可配置），直接在仓库根目录运行就会把教学状态倒进默认上下文。约定分两级——首选把工作目录重定向到 `.scratch/teach/`；确实无法重定向时**受控放行**：登记进 AGENTS.md 的豁免清单、由你裁决原样保留或收归治理，并明确其追踪状态。无论哪级，**它都不再自行询问**是否纳入版本控制——追踪策略已由 harness-creator 一次性对齐（见「它会对齐什么」）。

无信号的新仓库：harness-creator 先问"仓库用来做什么"判定模式；判 tracker 即默认用户已自行运行初始化 skill（本技能不调用、不询问安装、不提供仓内替代），随后只落本方骨架，matt 名下产物列为待办。

**为什么不复制 matt 的产物**：上游的初始化 skill 创建 `docs/agents/*` 与 `## Agent skills` 块，而 `CONTEXT.md`/ADR 由上游的领域建模 skill **延迟创建**（首个术语/决策定稿时才建）。若本技能也预建这些文件，就会出现两个写入者与两种方言（harness 的 `## 术语` vs matt 的 `## Language`）。因此规则是**单一写入者**：格式与创建时机归 matt，本技能引用而不复制。`create-harness.mjs` 同样遵循 matt 的互斥不变量——已有 `CLAUDE.md` 时不另建 `AGENTS.md`。完整分区、两个方向的顺序与反例见 `references/matt-coexistence.md`。

### 补充：[addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)（registry 模式的工作流层）

不采用工单体系时，addyosmani 提供完整工作流层（Define → Plan → Build → Verify → Review → Ship），状态骨架由 registry 模式承担。与 matt 体系并存时的**采纳取舍**（哪些与之重复、哪些无条件不引入、哪些改造后用）记在 [`references/upstream-interlock.md`](references/upstream-interlock.md) 的「采纳取舍」一节，本节不重复。

模式回答"状态住哪"，技能生态回答"活怎么干"——两个正交维度，不因换生态而新增模式。

**治理权归属**：权威不是一件事，是两件正交的事，分开归属才不会互相蔓延。

- **落点权威归 harness-creator**：任何产物（本方或第三方）**住在哪个落点、叫什么、是否进版本控制**，由本技能判定——第三方 skill 只在五个落点内产出，落在落点外的由本技能决定去向或交用户裁决。
- **内容权威归产出它的 skill**：文件**里面写什么、什么格式、何时创建**归上游。本技能不规定、不预建、不要求自己的形状；`CONTEXT.md`/ADR 缺失是"还没到时候"，不是缺陷。

两条轴**不互相授权**：「归我管落点」不等于「我能规定它的内容」，「格式归上游」也不等于「它可以落在落点外」。重叠产物（如 `CONTEXT.md`/`docs/adr/`）**按轴拆开归属**，不按文件整体归给某一方。

两种模式下 AGENTS.md 的 harness 章节（启动工作流、工作规则、完成定义、验证命令等）都归本技能全权管理——模式切换只改变状态事实来源的位置，不改变治理权。被无条件拒绝的三项（名单见 [`references/upstream-interlock.md`](references/upstream-interlock.md) 的「采纳取舍」）正是**内容权威**上的竞争者：它们会为自己的内容再造一套规则，与既有落点形成第二事实来源。AGENTS.md 文件可与第三方块共存（合并规则见 `references/matt-coexistence.md`：章节以 `templates/agents.md` 为唯一来源，已存在时脚本只报告缺失章节、合并由代理执行），但治理权威唯一。

## 状态

- [x] 最小化 harness 脚手架
- [x] 五子系统验证
- [x] HTML 评估报告
- [x] 结构性基准报告
- [x] 评估用例 23 条（含 tracker 模式集成）；`run-benchmark` 的 eval 覆盖检查 14 项（控制台的 `(14/14)` 指覆盖检查，不是用例数）——该清单是**覆盖契约**，新增能力族时必须同步增长，否则分数会一直报满分
- [x] 双模式治理：registry（仓内注册表）与 tracker（工单驱动，CONTEXT.md + ADR）
- [x] 常见技术栈的通用验证检测
- [x] 整理仓库：只读清账扫描（`scan-housekeeping.mjs`）+ 按需沉淀（补齐为准）
- [x] 会话收尾：仅作用于**本会话产出**的收敛流程（`--session-only`），与整理/优化按作用域分流
- [x] 与 matt setup 共存：单一写入者分区（matt 拥有 `docs/agents/*` 与 `CONTEXT.md`/ADR 的格式及延迟创建）
- [x] 产物落点的 git 跟踪对齐：只读探测（`check-git-tracking.mjs`）+ 每项目一次性询问，含上游教学 skill 等第三方产物
- [x] 上游联动抽离为**可插拔清单**：清单、调用模式、插拔规范与上游变更维护流程单一来源（`references/upstream-interlock.md`），下游按角色引用
- [x] 非工单模式的任务推进：条目即工单（`acceptance` 字段 + 垂直切片/前沿/增量环规范）
- [x] 交接后的会话边界：推进需**显式授权**，交接文档是上下文而非待办队列
- [x] 模板模式中立：`AGENTS.md` 中随模式变化的小节由占位符填充，不泄漏另一模式的状态产物
- [x] 写入前的机械闸门：无信号且未显式 `--mode` 时拒写（退出码 1、零文件）；`--dry-run` 预演零副作用且与真写逐字一致
- [x] 生成物护栏：目标仓库里不出现只在技能仓内才解析的指针；tracker 模式不吐 registry 状态产物
- [x] 需求固化即越权：蓝图只记「项目是什么、交付什么」，`--blueprint` 是唯一通路，省略时留可见「待补」占位；对齐结论产生前不新增／改写任何条目
- [x] 工具链自检 16 项断言（每项附反证）：脚本可跑、双语打分、字节上限、**生成物体积上限**、**生成物不可发现内容**、产物护栏（含 tracker 骨架）、模式闸门、`--dry-run` 一致性、自引用可达性、审计瓶颈并列、空项目门禁、交接识别、蓝图槽、条目模板克制、指令文件不变量、收尾／整理扫描器安全（含指令文件体检）
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
│   ├── scan-housekeeping.mjs
│   ├── check-git-tracking.mjs
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
