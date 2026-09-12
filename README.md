# harness-creator

一个用于围绕 AI 编码代理构建与审计 harness 的紧凑型技能。

它帮助仓库为代理提供五样必需品：指令、状态、验证、范围边界与生命周期交接。

## 安装

```bash
npx skills add walkinglabs/learn-harness-engineering --skill harness-creator
```

或将 `skills/harness-creator/` 复制到你的技能路径中。

## 使用

```bash
node skills/harness-creator/scripts/create-harness.mjs --target /path/to/project
node skills/harness-creator/scripts/validate-harness.mjs --target /path/to/project
node skills/harness-creator/scripts/run-benchmark.mjs --target /path/to/project --html /path/to/report.html
```

这些脚本仅使用 Node.js 内置模块。将技能目录复制到其他仓库后即可直接运行。

## 它会创建什么

- `AGENTS.md` 或 `CLAUDE.md`
- `feature_list.json`
- `progress.md`（精简版：当前状态、证据、阻塞、下一步）
- `init.sh`

会话交接是约定而非仓库文件：引用式交接文档写在 `.scratch/handoff.md` 或临时目录。tracker 模式（`CONTEXT.md` + ADR + issue tracker 承接状态）见 SKILL.md 的"两种模式"一节。

`create-harness.mjs` 可检测常见的项目类型与包管理器。在基础验证命令层面支持 Node/npm/pnpm/yarn/bun、Python、Go、Rust、Maven、Gradle 和 .NET。

## 它会检查什么

`validate-harness.mjs` 对五个 harness 子系统进行评分：

1. 指令
2. 状态
3. 验证
4. 范围
5. 生命周期

得分是结构性的。它告诉你 harness 是否存在且自洽；不能替代真实的前后对照代理会话测试。

## 状态

- [x] 最小化 harness 脚手架
- [x] 五子系统验证
- [x] HTML 评估报告
- [x] 结构性基准报告
- [x] 10+ 个评估用例（含 tracker 模式集成）
- [x] 双模式治理：registry（仓内注册表）与 tracker（工单驱动，CONTEXT.md + ADR）
- [x] 常见技术栈的通用验证检测
- [ ] 可选的真实前后对照代理会话回放

## 文件

```text
harness-creator/
├── SKILL.md
├── metadata.json
├── agents/openai.yaml
├── scripts/
│   ├── create-harness.mjs
│   ├── validate-harness.mjs
│   ├── render-assessment-html.mjs
│   ├── run-benchmark.mjs
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
