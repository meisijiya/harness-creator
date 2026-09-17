# 上游联动清单（可插拔）

**一句话**：本技能与 `mattpocock/skills`、`addyosmani/agent-skills` 的**全部耦合**集中在本文件——清单在此、插拔规则在此、上游变更时的复核流程也在此。其他文件**按角色引用**，不列举上游 skill 名。

**存在的理由**：上游是活跃仓库（skill 会改名、合并、增删、改调用模式）。若联动内容散落在 `SKILL.md`、模板与脚本里，一次上游改动就要全仓追改，且总会有漏网的一处——那就是事实漂移。把耦合收进一个文件、让下游按角色说话，上游变动时只需改这里。

## 唯一来源不变量

- 本文件是**上游清单的唯一来源**：skill 名、仓库归属、调用模式只在这里维护。
- 下游一律**按角色引用**（"上游的审查 skill"），不写具体名字；确需点名时指向本文件。
- 与之分工：`matt-coexistence.md` 管**分区所有权**（谁写哪个文件、格式归谁），本文件管**清单与调用模式**。两者互不重复，交叉处只放指针。

**适用范围与判定口径**（口径不写清，就会一边漏收、一边误伤）：

- 约束**随技能分发的说明性文件**：`SKILL.md`、`templates/`、`scripts/`、`README.md`、`references/`。
- **违规 = 复制了清单、调用模式或路由表**（等于第二份名单）；**不算违规 = 单处点名的实例引用**。
- 例外一：**测试夹具**（`evals/`、`test-prompts.json`）可以点名——它们模拟用户的真实说法，改名反而失真；名单仍以本文件为准，夹具只作断言样本。
- 例外二：**以某个上游 skill 为论述主体**的文件（如 `matt-coexistence.md` 论述分区所有权）可点名，但不得借此维护平行清单。
- **写入目标仓库的字面量**（模板与生成脚本里的文本）一律按角色说话——它会被分发进每个新 harness，点名即让过期指令扩散（反例 #2）。

## 两套上游仓库与角色

| 仓库 | 角色 | 它在 harness 里的位置 |
|---|---|---|
| `mattpocock/skills` | **工程流**：需求对齐 → 规格 → 拆分 → 执行 → 审查 | tracker 模式的主链；其产物布局（`docs/agents/*`、`CONTEXT.md`、`docs/adr/`、`## Agent skills`）构成 tracker 探测信号与分区 |
| `addyosmani/agent-skills` | **工程实践**：纪律型的实现/测试/审查/性能等技能 | 两模式的**纪律来源**；registry 模式的推进节奏主要复用它的模型可调用技能 |

**编排规则（上游定义，据实引用）**：matt 的 README 把技能分为用户调用与模型可调用，并规定「用户调用技能可以调用模型可调用技能，但**绝不能**调用另一个用户调用技能」。addyosmani 的 `AGENTS.md` 规定编排者是用户或 slash command，**persona 之间不互相调用**，只允许「并行扇出 + 合并」一种多角色形态。两者一致：**编排权在用户**，本技能据此不代发起用户调用类技能。

## 联动清单

调用模式一列是**实测值**（读上游 `SKILL.md` 的 frontmatter 得出，见文末核实记录），不是推测。

