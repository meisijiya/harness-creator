# 与 mattpocock/skills 共存（tracker 模式）

matt 的 `setup-matt-pocock-skills` 与本技能都会在 tracker 模式的仓库里落文件。两者**不是并列的骨架生成器**，而是**分区所有权**：同一产物只允许一个写入者，否则必然漂移。

本文管**落点与内容两条权威轴的归属**（谁决定产物住在哪、谁决定它写什么）；上游的 **skill 名单与调用模式**（哪个用户调用、哪个模型可调用）在 [Upstream Interlock](./upstream-interlock.md) 维护，此处不重复。交叉处只放指针——两处各存一份名单必然分叉。

## 两个正交的权威轴（先分清，才谈得上分区）

「谁说了算」在产物上不是一件事，是两件，必须分开归属，否则一方的权限会顺着另一方的名义蔓延：

| 轴 | 问的是什么 | 归属 | 载体 |
|---|---|---|---|
| **落点权威** | 这个产物**住在哪**（五个落点之一）、叫什么、是否进版本控制 | **harness** | 本文分区表的「产物」列 + `git-tracking-alignment.md` |
| **内容权威** | 文件**里面写什么**、什么格式、**何时创建** | **产出它的 skill** | 本文「引用而不复制」节 + 分区表的「唯一写入者/创建时机」列 |

**落点权威归 harness，内容权威归产出 skill。**具体含义：

- 上游 skill 的产物**必须落进五个落点之一**，落在落点外的（如仓库根的 `CONSTRAINTS.md`）由 harness 判定去向或要求用户裁决——**这是落点权威，不是对上游内容的改写**。
- 上游产物**写什么、什么格式、什么时候建**，harness 一律不规定、不预建、不要求自己的形状。`CONTEXT.md` 缺失不是因为"没建"，而是因为它**还没到时候**（内容权威决定时机）。
- 两条轴不互相授权：**"这类文件归我管落点"不等于"我可以规定它的内容"**；反之**"格式归上游"也不等于"它可以落在落点外"**。
- 重叠产物（两边都碰的，如 `CONTEXT.md`/`docs/adr/`）**按轴拆开归属**，不按文件整体归给某一方——这正是后文分区表能同时出现「matt 是唯一写入者」与「harness 管落点」而不矛盾的原因。

## 单一写入者分区

| 产物（落点权威：harness） | 唯一写入者（内容权威） | 创建时机（内容权威） | harness 的动作 |
|---|---|---|---|
| `docs/agents/` **目录** | 共享：matt setup 与本技能都写入 | — | 目录本身不是任何一方的信号：按**文件名**分区，见下表 |
| `docs/agents/issue-tracker.md` | matt setup | setup 运行时 | 只读；兼作 tracker 探测信号与状态路由 |
| `docs/agents/domain.md` | matt setup | setup 运行时 | 只读；兼作 tracker 探测信号 |
| `docs/agents/triage-labels.md` | matt setup | 仅 `triage` 已装时 | 只读 |
| `docs/agents/tracking-policy.md`、`docs/agents/escalation.md`（harness 分册） | harness | harness 运行时（或代理按「精简与抽离」流程补建） | 创建/维护；`templates/agent-docs/` 是名单唯一来源，评分器跟随同名文件 |
| `AGENTS.md`/`CLAUDE.md` 的 `## Agent skills` 块 | matt setup | setup 运行时 | 保留不写；本方章节由代理合并，脚本只报告缺失项 |
| `CONTEXT.md` | matt 的 `domain-modeling` | **延迟**——首个术语定稿时 | 不预创建；已存在则只读路由 |
| `docs/adr/` | matt 的 `domain-modeling` | **延迟**——首个 ADR 需要时 | 不预创建；已存在则只读路由 |
| `AGENTS.md`/`CLAUDE.md` 其余章节、`init.sh`/CI | harness | harness 运行时 | 代理合并（`create-harness.mjs` 只报告缺失章节，不盲写） |
| `.scratch/` | 使用方（按需） | 首次写入任务材料时 | 只文档化约定，**不预建空目录**；handoff/teach/research 等 skill 也会写入，**不构成 tracker 信号** |
| 放行豁免项（如 `teach` 工作区，落点由 skill 自身硬规定） | **产出 skill / 使用方** | 首次写入时 | 只在 AGENTS.md 豁免清单里登记（路径、owner、用户裁决、追踪状态）；**不治理其内容与形态**，放行不等于不看见 |
| `feature_list.json`、`progress.md` | harness | registry 模式 | tracker 模式不创建 |

## `docs/agents/` 是共享目录，按文件名分区

两个写入者在同一目录里各写各的主题文件，互不覆盖：

| 写入者 | 文件名 | 命名约束 |
|---|---|---|
| matt setup | `issue-tracker.md`、`domain.md`、`triage-labels.md` | 上游自有名单，harness 不改写 |
| harness | 主题化自有名（默认 `tracking-policy.md`、`escalation.md`） | **不得占用左列三个名字**；撞名时 `create-harness.mjs` 报错而不写入 |

两条边界：

- **探测按文件、不按目录**：tracker 模式信号是 `docs/agents/domain.md` 或 `docs/agents/issue-tracker.md` 这两个**具体文件**；harness 分册的存在不构成 tracker 信号，也不会让 registry 仓库被误判。
- **matt 的探索会看到这个目录**：上游 setup 把"`docs/agents/` 是否已存在"当作自己输出可能存在的线索。即便 harness 先跑、目录已建，matt 仍按自己的文件名判存在性并幂等写入（其 SKILL.md 规定 `## Agent skills` 块已存在时就地更新而非追加），因此不会漏建，也不会重复。**顺序无关**：谁先跑都不会覆盖另一方。

