# 异常与边界条件（Failure Modes）

harness 创建与审计流程假设环境理想，实操必有异常。按下表处理：**先告知用户再执行，绝不静默跳过。**

| 触发条件 | 一线修复 | 仍失败兜底 |
|---|---|---|
| `create-harness` 目标已有同名文件 | 默认跳过并告知用户 | 🔴 批准后才用 `--force`，先列覆盖清单 |
| 目标已有 `CLAUDE.md` | 沿用并编辑 `CLAUDE.md`，**不另建 `AGENTS.md`**（matt 的互斥不变量） | 用户显式要求两个文件时才用 `--agent-file` 覆盖 |
| AGENTS.md 已含其他工具的块（如 matt setup 的 `## Agent skills`） | 不跳过不覆写：保留现有全部内容，仅追加缺失的 harness 章节（分区见 [Matt Coexistence](./matt-coexistence.md)） | 向用户展示合并结果，确认后再写入 |
| 无法识别项目栈或包管理器 | 用 `--package-manager` 与 `--commands` 显式指定 | 退化为占位验证命令，交付说明中标记必须替换 |
| `validate` 总分 < 70 | 最低分子系统作为候选瓶颈，给前 2-3 项改动 | 先用失败记录确认因果再改；不堆关键词刷分 |
| 模式探测信号矛盾或缺失 | 按信号重判：matt `docs/agents/`/`CONTEXT.md`/ADR/工单系统——`.scratch/` **不算**信号（第三方 skill 也会写它） | 转「第一步」第 2 步的 🔴 CHECKPOINT（询问仓库用途） |
| tracker 模式但未见工单基础设施 | 默认用户已运行 `setup-matt-pocock-skills`：只建本方骨架（AGENTS.md 章节、`init.sh`、`.scratch` 约定），matt 名下产物列为待办 | 提示用户先运行 setup；`CONTEXT.md`/ADR 由 domain-modeling 延迟创建，缺失不是缺陷；不提供仓内 tracker 替代 |
| 有 `docs/agents/*` 但无 `CONTEXT.md` | 仍判 tracker 模式——延迟创建是正常状态，不因缺 `CONTEXT.md` 回退 registry | 仅当 `docs/agents/` 内容自相矛盾时才向用户确认模式 |
| 追踪探测报 `stray`（落点存在却既未提交也未忽略） | 一次性询问用户裁决：提交，或加确切模式进 `.gitignore` | 保持 `stray` 并记为 AGENTS.md 待办，不代替用户决定 |
| 落点已被跟踪却出现在 `.gitignore`（无效 opt-out） | 说明 gitignore 对已提交文件无效，按 `tracked` 处理 | 用户决定 `git rm --cached` 时由用户执行，本技能不代做 |
| 无 git 或目标非仓库 | 追踪探测降级为 `unknown`，改为一次性询问全表 | 结论仍落 AGENTS.md 的「产物追踪策略」节 |
| 第三方 skill 产物落在五落点之外（`CONSTRAINTS.md`、`teach` 工作区等） | 先路由回五落点（任务级默认 `.scratch/`；`teach` 以 `.scratch/teach/` 为 cwd）；产出 skill 自带**硬约束**（落点不可配置）时走受控放行：登记豁免 + 用户裁决（原样保留／收归治理）+ 追踪结论，**不治理**其内容与形态 | 路由不进、又援引不出硬约束才拒绝（反例 #9）；放行项一旦承担事实职责即收归五落点 |
| 放行项（豁免清单）产生 `.gitignore` 未覆盖的新文件 | 探测时用 `--paths` 带上豁免路径 | 出现 `stray` 即问一次，不静默忽略 |
| 用户拒绝裁决放行项（既不放行也不收归） | 保持未决并写入 AGENTS.md 待办 | 标为未决项：不代替用户决定，也不静默放行 |
| 无法创建文件（权限/只读） | 改为输出确切文件内容与命令 | 全部以文本交付并标注目标路径 |
| 运行环境无 Node，脚本不可用 | 按 `templates/` 手工创建四个产物 | 交付模板内容与手工验证命令 |
| `run-benchmark` 自检 FAIL | 视为 skill 自身损坏，先修脚本再交付 | 不交付未通过自检的模板改动 |
| `init.sh` 基线验证失败 | 先修复基线，再添加新工作范围 | 标记需人工评审，不叠加新功能 |

## 补充原则

- **异常先告知**：任何 fallback 触发都先向用户说明发生了什么、将采取什么动作，再执行。
- **不静默降级**：占位验证命令、手工交付、模式回退都必须显式标记，让用户知道哪些部分需要后续替换。
- **不代建他人产物**：matt 名下的 `docs/agents/*`、`CONTEXT.md`、`docs/adr/`、`## Agent skills` 块只读或列待办；缺失时指引用户运行对应 skill，不复制其内容、不预建空壳（见 [Matt Coexistence](./matt-coexistence.md)）。
- **不代改 `.gitignore`**：追踪策略只给出确切行，经 🔴 CHECKPOINT 批准后再写；静默修改会让用户的表达失去可追溯性（见 [Git Tracking Alignment](./git-tracking-alignment.md)）。
- **放行不等于不看见**：受控放行只免除"搬移与改造"（不治理），不免除登记、用户裁决与追踪结论——三者缺一即回落为"拒绝引入"。
- **自检优先**：`run-benchmark` 自检未通过时，skill 产物不可信——先修 skill，再谈交付。