| 能力 | 上游 skill | 仓库 | 调用模式 | harness 用途 | 内化到 |
|---|---|---|---|---|---|
| 需求对齐 + 术语/决策落地 | `grill-with-docs` | matt | 用户调用 | 对齐后把术语与决策写进 `CONTEXT.md`/ADR | —（用户发起，本技能不代调用） |
| 领域模型维护 | `domain-modeling` | matt | 模型可调用 | `CONTEXT.md`/ADR 的**延迟创建**与格式规范 | `matt-coexistence.md` |
| 规格化 | `to-spec` | matt | 用户调用 | 把讨论落成 spec 并发布到工单 | —（用户发起） |
| 拆分（tracker） | `to-tickets` | matt | 用户调用 | 曳光弹垂直切片 + blocking edges，发布为工单 | `task-advancement-pattern.md` 的拆分规范 |
| 拆分纪律（通用） | `planning-and-task-breakdown` | addyosmani | 模型可调用 | registry 模式拆 `feature_list.json` 条目 | 同上 |
| 执行（tracker） | `implement` | matt | 用户调用 | 按 spec/tickets 实现到提交 | `task-advancement-pattern.md` 的推进规范 |
| 增量实现纪律 | `incremental-implementation` | addyosmani | 模型可调用 | registry 模式的增量环、范围纪律、回滚友好 | 同上 |
| 测试纪律 | `tdd` | matt | 模型可调用 | 预先商定接缝、先红后绿、垂直切片 | 同上（接缝与循环规则） |
| 测试纪律（通用） | `test-driven-development` | addyosmani | 模型可调用 | 与上者能力等价，按已安装者取用 | 同上 |
| 审查 | `code-review` | matt | 模型可调用 | 提交前两轴审查（Standards / Spec） | `task-advancement-pattern.md` 的收口步 |
| 审查（通用） | `code-review-and-quality` | addyosmani | 模型可调用 | 与上者能力等价，按已安装者取用 | 同上 |
| 交接 | `handoff` | matt | 用户调用 | 引用式交接文档，落 `.scratch/` | `session-wrapup-pattern.md`（交接所有权在用户） |
| 环境配置（tracker 前置） | `setup-matt-pocock-skills` | matt | 用户调用 | tracker 模式的工单系统与标签配置 | `matt-coexistence.md`（本技能不调用、不代装） |
| 教学（落点冲突例外） | `teach` | matt | 用户调用 | 以「当前目录」为工作区的硬约束产物 | `git-tracking-alignment.md`（软路由 → 受控放行） |

**两侧等价能力的处理**：matt 与 addyosmani 在测试与审查上有等价技能。不规定「必须用哪一个」——按**已安装者取用**，两者都不在时提示用户安装。规定其一会在上游调整时立刻变成错误指令。

## 采纳取舍（两套并存时）

addyosmani 的完整工作流层按生命周期组织，全部为模型可调用：

- **Define**：`interview-me`、`idea-refine`、`spec-driven-development`、`constraint-driven-development`
- **Plan**：`planning-and-task-breakdown`
- **Build**：`incremental-implementation`、`test-driven-development`、`source-driven-development`、`doubt-driven-development`、`frontend-ui-engineering`、`api-and-interface-design`
- **Verify**：`browser-testing-with-devtools`、`debugging-and-error-recovery`
- **Review**：`code-review-and-quality`、`code-simplification`、`security-and-hardening`、`performance-optimization`
- **Ship**：`git-workflow-and-versioning`、`ci-cd-and-automation`、`deprecation-and-migration`、`observability-and-instrumentation`、`shipping-and-launch`

两套并存时的裁决（这是审计结论，不是上游事实——上游不会替你决定）：

| 类别 | 名单 | 理由 |
|---|---|---|
| **与 matt 重复** | `interview-me`、`planning-and-task-breakdown`、`test-driven-development`、`code-review-and-quality`、`debugging-and-error-recovery` | matt 为主时不引入；**无 matt 时翻转为可用** |
| **无条件不引入** | `using-agent-skills`（与 `AGENTS.md` 路由双写）、`context-engineering`（与本技能本体双写）、`documentation-and-adrs`（行内文档标准 vs 代码即文档；其 ADR 部分可用） | 治理竞争者：会与既有落点形成第二事实来源 |
| **改造后用** | `spec-driven-development`（PRD 必须落 `.scratch/`）、`idea-refine`（限概念萌芽期）、`constraint-driven-development`（约束进 `init.sh`/CI，`CONSTRAINTS.md` 只作指针；留在根目录即落点外，必问） | 原形态会产出落点外产物或越过阶段边界 |
| **已知冲突** | `test-driven-development` 的 80/15/5 配额 vs「只做重要逻辑测试」的克制原则 | 与用哪套生态无关；冲突照实说明，不静默改上游 |

裁决记录放在这里的理由与清单相同：它是**上游相关**的维护信息。上游若新增生命周期阶段，只需改本表。

## 产物落点视图（哪些上游 skill 会往仓库里写东西）

判定顺序与放行机制见 [Git Tracking Alignment](./git-tracking-alignment.md)；本表只回答「谁写什么、该落在哪」。上游新增产物型 skill 时**只改本表**。

