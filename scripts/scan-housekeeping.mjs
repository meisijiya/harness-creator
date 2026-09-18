#!/usr/bin/env node
// harness-creator · 仓库收敛扫描器 —— 只读。
// 输出「将删 / 将留」候选与「未沉淀材料」清单；不写盘、不移动、不删除任何文件。
// 真正的删除由代理在 🔴 CHECKPOINT 取得用户批准之后自行执行。
//
// 同一份只读事实，两种作用域：
//   默认           → 整理仓库（housekeeping）：全仓状态落点，含历史累积。
//   --session-only → 会话收尾（session wrap-up）：只作用于本会话产出，且抑制全仓 prune 候选
//                    （删历史条目属于整理，不属于收尾）。
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { exists, listFiles, parseArgs, readJson, scriptCommand } from './lib/harness-utils.mjs';

const execFileAsync = promisify(execFile);
const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`Usage: ${scriptCommand('scan-housekeeping.mjs')} [--target DIR] [--session-ref REF] [--session-only] [--json]

Read-only scan. One invariant: it never writes, moves or deletes anything.

Two scopes over the same facts:
  - default: the "整理仓库" (housekeeping) flow — repo-wide, including history.
  - --session-only: the "会话收尾" (session wrap-up) flow — SESSION scope only. Routes the
    session's own output across the five landing points, flags session output that sits
    outside every landing point, and SUPPRESSES the repo-wide prune candidates: pruning
    history belongs to housekeeping, not wrap-up.

Reports:
  - detected governance mode and its signals
  - the five landing points, and which are still missing
  - feature_list.json entries that are done WITH evidence (prune candidates)
  - entries marked done WITHOUT evidence (must NOT be pruned)
  - .scratch/ contents, marked current-session / stale / unverified
  - files changed since --session-ref = the current session's scope

--session-ref must be the commit where THIS session started. It is NOT defaulted to
HEAD: assuming HEAD would treat already-committed session work as history and
over-mark it for pruning. When --session-ref is omitted, only uncommitted changes are
treated as definitely-current; everything else is reported as "unverified", never as
"stale".

It never writes, moves or deletes anything. ADR (append-only) and CONTEXT.md (kept
current) are outside the prune scope and are only reported for context.`);
  process.exit(0);
}

const target = path.resolve(args.target || args._[0] || process.cwd());
const explicitRef = args.sessionRef || args._[1] || null;
// Wrap-up scope. Suppresses repo-wide pruning and reports session routing instead.
const sessionOnly = Boolean(args.sessionOnly);

if (!await exists(target)) {
  console.error(`Target directory does not exist: ${target}`);
  process.exit(1);
}

// 五个落点：清账只作用于「状态」这一个；其余仅在报告中列出，提醒勿动。
const LANDING_POINTS = [
  { label: '.scratch/（临时材料）', path: '.scratch' },
  { label: 'CONTEXT.md（领域语言，持续更新，勿删）', path: 'CONTEXT.md' },
  { label: 'docs/adr/（决策，只增不删，勿删）', path: 'docs/adr' },
  { label: 'init.sh / CI（可执行约束）', path: 'init.sh' },
  { label: '状态：feature_list.json 或工单', path: 'feature_list.json' }
];

const present = [];
const missing = [];
for (const point of LANDING_POINTS) {
  (await exists(path.join(target, point.path)) ? present : missing).push(point.label);
}

const modeSignals = [];
for (const signal of ['.scratch', 'CONTEXT.md', 'docs/adr']) {
  if (await exists(path.join(target, signal))) modeSignals.push(signal);
}
const hasFeatureList = await exists(path.join(target, 'feature_list.json'));
const hasProgress = await exists(path.join(target, 'progress.md'));
const mode = modeSignals.length > 0 ? 'tracker' : 'registry';

const session = { available: false, ref: explicitRef, changed: [], uncommitted: [], note: '' };

