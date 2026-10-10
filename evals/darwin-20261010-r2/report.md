# darwin 2026-10-10 轮次 R2 · harness-creator

## 总览

| 项 | 值 |
|---|---|
| 分支 | `auto-optimize/20261010-r2`（自 `e6ab30c` 起） |
| 优化 skills | 1（harness-creator，仓内唯一 skill） |
| 轮次 | 4（Round 1 dim5、Round 2 dim8、Round 3 孤儿+dim2、Round 4 dim8 覆盖） |
| paired 裁决 | **2-1 better**（margin: slight × 2）→ keep |
| 回填缺陷 | 8 条（6 条自引入 / 1 条先于本轮存在 / 1 条由 dim8 实测查出） |
| dim8 实测 | 4 次子代理实跑（1 + 3×双臂），**0 次 dry_run** |
| 预算 | 15453 → 16285 / 16464（余 179B） |

## Phase 1 基线

结构维 70.60/77（judge StructScore，权重合计 77）：

| 维度 | 权重 | 分 | 加权缺口 |
|---|---:|---:|---:|
| dim1 Frontmatter | 7 | 10 | 0.00 |
| dim2 工作流 | 12 | 9.0 | 1.20 |
| dim3 失败模式 | 12 | 9.5 | 0.60 |
| dim4 检查点 | 6 | 9.5 | 0.30 |
| **dim5 可执行具体性** | **18** | **8.5** | **2.70** |
| dim6 资源整合 | 4 | 9.0 | 0.40 |
| dim7 整体架构 | 12 | 9.0 | 1.20 |
| dim9 反例黑名单 | 6 | 10 | 0.00 |

runtime 红灯 0；description 292B；软化词 0；AI 腔词 0。

## 两轮改了什么

**Round 1（dim5，commit `0c814e9`）**

- SKILL.md 选项行补 `--self-check-only`——此前 L135 要求代理在自检 FAIL 时「先修脚本」，而全文 `grep "run-benchmark.mjs --self-check"` 零命中，等于让代理去修一个它不知道怎么跑的检查。
- L105 把 check-links 的作用域从「在 `./init.sh` 里判定」改成明确的「本仓/技能目录」，实测 `templates/init.sh` 对 check-links 零命中，只有仓根 `init.sh:76-77` 跑它。

**Round 2（dim8，commit `b63b9d7`）**

`--dry-run` 输出新增一段「可选规范层」提示。动机来自 dim8 实跑：代理读懂了「有证据就加问」这条规则、也正确检测到了 `package.json`，但一次自洽的 dry-run 给了它**零个可问的东西**——清单里没有 `mission.md`/`tech-stack.md`，也不提 `--spec-layer`。判据的唯一载体是散文。

## paired 复评：2-1 better

| judge | verdict | margin |
|---|---|---|
| JudgeX1 | better | slight |
| JudgeX3 | better | slight |
| **JudgeX2** | **worse** | slight |

多数决 keep，但 2-1 不是 3-0，强度弱；且三名 judge 各自报出的 `new_problems` 有六条重叠，**按缺陷清单全量回流修**，不因 keep 而放过。

## 六条缺陷与归属

| # | 缺陷 | 归属 | 归属依据 |
|---|---|---|---|
| 1 | `--self-check-only` 挂在 `create-harness.mjs` 名下 | **自引入** | 实测该串在 create-harness 零命中，`parseArgs` 静默接受未知 flag；实跑 exit 0 且写出全套产物 |
| 2 | 提示判据含 `!noAgentsLayer`，文档无此条 | **自引入** | 实测 `--no-agents-layer` 时提示数 0 |
| 3 | 判据 `stack !== 'generic'` ≠ 文档「包清单」 | **自引入** | 实测纯 `go.mod` 仓打印提示；`detectProject` 覆盖 8 类清单文件 |
| 4 | 「逐字节相同」四处断言只改一处 | **自引入** | SKILL.md / `--help` / 注释 / README:168 四处口径分叉 |
| 5 | 新 stdout 行为零机器载体 | **自引入** | `checkSpecLayer` 原有十臂无一断言提示出现与否 |
| 6 | 已有 AGENTS.md 时补跑产生孤儿文档 | **先于本轮存在** | 回退到 `772d285` 用改前版脚本跑同一场景，指令文件指向数同为 0 |

第 1 条的成因值得记下：上一轮只 grep 了「SKILL.md 里有没有这个开关」，没 grep「它属于哪个脚本」——**把「存在」当成「可用」**。这与本仓记忆里已归档的两类误判同族。

第 6 条本轮未修，理由是它不是本轮引入、且修它要改 `--spec-layer` 的既有退出行为，属于另一个主题。按 darwin 单变量纪律留给下一轮。

## 判据纪律

### dim8 的「没问」是测量假象