| 来源 skill | 产物 | 路由 |
|---|---|---|
| matt `teach` | 教学工作区（原文：以**当前目录**为有状态工作区） | 首选软路由：以 `.scratch/teach/` 为 cwd；约束不可重定向时走受控放行并登记豁免 |
| matt `research` | 仓库内引用式 Markdown | `.scratch/`（落点一） |
| matt `improve-codebase-architecture` | 可视化 HTML 报告 | `.scratch/`（落点一） |
| matt `prototype` | 可分享 HTML 原型 | `.scratch/`（落点一） |
| matt `to-questionnaire` | Markdown 问卷 | `.scratch/`（落点一） |
| matt `handoff` | 交接文档 | `.scratch/handoff.md`（落点一，已有约定） |
| matt `wizard` | 交互式 bash 向导脚本 | 需裁决：可提交则跟踪，一次性则 `.scratch/` |
| matt `to-spec` / `to-tickets` | spec、本地工单文件 / 工单系统条目 | 落点五（状态与依赖） |
| matt `grill-with-docs` / `domain-modeling` | `CONTEXT.md`、ADR | 落点二 / 三；格式归上游，本技能引用不复制 |
| addyosmani `constraint-driven-development` | `CONSTRAINTS.md` | 可执行约束应进 `init.sh`/CI（落点四）；文件本体只作指针或转 `.scratch/`。留在根目录即落点外，必问 |
| addyosmani `spec-driven-development` | PRD / 规格文档 | 落点五（工单）或 `.scratch/` |
| addyosmani `documentation-and-adrs` | ADR | 落点三 |
| addyosmani `code-review-and-quality` 等 | 无持久产物（仅评审意见） | 无需落点 |

## 内化映射（上游变更时按此复核下游）

本技能把上游的部分纪律**内化**成了自己的规范。内化后的文字**不随上游自动更新**，因此上游哲学变动时要按本表复核：

| 本技能的不变量 | 来源 | 落在 | 上游若改动时复核什么 |
|---|---|---|---|
| 曳光弹垂直切片、blocking edges、尺寸以单个上下文窗口为限、prefactor 先行、宽重构走 expand–contract | `to-tickets` / `planning-and-task-breakdown` | `task-advancement-pattern.md` 拆分规范 | 切片规则与例外是否变化；`dependencies` 语义是否变化 |
| 前沿（frontier）选择、一次一条 | `to-tickets` / `implement` | 同上 推进规范 | 「前沿」定义是否变化 |
| 预先商定接缝、先红后绿、垂直切片 | `tdd` / `test-driven-development` | 同上 推进规范 | 接缝协商是否仍是前置要求；red-green 流程是否调整 |
| 增量环（实现→测试→验证→提交）、范围纪律（发现但不动）、保持可编译、回滚友好 | `incremental-implementation` | 同上 推进规范 | 增量环步骤与红旗是否变化 |
| 单一写入者分区（`docs/agents/*`、`CONTEXT.md`、`docs/adr/` 的归属与延迟创建） | `setup-matt-pocock-skills` / `domain-modeling` | `matt-coexistence.md` | setup 产物的路径与格式是否变化 |
| 交接为引用式、落临时目录、不复制既有产物 | `handoff` | `session-wrapup-pattern.md` | 交接落点与「不复制」规则是否变化 |

**内化的边界**：只内化**不变量**，不内化正文。上游 skill 的步骤、模板、示例一律按名引用——复制进来的那一刻就开始腐化（反例 #1）。

## 插拔规范

增、删、改一个上游能力时：

1. **只改本文件的清单表**（必要时同步内化映射）。
2. **下游不动**：下游按角色引用（"上游的审查 skill"），因此换名、换仓库、等价替换都不需要改下游。
3. **只有两种情况要动下游**：
   - 该能力**新增/消失**导致某个下游环节失去承担者 → 在对应 reference 里补「缺装时如何降级」，与该能力本身无关的内容不动；
   - 该能力的**语义变了**（不只是改名）→ 按「内化映射」表复核落点。
4. **不新增平行清单**：任何文件都不得再复制一份 skill 名单（含 README 与模板）。上一轮整改已把 `templates/agents.md` 的硬编码名单、`housekeeping-pattern.md` 的列举、`failure-modes.md` 的仓库名收回此处——保持收口状态。

## 上游变更维护流程

上游是活跃仓库，清单会过期。按下表复核，**结论落回本文件**（附日期）：