if (explicitRef) {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', `${explicitRef}^{commit}`], { cwd: target });
    // tracked changes since ref + untracked files. `git diff` omits untracked files, but a
    // brand-new uncommitted file is definitely current-session work — include it, or it
    // would be mis-marked "stale" and proposed for deletion.
    const [{ stdout: tracked }, { stdout: untracked }] = await Promise.all([
      execFileAsync('git', ['diff', '--name-only', explicitRef], { cwd: target }),
      execFileAsync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: target })
    ]);
    session.available = true;
    session.changed = [...tracked.split('\n'), ...untracked.split('\n')]
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((value, index, all) => all.indexOf(value) === index)
      .sort();
  } catch (error) {
    session.note = `git 不可用或 ref 无效（${explicitRef}）：${String(error.message).split('\n')[0]}`;
  }
} else {
  // 绝不默认 HEAD：那会把已提交的「本会话」内容误判为历史并过度标记为可清。
  session.note = '未提供 --session-ref：不假设 HEAD。仅「未提交改动」可确定为「本会话」；其余一律标为「无法判定」而非「陈旧」，请传入本会话起始 commit 以获得准确范围。';
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: target });
    // porcelain 行 = `XY<space>PATH`。**不要先 trim**：未暂存改动是 ` M path`，trim 会把状态列的
    // 前导空格吃掉，再 slice(3) 就吞掉路径首字符（`scripts/x` → `cripts/x`）——范围判断一旦拿到
    // 错路径，后续就可能误判「不在本会话」而多删。重命名条目另取 `->` 之后的路径。
    session.uncommitted = stdout
      .split('\n')
      .map((line) => line.replace(/\r$/, ''))
      .filter(Boolean)
      .map((line) => {
        const status = line.slice(0, 2);
        const raw = line.slice(3);
        const pathPart = status.includes('R') && raw.includes(' -> ') ? raw.split(' -> ').pop() : raw;
        return pathPart.replace(/^"(.*)"$/, '$1');
      })
      .filter(Boolean)
      .sort();
  } catch {
    // git 不可用：uncommitted 保持为空，作用面退化为「全部无法判定」。
  }
}

const refSet = session.available ? session.changed : session.uncommitted;
const inSessionScope = (relativePath) =>
  refSet.some((changedPath) => changedPath === relativePath || changedPath.startsWith(`${relativePath}/`));

// 三态：有 ref 时才能用「不在本会话范围」判定历史（stale）；无 ref 时一律「无法判定」。
// 收尾模式不判历史——那不是收尾的活——改标 out-of-scope：不在本次会话范围内，收尾不碰。
const classify = (relativePath) => {
  if (inSessionScope(relativePath)) return 'current';
  if (!session.available) return 'unverified';
  return sessionOnly ? 'out-of-scope' : 'stale';
};

// 会话收尾：把本会话产出按五落点归类，并找出落在落点之外的会话产出。
// routed.scratch 同时就是「需要裁决保留还是删除」的集合——同一事实只落一处，不另设一张表。
const LANDING_MATCHERS = [
  { key: 'scratch', label: '.scratch/（临时材料，随任务删除）', match: (p) => p === '.scratch' || p.startsWith('.scratch/') },
  { key: 'context', label: 'CONTEXT.md（领域语言，持续更新）', match: (p) => p === 'CONTEXT.md' },
  { key: 'adr', label: 'docs/adr/（决策，只增不删）', match: (p) => p === 'docs/adr' || p.startsWith('docs/adr/') },
  { key: 'gate', label: 'init.sh / CI（可执行约束）', match: (p) => p === 'init.sh' || p.startsWith('.github/workflows/') },
  { key: 'state', label: '状态（feature_list.json / progress.md / 工单）', match: (p) => p === 'feature_list.json' || p === 'progress.md' }
];

const DOC_LIKE = /\.(md|mdx|txt|rst|adoc)$/i;

const wrapup = sessionOnly
  ? {
    flow: 'session-wrapup',
    scope: session.available
      ? { available: true, ref: session.ref }
      : { available: false, ref: session.ref, note: session.note },
    total: refSet.length,
    routed: Object.fromEntries(LANDING_MATCHERS.map((matcher) => [matcher.key, []])),
    unrouted: []
  }
  : null;

if (wrapup) {
  for (const changedPath of refSet) {
    const matcher = LANDING_MATCHERS.find((candidate) => candidate.match(changedPath));
    if (matcher) wrapup.routed[matcher.key].push(changedPath);
    else wrapup.unrouted.push({ path: changedPath, docLike: DOC_LIKE.test(changedPath) });
  }
}

const featureList = {
  present: hasFeatureList,
  invalid: false,
  total: 0,
  prune: [],
  keep: [],
  doneWithEvidence: [],
  doneWithoutEvidence: [],
  // 收尾模式不 prune：删历史条目属于整理的作用域。done+evidence 只作为「已完成、无需动作」计数。
  pruneSuppressed: sessionOnly
};
if (hasFeatureList) {
  try {
    const parsed = await readJson(path.join(target, 'feature_list.json'));
    const features = Array.isArray(parsed?.features) ? parsed.features : [];
    featureList.total = features.length;
    for (const feature of features) {
      const label = `${feature.id || '?'} ${feature.name || ''}`.trim();
      const done = String(feature.status || '').toLowerCase() === 'done';
      const hasEvidence = Boolean(String(feature.evidence || '').trim());
      if (!done) featureList.keep.push(label);
      else if (hasEvidence) (sessionOnly ? featureList.doneWithEvidence : featureList.prune).push(label);
      else featureList.doneWithoutEvidence.push(label);
    }
  } catch {
    featureList.invalid = true;
  }
}

const scratch = [];
if (await exists(path.join(target, '.scratch'))) {
  for (const entry of await listFiles(path.join(target, '.scratch'))) {
    const relativePath = `.scratch/${entry}`;
    scratch.push({ path: relativePath, state: classify(relativePath) });
  }
}