dim8 实跑报 `asked_about_spec_layer=false`。子代理在报告里自述：它读出了「检测到 package.json → 按第一步第2条应加问」并**拟出了原话**，缺的是提问出口——子代理跑到底即结束，没有交互通道可等回复。**规则被正确读到并触发了决策**，缺的只是提问的载体。按「先怀疑采样时序」的判据处理，不计入缺陷。

### 变异实验自身出过错

新臂首轮反向证明时，我把提示改成 `X-OFF: Optional…` 前缀而非删除，两条臂仍报 ok。原因是断言用 `stdout.includes(HINT_LINE)` 子串匹配——**变异选错不等于臂无牙**。重做为真正注释掉两行 console.log，两臂同时打红（`SILENT` + `PREVIEW ONLY`），还原后回绿。

另一次：还原用的备份文件在 restore 函数里被自己 `rm`，导致第二次还原失败、文件停在变异态。靠 `git diff` 核实后才恢复——**trap 兜底也会被自己写坏**。

## 门禁结果

| 验证 | 结果 |
|---|---|
| `run-benchmark.mjs --self-check-only` | **exit 0**，24 组全绿 |
| Spec layer 新三臂 | `hint appears: ok` / `stays silent: ok` / `real run carries it: ok` |
| Dry run | `plan matches the real run: ok` |
| Report coverage | `ok`（分组数仍 24，未新建分组） |
| Orphan declarations | `248 声明全部被读 / 24 组键双向相等` |
| Agent-file invariant | 新增 `artifacts point at the file this repo actually uses: ok`、`never denies what the run wrote: ok` |
| `check-links.mjs` | 18 links OK |
| SKILL.md 预算 | 16285 / 16464（余 179B） |

## 收敛判据（Round 3 时）

HL-4：两轮 judge 的 new_problems 均已回填并通过反向证明；剩余项（dim2「更新 harness」五步缺逐步输入/输出，缺口 1.20；缺陷 6 的孤儿文档形状）需要净增且触及新主题。按见好就收 break，不硬凑 MAX_ROUNDS=3。

两项随后在 Round 3 闭合，Round 4 补 dim8 覆盖面——见下。

## Round 4（commit `68194be`）· dim8 覆盖面

3 prompt × 双臂 = 6 次子代理实跑，**0 次 dry_run**（darwin 规定 dry_run 占比 > 30% 则 dim8 失效）。with_skill 读仓库 HEAD `25af458`，baseline 明令禁读技能目录——两臂必须分开，同一 agent 既读技能又做 baseline 会污染对照。

| Prompt | with_skill | baseline | 判读 |
|---|---|---|---|
| A 更新 harness | 拿 `validate-harness` 的 FAIL 行当证据，用「最低分只是候选瓶颈」挡住刷分 | 纯人工比对字面措辞 | **skill 胜**：证据来源 + 因果判据 |
| B 已有 CLAUDE.md | 不另建 AGENTS.md；`--force` 被拒且理由用结构判据；第三方块存活 | 建了独立 AGENTS.md，仅单向文字指针 | **skill 胜** |
| C 空目录建 harness | `--dry-run` 先行；蓝图留「待补」，四份产物零处提到录音/转写 | 写了「待确认」清单，未编造 | 打平 |

**W1 最能说明增益在哪**：它得分 53→73，而 `scope` 仍停在 1/5 未动——因为它判「本会话无越界样本，不动」，并明写「若为提分而补会是 93+/100 且 4 条虚构规则」。baseline 同样发现了三条失准，但它靠字面比对，且自陈「没有反向证明，删除判据全靠直觉」。**增益不在发现能力，在证据来源与因果判据。**

**W3 意外验证了一条本仓记忆里的教训**：fixture 嵌在 harness-creator 仓内，`init.sh` 因 `--show-prefix` 判出无自身 commit 而拒绝记录外层 sha 并 `exit 1`。这正是「`git rev-parse` 向上穿透」那条防御在真实场景下拦住了假锚。

### 两条缺陷（W2 查出，独立复现后确认）

1. **stdout 自相矛盾**。细则层被追加进既有指令文件时，同一次输出既打印 `APPENDED CLAUDE.md` 又打印 `CLAUDE.md already exists and was NOT written`。两句都在一次 run 里，用户核对「别动它」时相信的恰是错的那半句。
2. **产物孤儿指针**。`init.sh` 与两份细则硬编码 `AGENTS.md`，目标仓用 `CLAUDE.md` 时全部指向不存在的文件。

### 但 W2 的判定要拆分

它把「默认路径修改了既有文件」报为最严重。这条**不成立**：`appendPreserves` 断言的正是「原有字节逐字不变」，而追加 `## 细则` 是被 `checkAgentsLayer` 固定、并带幂等臂的有意设计。真正成立的只有 stdout 那半句矛盾。判读纪律：**复评报的缺陷要逐条复现，并区分「真缺陷」与「把已固定的设计当违规」。**