| 步骤 | 动作 | 判据 |
|---|---|---|
| ① 取现状 | 读上游 `skills/*/SKILL.md` 的 frontmatter | 有无 `disable-model-invocation: true` → 用户调用；无 → 模型可调用 |
| ② 比对 | 与下方清单表逐行比 | 出现新 skill / 消失 / 改名 / 调用模式翻转 |
| ③ 定影响 | 按「内化映射」找受影响的下游条目 | 只改名 → 不动下游；语义变了 → 复核下游 |
| ④ 落字 | 更新清单表 + 核实记录 | 清单与上游一致，日期已更新 |
| ⑤ 跨仓复核 | 若上游改的是**格式或路径**（不是能力） | 转 `matt-coexistence.md` 与 `git-tracking-alignment.md` |

**不要**为了「跟上上游」去读全量上游仓库：本文件只维护**被本技能用到的**那部分能力。

## 缺失降级

默认用户已装好两套上游 skill。未安装时：

- **报告缺失 + 指引安装**（上游各自的安装说明归上游，本技能不复述命令）。
- **不落替代副本**：不在仓库里新建一份「简化版 tdd / 简化版 code-review」。本技能内化的规范（拆分、推进、完成判据）**仍然适用**——它们已经独立成立，不依赖上游在场。
- **不代装、不代配**：生态安装是用户级、一次性、跨项目的事，归用户。

## 与 `matt-coexistence.md` 的分工

| | 本文件 | `matt-coexistence.md` |
|---|---|---|
| 管什么 | 上游**清单**、调用模式、内化映射、插拔与维护 | matt 与本技能的**分区所有权**、创建时机、格式归属 |
| 谁变它 | 上游增删改 skill 时 | setup 产物布局或格式规范变化时 |
| 唯一来源 | skill 名与调用模式 | 文件归属与格式规范 |

交叉只放指针：本文件说「产物布局见 `matt-coexistence.md`」，那一篇说「清单与调用模式见本文件」。

## 反例

| # | 反模式 | 为什么不要做 | 替代做法 |
|---|---|---|---|
| 1 | 把上游 skill 的正文复制进本仓库 | 上游一改就漂移；等于维护一份必然腐化的副本 | 按名引用；只内化不变量，并按内化映射留复核线索 |
| 2 | 在模板里写死上游 skill 名 | 模板会分发到每一个目标仓库，上游改名后**所有新 harness 都带着过期指令** | 模板按角色说话，清单指向本文件 |
| 3 | 同一份 skill 名单在多个文件各存一份 | 多处清单必然分叉，且无从判断哪份新 | 唯一来源 = 本文件；下游一律按角色引用 |
| 4 | 规定「必须用 matt 的 tdd 而非 addyosmani 的」 | 两侧能力等价；写死其一会在上游调整时变成错误指令 | 按已安装者取用，两者都不在时提示安装 |
| 5 | 上游缺装时自造「简化版」替代技能 | 造出第二个事实来源，且与上游语义必然不同 | 报告缺失 + 指引安装；本技能已内化的规范继续适用 |
| 6 | 代用户发起用户调用类技能（`implement`/`to-tickets`/`handoff`/`setup-*`） | 编排权在用户，上游两套规范都如此规定 | 只提示「该环节需要你调用 X」，由用户发起 |
| 7 | 为「跟上上游」通读全量上游仓库 | 上游大部分 skill 与本技能无关，读全量是纯粹的上下文开销 | 只维护被用到的能力；按维护流程表复核 |
| 8 | 清单更新了但内化映射没复核 | 上游语义变了、内化文字没变 → harness 把自己的旧说法当上游要求 | 按「内化映射」表逐条复核受影响的下游 |

## 核实记录

| 日期 | 复核范围 | 方法 | 结论 |
|---|---|---|---|
| 2026-09-17 | 两套仓库的被用能力 | 读 `SKILL.md` frontmatter 的 `disable-model-invocation`，抽查 matt `implement`/`to-tickets`/`to-spec`/`handoff`/`tdd`/`code-review`/`domain-modeling` 与 addyosmani `incremental-implementation`/`test-driven-development`/`planning-and-task-breakdown`/`code-review-and-quality` | matt：`implement`/`to-tickets`/`to-spec`/`handoff` 为用户调用，`tdd`/`code-review`/`domain-modeling` 为模型可调用；addyosmani 抽查项全部为模型可调用（其编排权由 slash command 与 persona 层承担） |

上游变动后请追加一行，**不要覆盖历史**——核实记录的价值在于能看出清单是什么时候对齐的。
