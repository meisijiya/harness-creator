# 异常与边界条件（Failure Modes）

harness 创建与审计流程假设环境理想，实操必有异常。按下表处理：**先告知用户再执行，绝不静默跳过。**

| 触发条件 | 一线修复 | 仍失败兜底 |
|---|---|---|
| `create-harness` 目标已有同名文件 | 默认跳过并告知用户 | 🔴 批准后才用 `--force`，先列覆盖清单 |
| 目标已有 `CLAUDE.md` | 沿用并编辑 `CLAUDE.md`，**不另建 `AGENTS.md`**（matt 的互斥不变量） | 用户显式要求两个文件时才用 `--agent-file` 覆盖 |
| AGENTS.md 已含其他工具的块（如 matt setup 的 `## Agent skills`） | 不跳过不覆写：保留现有全部内容，仅追加缺失的 harness 章节（分区见 [Matt Coexistence](./matt-coexistence.md)） | 向用户展示合并结果，确认后再写入 |
| 无法识别项目栈或包管理器 | 用 `--package-manager` 与 `--commands` 显式指定 | 退化为占位验证命令，交付说明中标记必须替换 |
| `validate` 总分 < 70 | 最低分子系统作为候选瓶颈，给前 2-3 项改动 | 先用失败记录确认因果再改；不堆关键词刷分 |
| 模式探测信号矛盾或缺失 | 按信号重判：`CONTEXT.md`/ADR/`.scratch/`/matt `docs/agents/`/工单系统 | 转「第一步」第 2 步的 🔴 CHECKPOINT（询问仓库用途） |
| tracker 模式但未见工单基础设施 | 默认用户已运行 `setup-matt-pocock-skills`：只建本方骨架（AGENTS.md 章节、`init.sh`、`.scratch` 约定），matt 名下产物列为待办 | 提示用户先运行 setup；`CONTEXT.md`/ADR 由 domain-modeling 延迟创建，缺失不是缺陷；不提供仓内 tracker 替代 |
| 有 `docs/agents/*` 但无 `CONTEXT.md` | 仍判 tracker 模式——延迟创建是正常状态，不因缺 `CONTEXT.md` 回退 registry | 仅当 `docs/agents/` 内容自相矛盾时才向用户确认模式 |
| 无法创建文件（权限/只读） | 改为输出确切文件内容与命令 | 全部以文本交付并标注目标路径 |
| 运行环境无 Node，脚本不可用 | 按 `templates/` 手工创建四个产物 | 交付模板内容与手工验证命令 |
| `run-benchmark` 自检 FAIL | 视为 skill 自身损坏，先修脚本再交付 | 不交付未通过自检的模板改动 |
| `init.sh` 基线验证失败 | 先修复基线，再添加新工作范围 | 标记需人工评审，不叠加新功能 |

## 补充原则

- **异常先告知**：任何 fallback 触发都先向用户说明发生了什么、将采取什么动作，再执行。
- **不静默降级**：占位验证命令、手工交付、模式回退都必须显式标记，让用户知道哪些部分需要后续替换。
- **不代建他人产物**：matt 名下的 `docs/agents/*`、`CONTEXT.md`、`docs/adr/`、`## Agent skills` 块只读或列待办；缺失时指引用户运行对应 skill，不复制其内容、不预建空壳（见 [Matt Coexistence](./matt-coexistence.md)）。
- **自检优先**：`run-benchmark` 自检未通过时，skill 产物不可信——先修 skill，再谈交付。
