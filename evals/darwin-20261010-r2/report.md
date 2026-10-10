# darwin 2026-10-10 轮次 R2 · harness-creator

## 总览

| 项 | 值 |
|---|---|
| 分支 | `auto-optimize/20261010-r2`（自 `e6ab30c` 起） |
| 优化 skills | 1（harness-creator，仓内唯一 skill） |
| 轮次 | 2（Round 1 dim5、Round 2 dim8） |
| paired 裁决 | **2-1 better**（margin: slight × 2）→ keep |
| 回填缺陷 | 6 条（5 条自引入 / 1 条先于本轮存在） |
| 预算 | 15453 → 16008 / 16464（余 456B） |

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
| Orphan declarations | `246 声明全部被读 / 24 组键双向相等` |
| `check-links.mjs` | 18 links OK |
| SKILL.md 预算 | 16008 / 16464（余 456B） |

## 收敛判据

HL-4：两轮 judge 的 new_problems 均已回填并通过反向证明；剩余项（dim2「更新 harness」五步缺逐步输入/输出，缺口 1.20；缺陷 6 的孤儿文档形状）需要净增且触及新主题。按见好就收 break，不硬凑 MAX_ROUNDS=3。

## 未闭合

| 项 | 说明 |
|---|---|
| dim2 加权缺口 1.20 | 「更新 harness」第 2-5 步只有名字串，无逐步产出物。上一轮因预算搁置，本轮余量 456B 仍偏紧 |
| 缺陷 6 | 已有 AGENTS.md 时补跑 `--spec-layer` 产生孤儿文档（先于本轮存在，需改退出行为） |
| dim8 覆盖面 | 本轮只跑 1 个 prompt × 1 臂；26 条 test-prompts 未全跑，`dry_run` 占比高 |
| 安装副本 | `~/.agents/skills/harness-creator` 仍落后，dim8 实测须显式指向仓库 HEAD；刷新需用户决定 |