# darwin 2026-10-10 · harness-creator

## 总览

| 项 | 值 |
|---|---|
| 优化 skills | 1（harness-creator，仓内唯一 skill） |
| 轮次 | 2（Round 1 + 收敛修复），第 2 轮按 HL-4 触顶 break |
| keep / revert | 2 / 0 |
| 实测验证 | dim8 3 prompt × 双臂 = 6 次子代理实跑，0 次 dry_run |
| 结构维基线 | 71.4/77（92.7%） |

## Phase 1 基线

结构维（judge StructA，权重合计 77）：

| 维度 | 权重 | 分 | 加权缺口 |
|---|---:|---:|---:|
| dim1 Frontmatter | 7 | 9.5 | 0.35 |
| dim2 工作流 | 12 | 8.5 | **1.80** |
| dim3 失败模式 | 12 | 9.5 | 0.60 |
| dim4 检查点 | 6 | 9.5 | 0.30 |
| dim5 可执行具体性 | 18 | 9.0 | **1.80** |
| dim6 资源整合 | 4 | 9.5 | 0.20 |
| dim7 整体架构 | 12 | 9.5 | 0.60 |
| dim9 反例黑名单 | 6 | 10.0 | 0.00 |

机械事实：runtime 红灯 0；软化措辞 0；AI 腔词 0；description 765B（上限 1024）。

dim8 实测（每臂要求回报实际命令 + 退出码，baseline 臂明令禁读技能目录）：

| Prompt | with_skill | baseline | 判读 |
|---|---|---|---|
| A 文档仓建 harness | 停在写盘前 CHECKPOINT，0 文件落盘 | 建 2 文件，未提交 | baseline 更能交付 |
| B lint 未接线 | 门禁直接报 `defined but not wired` | 自己写脚本人工比对才发现 | **skill 胜**：载体 vs 人工 |
| C 第三方块共存 | 追加成功 + sha256 自证 + 幂等 | 独立推出近似方案 | 打平 |

**基线的真正价值在 B 臂**：skill 的增益不是「能不能发现」，而是「发现是否长在工具里」。BaseB 自己写脚本也能发现 lint 未接线，但那是每次会话要重新推导的一次性动作；WithB 是门禁输出里的一行。

## 本轮修的七条缺陷

| # | 缺陷 | 来源 | 严重度 |
|---|---|---|---|
| 1 | 默认分层无开关，`--dry-run` 计划 4 文件而用户授权 2 个，遵守技能的唯一路径是全不建 | dim8 实跑 | HIGH |
| 2 | 黑名单第 2 行教的是 `TASK_OLD_FORMS` 列为必须 FAIL 的退役旧句 | 复审 | HIGH |
| 3 | `switchClearsRoute` 恒真：把路由词改成无条件输出，自检仍 exit 0 | 三 judge 独立证伪 | HIGH |
| 4 | 默认路径启动句把「细则」渲染成第四个文档名（每会话必读第一行） | paired 实跑 | HIGH |
| 5 | 删除动作那一步的 🔴 CHECKPOINT 被降级——恰是最需要刹车的一步 | paired | MEDIUM |
| 6 | 「无锚不得标完成」与 `--no-verification` 冲突（该形态的 init.sh 不打印锚） | paired | MEDIUM |
| 7 | 细则节进占位符后 `diffSections` 点不出它，`--blueprint` 路径留下孤儿文档 | paired | MEDIUM |

其中 **3 与 4 是本轮自己引入的**——两条都由三名 judge 各自独立查出。

## 判据纪律

新增的三条臂都经变异打红，不是恒绿：

| 变异 | 结果 |
|---|---|
| `--no-agents-layer` 仍写层文件 | `writes neither document: WROTE` → FAIL |
| 关闭时产物清单仍列细则路径 | `leaves no route to them: DANGLING` → FAIL |
| `LAYER_ROUTE` 恒为「、细则」 | 旧判据 exit 0（恒绿）；改判据后 → FAIL |
| 给开关赋值 | 非零退出 |

第一次做变异实验时，我把还原与采样并发跑，采到的是已还原的树，一度误判「新臂恒绿」。重做成串行后才拿到真实结论——**实验设计错误伪装成了产品缺陷**，差点改错方向。

## 预算

TrimAudit 逐处核实后清出 329B 冗余（5 处，每条附门禁零命中的 grep 自证）。本轮修复又净增，SKILL.md 已无冗余可删。

按用户裁定上限 1.5× → 1.6×，常量处写明是为哪些缺陷付的账。判据 `multiplierSane` 原硬编码 1.5，改为跟随常量——否则这次放宽会以错误的原因失败。

## 未闭合

| 项 | 说明 |
|---|---|
| dim2 加权缺口 1.80 | 「更新 harness」第 2-5 步只有名字串，无逐步产出物。两条主改进需净增约 414B，宜先观察新上限是否够用 |
| 安装副本落后 | `~/.agents/skills/harness-creator/SKILL.md` 14521B，缺 `Evidence anchor` 与 `## 细则`。dim8 实测必须显式指向仓库 HEAD，刷新需用户决定 |

## 收敛判据

HL-4：连续两轮 judge 的 new_problems 都指向同一族（声明与载体不符），修完后剩余项需要净增 414B 且新上限刚放宽。按「见好就收」break，不硬凑 MAX_ROUNDS。