## 实验纪律：第三次给错前提

派发占位符任务时我让 agent 改 `templates/init.sh:274`。它不是生成器读的模板，而是**手工兜底**，被 `nextSteps` 门禁与 `NEXT_STEPS` 字面量逐字节比对——加占位符会打红门禁。agent 识别出这点，改在生成器的写入点替换，`templates/init.sh` 与门禁文件均未动。

判据：**让 agent 改某个模板前，先确认该模板由谁渲染、是否被门禁按字面比对。** 本轮三次派发里错了三处（`TASK_OLD_FORMS`/`MAINT_GUARDS` 的读取对象、这里的模板性质、上一轮的 CRLF sed 锚点）——派发前的核实成本低于返工。

## 未闭合

| 项 | 说明 |
|---|---|
| ~~dim2 加权缺口 1.20~~ | **已闭合**（`4f872ae`）：五步改为逐步「输入 → 输出」，改写而非增写 |
| ~~缺陷 6 孤儿文档~~ | **已闭合**（`4f872ae`）：告警 + `exit 1`，门禁两臂反向证明 |
| ~~dim8 覆盖面~~ | **已闭合**（`68194be`）：3 prompt × 双臂实跑，0 dry_run |
| ~~安装副本~~ | **已闭合**：`npx skills update` 后与仓库逐字节一致，安装副本自测全绿 |
| dim8 更深覆盖 | 本轮 3 prompt 覆盖创建/更新/既有文件三类路径；**未覆盖**「代理在真实多轮会话里连续工作」——单轮子代理无法观察跨会话的触发键是否真的生效 |
| 非交互路径的兜底 | W2 指出：SKILL.md 只为「蓝图未陈述 → 留待补」规定了非交互兜底，规范层这一问没有明文。W2 自己做了判断（不加 `--spec-layer`），但那是它的判断不是文档的规则 |

## Round 3（commit `4f872ae`）

**孤儿文档缺陷闭合**（先于本轮存在，2026-10-10 记为未闭合）。已有 `AGENTS.md` 时补跑 `--spec-layer`，两份文档落盘但 `SPEC_LAYER_NOTE` 进不了指令文件——而指令文件是代理每会话唯一必读的文件，于是代理下次会话根本不知道这两份存在。判据取「本次运行内有文档 written 且 `AGENTS.md` 非 written」，所以幂等重跑（全 SKIPPED）不报警。退出码取 `1`，与 `--force` 拒绝、`--blueprint` 定位不到槽位两处先例一致：状态行读起来是成功交付，代理停在 `WRITTEN` 就报完成，正是本仓要消灭的静默降级。门禁补 `orphanSpecWarned`（含退出码，经 try/catch 读）与 `idempotentSilent` 两臂。

**dim2 缺口闭合**。「更新 harness」五步原为纯名字串，改为逐步「输入 → 输出」，沿用本文件常见任务表的同一形状。

## 预算：为什么没删任何东西

先做了只读预算调查（scout）。结论与上一轮的 TrimAudit 一致：**在不损失任何在起作用的判据的前提下，只能腾出约 75B**（L34 部分 20B + L146 部分 33B + L105 压缩 22B），远不够 414B。

但 414B 这个估算是按**增写**算的，而实际是**替换**那句名字串——按本仓任务表已有的体裁写约 277B。因此不需要删任何内容，`SKILL.md` 16008 → 16285/16464，余 179B。

调查同时更正了我派发时的两处错误前提：`TASK_OLD_FORMS` 读的是**生成的** `AGENTS.md`（`run-benchmark.mjs:687`），`MAINT_GUARDS` 读的是 `references/harness-maintenance-pattern.md`（`:722`）——两者都不读 SKILL.md。真实受 SKILL.md 断言保护的只有 `## 设计规则` 节与「更新」表格行两处。

## 实验纪律：又一次变异选错

ARM D 首轮用 `sed "s/^  process.exitCode = 1;$/.../"` 想把退出码改成 0，但 Windows CRLF checkout 下行尾 `\r` 使 `$` 锚点失配，**sed 根本没命中**；脚本又因未加 `set -e` 继续跑完，输出一个「PASS」。若采信，就是拿未变异的树当反向证明的证据。改用行号定位 `sed "862s/…/…/"` 后才拿到真的 `FAIL`（`reported as orphaned, non-zero: SILENT`）。

这是本轮第二次变异选错（第一次是 `X-OFF:` 前缀没删掉内容），两次都被「门禁仍绿」暴露。判据：**变异实验必须先确认 sed/替换真的改动了目标**，再读门禁结论。