# PROGRESS — 规范层 + 旁路观测（4 步）

目标：给 harness-creator 加 `--spec-layer` 开关与旁路观测支撑，不动 init.sh 的纯门禁定位。
顺序：1 入口引用 → 2 --spec-layer → 3 旁路观测文档 → 4 门禁与文档同步。每步独立提交。
基线（2026-10-08 实测）：20 组全 PASS / exit 0；SKILL.md 12835/12862（余 27B）；AGENTS.md 3372/4036（余 664B、26 行、3 条规则）。
最大风险：两个预算都是硬墙（27B / 664B），新措辞必须靠**删本仓冗余**换出，且不许碰 FORBIDDEN 禁项。
入口路径定为 `./verify.sh`（领导未指定，我拍板；如与现有步骤冲突改名并记此）。

## 步骤 1 — `--add-check-entry`（已完成）
做了什么：`--add-check-entry PATH` 在门禁里加**一行**无守卫调用；写盘前拒绝对路径 / `..` / 空格与元字符 / 不存在 / 目录 / 空文件。
自检摘要：`init.sh growth` 组新增 6 臂全 ok（单行调用 / 无守卫 / 重复是 no-op / 缺失被拒 / 路径规则有牙 / 入口没了门禁变红），20 组仍全 PASS，exit 0。
反向验证（亲手制造失败，原始输出）：
- 入口被移走 → `=== ./verify.sh ===` → `No such file or directory` → `=== Verification FAILED ===`，**EXIT=127**；
- 入口存在但不可执行（EACCES，NTFS 上 `chmod -x` 是空操作，故用目录占位走同一条 EACCES 路径）→ **EXIT=126**。
变异测试（4 条，探针从 run-benchmark.mjs 真表读取，不复制）：删 `..` 规则 → 2 行漏；删绝对路径规则 → 2 行漏；从字符类去掉空白 → 1 行漏；阳性对照「什么都拒」→ 4 行漏。还原后 0 漏。
SKILL.md：12835 → **12848**/12862（余 14B），靠删同族冗余换出，**未动上限**。
AGENTS.md：未改动（本步骤不碰生成物），仍 3372/4036、64/90 行。

## 步骤 2 — `--spec-layer`（已完成）
做了什么：默认关闭；给了才生成 `mission.md` / `tech-stack.md`。指针挂在现有第 3 步行尾，**不加行**。
默认零变化（硬要求，已实测）：用 `git worktree` 拉 HEAD 单独渲染，与工作树渲染逐字节比对，
`AGENTS.md` identical: True、`init.sh` identical: True，文件集同为 2 个。
反向验证：造一个**有** `package.json` + `tsconfig.json` 的仓（栈确实被检测到，`tech-stack.md` 写着
`typescript`），不带 `--blueprint` 渲染 → `mission.md` 零栈相关词，只有 3 处「待补」。
新增 `specLayer` 自检组（第 21 组），7 臂：默认未变 / 开关生成两份 / 栈不进使命 / 按需读非常驻 /
同一预算 / 重复跑不覆盖 / 开关带值被拒。变异测试两条各自变红：使命改由栈推断 → `LEAKED`；
开关默认开 → `CHANGED`。
预算：AGENTS.md 带指针 3396/4036、64/90 行（起点 3372、64 行 → **净用 24 字节、0 行**）；
工作规则仍 5/8 条。
SKILL.md：12848 → **12840**/12862（余 22B）。删的是重复不是内容：第 4 步里重复问的那句问题、
「确实」「真实用户的」「由项目自己决定」等同族冗余、`~/.agents/skills/...` 这个「规则已说明后举实例」、
以及交付清单里与异常表重复的「无法写盘时」那句（改指向上表）。**未动上限。**

## 步骤 3 — 旁路观测文档（已完成）
`references/bypass-observation-pattern.md`：只出设计、不接管写入。四块按要求到位——
「独立于模型」的可判定判据（入口脚本首次作者是人，用 `git log --diff-filter=A` 读，不靠推理；
并明说**不要**用「覆盖是否关键」来判断独立性）、高位模块优先（按失败不可逆性排序，并明说不从
「已有一半测试」处起手）、只增不修（转绿后冻结；放宽断言比新增更危险）、反向验证要求
（贴原始输出 + 非零退出码 + 必须还原 + 门禁红才算数，并把 `git checkout --` 恢复到 HEAD 会连带
丢未暂存改动、且表现为 `git status` 干净这条具体坑写进去了）。

## 步骤 4 — 门禁与文档同步（见收口）
新检查器五处登记点已对齐（`specLayer` 组）：SELF_CHECK_GROUPS、SELF_CHECK_REPORT_LINES、
checkSpecLayer()、CONSOLE_GROUP_LABELS、pass 合取，外加 `--help` 第 25 条 `[specLayer]` 标注。
`noDeadDecls` 实测 26 条编号 vs 21 组键，双向相等；`reportCoverage` PASS。README 已同步，
且**未复述关卡条数**（按原文约定）。