# 与 mattpocock/skills 共存（tracker 模式）

matt 的 `setup-matt-pocock-skills` 与本技能都会在 tracker 模式的仓库里落文件。两者**不是并列的骨架生成器**，而是**分区所有权**：同一产物只允许一个写入者，否则必然漂移。

## 单一写入者分区

| 产物 | 唯一写入者 | 创建时机 | harness 的动作 |
|---|---|---|---|
| `docs/agents/issue-tracker.md` | matt setup | setup 运行时 | 只读；兼作 tracker 探测信号与状态路由 |
| `docs/agents/domain.md` | matt setup | setup 运行时 | 只读；兼作 tracker 探测信号 |
| `docs/agents/triage-labels.md` | matt setup | 仅 `triage` 已装时 | 只读 |
| `AGENTS.md`/`CLAUDE.md` 的 `## Agent skills` 块 | matt setup | setup 运行时 | 保留不写，只追加本方章节 |
| `CONTEXT.md` | matt 的 `domain-modeling` | **延迟**——首个术语定稿时 | 不预创建；已存在则只读路由 |
| `docs/adr/` | matt 的 `domain-modeling` | **延迟**——首个 ADR 需要时 | 不预创建；已存在则只读路由 |
| `AGENTS.md`/`CLAUDE.md` 其余章节、`init.sh`/CI | harness | harness 运行时 | 写入/合并 |
| `.scratch/` | 使用方（按需） | 首次写入任务材料时 | 只文档化约定，**不预建空目录** |
| `feature_list.json`、`progress.md` | harness | registry 模式 | tracker 模式不创建 |

## 两个方向的顺序

**setup 先跑（反向）**：仓库有 `docs/agents/*`、AGENTS.md 里已有 `## Agent skills`，但可能**没有** `CONTEXT.md`/ADR（matt 延迟创建）。因此 tracker 模式的探测信号是 `docs/agents/` **或** `CONTEXT.md` **或** ADR 目录——只看 `CONTEXT.md` 会漏判。harness 随后合并自己的章节、落 `init.sh`，不改 matt 名下文件。

**harness 先跑（正向）**：matt 名下产物缺失时 harness **不代建**，只在交付说明里列为待办，指引用户运行 `setup-matt-pocock-skills`。`CONTEXT.md`/ADR 由 `domain-modeling` 在首个术语/决策定稿时创建，此前不存在是**正常状态**而非缺陷。

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
| tracker 模式仍写 `feature_list.json`/`progress.md` | 与工单系统形成第二状态源（黑名单 #1） |
| 因缺 `CONTEXT.md` 就把 matt 配置过的仓库判为非 tracker | 延迟创建被误读为缺陷，用户被推向错误模式 |