## 两个方向的顺序

**setup 先跑（反向）**：仓库有 `docs/agents/*`、AGENTS.md 里已有 `## Agent skills`，但可能**没有** `CONTEXT.md`/ADR（matt 延迟创建）。因此 tracker 模式的探测信号是 `docs/agents/` **或** `CONTEXT.md` **或** ADR 目录——只看 `CONTEXT.md` 会漏判。harness 随后合并自己的章节、落 `init.sh`，不改 matt 名下文件。

**harness 先跑（正向）**：matt 名下产物缺失时 harness **不代建**，只在交付说明里列为待办，指引用户运行 `setup-matt-pocock-skills`。`CONTEXT.md`/ADR 由 `domain-modeling` 在首个术语/决策定稿时创建，此前不存在是**正常状态**而非缺陷。

## 合并：报告与执行分开

`create-harness.mjs` 对已存在的 `AGENTS.md`/`CLAUDE.md` 只做两件事：**不写盘**，以及**列出模板里有、而该文件没有的章节**。合并由代理执行。

这样切分的理由："文件已存在"与"知道文件里已有谁的什么内容"是两件事。脚本只做纯文本比对，分不清标题归属，也认不出同义措辞：若既有文件用的是英文 `## Startup workflow`，盲追加会再写一个中文 `## 启动工作流`，于是一个仓库里出现**两套启动路径**——正是本节要防的漂移形态。判断权必须留给能读语义的代理。

代理合并时的三条硬约束：保留 `## Agent skills` 块；不为已覆盖的章节另建等价副本；合并后章节归属仍按上表分区。

**跨轴禁令**：合并时不得借「内容权威」扩张落点权威——即**不得**因为某文件内容归上游，就让它的落点逃出五个落点（把它放进仓库根、新建第六个落点，或拒绝登记其追踪状态）。内容归谁与落点归谁是两问，一次只能答一问。

## 指令文件选择不变量

matt 规定：`CLAUDE.md` 存在则编辑它；否则编辑 `AGENTS.md`；两者都不存在才询问用户——**绝不在 `CLAUDE.md` 已存在时创建 `AGENTS.md`**。harness 遵循同一不变量（`create-harness.mjs` → `detectAgentFile`），否则同一仓库会出现两个互相漂移的指令文件。

## 引用而不复制

`CONTEXT.md` 与 ADR 的**格式**归 matt（`domain-modeling/CONTEXT-FORMAT.md` 的 `## Language` + `_Avoid_`；`ADR-FORMAT.md` 的 `docs/adr/NNNN-slug.md`）。本技能**引用**这些规范，不复制、不改写、不要求自己的标题形状。评测器必须接受 matt 的规范格式，不得因缺少 harness 形状的标记而扣分。

## 反例

| 反模式 | 后果 |
|---|---|
| harness 预建 `CONTEXT.md` 并写 `## 术语`，与 matt 的 `## Language` 并存 | 同一文件两种方言，术语读法漂移 |
| harness 预建空 `.scratch/` | matt 把它读作「本地 markdown 工单已在用」的信号，误判 issue tracker 形态 |
| `CLAUDE.md` 已存在时再建 `AGENTS.md` | 两个指令文件，代理读到互相矛盾的路由 |
| 把 matt 的 `docs/agents/*` 复制进 harness 参考文档 | 复制外部版本化规范，matt 升级即漂移 |
| harness 在 `docs/agents/` 下使用 matt 的三个文件名 | 一个路径两个写入者：matt 的产物被覆盖或分叉；撞名必须报错而非静默写入 |
| 拿 `docs/agents/` 目录的存在当 tracker 信号 | 该目录已被两个写入者共享，按目录判定会把 registry 仓库误判为 tracker；信号只能是 matt 的两个具体文件 |
| tracker 模式仍写 `feature_list.json`/`progress.md` | 与工单系统形成第二状态源（黑名单 #1） |
| 因缺 `CONTEXT.md` 就把 matt 配置过的仓库判为非 tracker | 延迟创建被误读为缺陷，用户被推向错误模式 |
| 仅凭 `.scratch/` 存在就判 tracker 模式 | 第三方 skill（teach/research/handoff）也会写它，会把 registry 仓库误判为 tracker |
| 让 `teach` 等第三方 skill 在仓库根目录新建工作区，却不登记、不裁决 | 产物隐身：无人知道它是什么、归谁、跟不跟踪——比"落在落点外"本身更危险 |
| 让 `create-harness.mjs` 按标题做纯文本盲追加，假装那就是"合并" | 既有文件已用英文或其他措辞覆盖该章节时，会写出中英两套启动路径（等价于两个指令文件）；脚本不写盘、只报告才是正解 |
| 由「这个文件归我管落点」推出「我可以规定它里面写什么」 | 落点权威被当成内容权威用，harness 开始规定 `CONTEXT.md` 的标题形状，与上游格式规范形成方言漂移（等价于两个写入者） |
| 由「这个文件内容归上游」推出「它可以落在落点外」 | 内容权威被当成落点豁免用，上游产物落到仓库根等第六处，无人知道它归谁、跟不跟踪（落点权威失效） |
| 因缺 `CONTEXT.md` 就认为 harness 失职而补建它 | 违反内容权威：时机归上游（首个术语定稿），"还没到时候"被误读为"没人管" |