const report = {
  flow: sessionOnly ? 'session-wrapup' : 'housekeeping',
  target,
  mode,
  modeSignals,
  registryArtifacts: { featureList: hasFeatureList, progress: hasProgress },
  landingPoints: { present, missing },
  session,
  wrapup,
  featureList,
  scratch
};

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

const line = (text = '') => console.log(text);

line(`${sessionOnly ? 'Session wrap-up scan' : 'Housekeeping scan'} (read-only) — ${target}`);
line();
line(`Mode: ${mode}${modeSignals.length ? `  (signals: ${modeSignals.join(', ')})` : '  (no tracker signals)'}`);
if (mode === 'tracker') {
  line('  note: tracker 模式的状态在外部工单系统——本技能不删工单；仓内可清的只有 .scratch/。');
}
line();
line('Landing points:');
for (const label of present) line(`  ok       ${label}`);
for (const label of missing) line(`  missing  ${label}`);
line();
if (session.available) {
  line(`Session scope — changed since ${session.ref}: ${session.changed.length} file(s)`);
  for (const changedPath of session.changed) line(`  ~ ${changedPath}`);
} else if (explicitRef) {
  line(`Session scope — unavailable. ${session.note}`);
  line('  Without a usable git ref the agent cannot tell 本会话 from 历史; fall back to');
  line('  listing everything for explicit user review before deleting anything.');
} else {
  line('Session scope — no --session-ref given; assuming HEAD is FORBIDDEN (it would mark');
  line('  committed session work as history). Definitely-current = uncommitted changes only:');
  line(`  ${session.uncommitted.length} file(s)`);
  for (const changedPath of session.uncommitted) line(`  ~ ${changedPath}`);
  line('  Everything else is "unverified", never "stale". Pass the session-start commit via');
  line('  --session-ref for an accurate boundary.');
}
line();
if (wrapup) {
  line(`Wrap-up routing — session output mapped onto the five landing points (${wrapup.total} file(s)):`);
  for (const matcher of LANDING_MATCHERS) {
    const paths = wrapup.routed[matcher.key];
    line(`  ${matcher.label}: ${paths.length}`);
    for (const changedPath of paths) line(`    ~ ${changedPath}`);
  }
  line(`  OUTSIDE every landing point: ${wrapup.unrouted.length}`);
  for (const item of wrapup.unrouted) {
    line(`    ? ${item.path}${item.docLike ? '   (doc-like: check whether it is un-routed knowledge material)' : ''}`);
  }
  line('  .scratch/ paths above each need a keep-or-delete verdict at the 🔴 CHECKPOINT.');
  line('  Pruning history is SUPPRESSED in this mode — removing history is housekeeping, not wrap-up.');
  line('  Code changes outside the landing points are normal: code is not a harness artifact.');
  line();
}
if (featureList.present) {
  line(featureList.invalid
    ? 'feature_list.json: present but NOT valid JSON — fix before pruning.'
    : `feature_list.json: ${featureList.total} entr(ies)`);
  if (sessionOnly) {
    line(`  done WITH evidence (nothing to do; pruning belongs to housekeeping): ${featureList.doneWithEvidence.length}`);
  } else {
    line(`  prune candidates (status=done AND evidence present): ${featureList.prune.length}`);
    for (const entry of featureList.prune) line(`    - ${entry}`);
  }
  line(`  keep (not done): ${featureList.keep.length}`);
  for (const entry of featureList.keep) line(`    - ${entry}`);
  line(`  status=done WITHOUT evidence — do NOT prune, fix the evidence first: ${featureList.doneWithoutEvidence.length}`);
  for (const entry of featureList.doneWithoutEvidence) line(`    ! ${entry}`);
} else {
  line('feature_list.json: absent');
}
line();
const staleCount = scratch.filter((entry) => entry.state === 'stale').length;
const outOfScopeCount = scratch.filter((entry) => entry.state === 'out-of-scope').length;
const unverifiedCount = scratch.filter((entry) => entry.state === 'unverified').length;
line(sessionOnly
  ? `.scratch/: ${scratch.length} file(s) — in-session(verdict needed): ${scratch.length - outOfScopeCount - unverifiedCount}, out-of-scope: ${outOfScopeCount}, unverified: ${unverifiedCount}`
  : `.scratch/: ${scratch.length} file(s) — prune-candidate(stale): ${staleCount}, unverified: ${unverifiedCount}`);
for (const entry of scratch) line(`  ${entry.state.padEnd(12)} ${entry.path}`);
line();
line('This scan changed nothing. Any deletion needs an explicit 🔴 CHECKPOINT that lists');
line('exactly what will be removed, plus user approval. ADR and CONTEXT.md are never pruned.');
if (sessionOnly) {
  line('Wrap-up scope is THIS SESSION ONLY: files outside it are not wrap-up material — do not');
  line('touch them. Prune candidates stay suppressed; run without --session-only for 整理仓库.');
}
