#!/usr/bin/env node
// Read-only probe: are the five artifact landing points tracked by git?
//
// The alignment question ("do you track these landing points?") is asked exactly once by
// harness-creator. This script is the machine half of that answer: it derives the state from
// the repository instead of asking the user to remember. A path matched by any ignore source
// (.gitignore, .git/info/exclude, core.excludesFile) counts as an explicit opt-out — the user
// already answered "not tracked" by writing the pattern, so the agent must not ask again.
//
// Statuses per landing point:
//   tracked  — present in the git index (git ls-files); the durable case
//   ignored  — matched by an ignore source; the user opted out of tracking
//   stray    — exists in the worktree but is neither tracked nor ignored (the drift case)
//   absent   — nothing has been produced yet; no tracking decision is observable
//   unknown  — git is unavailable or the target is not a repository
//
// This script never writes. `--strict` turns any `stray` into exit code 1 for gate use.
import { access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseArgs } from './lib/harness-utils.mjs';

const execFileAsync = promisify(execFile);

const LANDING_POINTS = [
  {
    id: 'scratch',
    label: '临时材料',
    paths: ['.scratch/'],
    expected: 'untracked',
    rationale: 'spec 草稿、调研笔记、交接文档、教学工作区——随任务/worktree 删除，进版本控制即制造噪声事实来源'
  },
  {
    id: 'context',
    label: '领域语言',
    paths: ['CONTEXT.md'],
    expected: 'tracked',
    rationale: '长期资产：代码表达不了的领域用语，跨会话与跨 worktree 共享；不跟踪等于每个 worktree 从零重建'
  },
  {
    id: 'adr',
    label: '决策',
    paths: ['docs/adr/'],
    expected: 'tracked',
    rationale: '长期资产、只增不删；决策史丢失不可逆'
  },
  {
    id: 'gate',
    label: '可执行约束',
    paths: ['init.sh', '.github/workflows/'],
    expected: 'tracked',
    rationale: '违反即报错的门禁；不共享则每个代理各自为政，验证口径漂移'
  },
  {
    id: 'state',
    label: '状态与依赖',
    paths: ['feature_list.json', 'progress.md'],
    expected: 'tracked',
    rationale: 'registry 模式的仓内状态源；tracker 模式状态在工单系统，此处按缺失处理'
  }
];

const STATUS_NOTE = {
  tracked: '已由 git 跟踪',
  ignored: '被 ignore 源命中——视为用户已选择不跟踪（不再询问）',
  stray: '存在但既未提交也未忽略（游离态，必须裁决）',
  absent: '尚未产生，无法从仓库判定',
  unknown: 'git 不可用，无法判定'
};

function normalize(value) {
  const cleaned = String(value).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  return cleaned || '.';
}

async function gitOrNull(target, gitArgs) {
  try {
    const { stdout } = await execFileAsync('git', ['-C', target, ...gitArgs], {
      cwd: target,
      maxBuffer: 4 * 1024 * 1024
    });
    return stdout;
  } catch {
    return null;
  }
}

async function pathExists(target, probePath) {
  try {
    await access(path.join(target, normalize(probePath)));
    return true;
  } catch {
    return false;
  }
}

// git check-ignore -v prints `<source>:<line>:<pattern>\t<pathname>`; the pattern may contain
// colons (e.g. `a:b` or a Windows drive), so everything after the line number is the pattern.
// `--no-index` is what makes this the authoritative answer to "did the user list it?": the plain
// form stays silent for tracked paths, because a pattern has no effect there. Comparing the two
// is how we detect an ineffective opt-out (listed in .gitignore, but still committed).
async function ignoreMatch(target, probePath, { noIndex = false } = {}) {
  const gitArgs = ['check-ignore', '-v', ...(noIndex ? ['--no-index'] : []), '--', normalize(probePath)];
  const stdout = await gitOrNull(target, gitArgs);
  if (!stdout) return null;
  const [meta] = stdout.split('\t');
  const [source, line, ...rest] = meta.trim().split(':');
  return { source, line, pattern: rest.join(':') };
}

// The user's opt-out gesture is "list it in .gitignore". That gesture is a no-op once the path
// is committed — git keeps tracking ignored-but-tracked files. Saying so is the difference
// between an alignment answer that holds and one that silently does not.
async function listOnlyWarning(target, landingPoint, status) {
  if (status !== 'tracked') return null;
  for (const probePath of landingPoint.paths) {
    const listed = await ignoreMatch(target, probePath, { noIndex: true });
    if (listed) {
      return { path: normalize(probePath), ...listed };
    }
  }
  return null;
}

// A directory landing point ('.scratch/', 'docs/adr/') is tracked when any file below it is in
// the index — git cannot track a directory itself, and ls-files already walks recursively.
function trackedUnder(indexEntries, landingPoint) {
  const roots = landingPoint.paths.map(normalize);
  return indexEntries
    .map(normalize)
    .filter((entry) => roots.some((root) => entry === root || entry.startsWith(`${root}/`)));
}

function verdictFor(landingPoint) {
  if (landingPoint.status === 'stray') return 'question';
  if (landingPoint.status === 'tracked') return landingPoint.expected === 'tracked' ? 'ok' : 'question';
  if (landingPoint.status === 'ignored') return landingPoint.expected === 'untracked' ? 'ok' : 'question';
  return 'undetermined'; // absent / unknown
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: node scripts/check-git-tracking.mjs [--target DIR] [--paths "a,b"] [--strict] [--json]

Read-only. Reports, for each of the five artifact landing points, whether git tracks it:
  tracked | ignored | stray | absent | unknown

"ignored" means an ignore source matches the path (.gitignore, .git/info/exclude,
core.excludesFile) — the user already answered "not tracked" there, so the one-time
alignment question must not be asked again for that landing point.

--paths  probe extra repo-local paths (third-party skill artifacts, e.g. "CONSTRAINTS.md")
--strict exit 1 when a landing point is stray (exists but neither tracked nor ignored)
--json   machine-readable output

This script never writes to the repository.`);
    process.exit(0);
  }

  const target = path.resolve(args.target || args._[0] || process.cwd());
  const extraPaths = args.paths
    ? String(args.paths).split(',').map((item) => item.trim()).filter(Boolean)
    : [];
  const landingPoints = [
    ...LANDING_POINTS,
    ...extraPaths.map((probePath) => ({
      id: `extra:${normalize(probePath)}`,
      label: '额外产物',
      paths: [probePath],
      expected: 'undecided',
      rationale: '五落点之外的产物：要么路由回五个落点之一，要么由用户显式裁决其追踪状态'
    }))
  ];

  const toplevel = await gitOrNull(target, ['rev-parse', '--show-toplevel']);
  const gitAvailable = toplevel !== null;
  const indexEntries = gitAvailable
    ? (await gitOrNull(target, ['ls-files']) ?? '').split('\n').filter(Boolean)
    : [];

  const results = [];
  for (const landingPoint of landingPoints) {
    if (!gitAvailable) {
      results.push({
        ...landingPoint,
        status: 'unknown',
        trackedFiles: [],
        trackedCount: 0,
        probes: landingPoint.paths.map((probePath) => ({ path: probePath, present: false, ignoreMatch: null }))
      });
      continue;
    }

    const trackedFiles = trackedUnder(indexEntries, landingPoint);
    const probes = [];
    for (const probePath of landingPoint.paths) {
      probes.push({
        path: probePath,
        present: await pathExists(target, probePath),
        ignoreMatch: await ignoreMatch(target, probePath)
      });
    }

    let status = 'absent';
    if (trackedFiles.length > 0) status = 'tracked';
    else if (probes.some((probe) => probe.ignoreMatch)) status = 'ignored';
    else if (probes.some((probe) => probe.present)) status = 'stray';

    results.push({
      ...landingPoint,
      status,
      trackedFiles: trackedFiles.slice(0, 8),
      trackedCount: trackedFiles.length,
      probes,
      ineffectiveOptOut: await listOnlyWarning(target, landingPoint, status)
    });
  }

  for (const result of results) result.verdict = verdictFor(result);
  const strays = results.filter((result) => result.status === 'stray');
  const questions = results.filter((result) => result.verdict === 'question');
  const ineffective = results.filter((result) => result.ineffectiveOptOut);

  if (args.json) {
    console.log(JSON.stringify({
      target,
      gitAvailable,
      toplevel: toplevel?.trim() ?? null,
      landingPoints: results,
      stray: strays.map((result) => result.id),
      askUser: questions.map((result) => result.id),
      ineffectiveOptOut: ineffective.map((result) => result.id)
    }, null, 2));
  } else {
    console.log(`Git tracking alignment probe for ${target}`);
    if (!gitAvailable) {
      console.log('Git unavailable, or the target is not a repository: nothing can be derived.');
      console.log('Fall back to the one-time question (references/git-tracking-alignment.md).');
    } else if (normalize(toplevel.trim()) !== normalize(target)) {
      console.log(`Note: git toplevel is ${normalize(toplevel.trim())} — probing that repository's index.`);
    }
    console.log('');

    for (const result of results) {
      console.log(`${result.label} [${result.id}] — ${result.status.toUpperCase()} — ${STATUS_NOTE[result.status]}`);
      console.log(`  paths: ${result.paths.join(', ')}`);
      console.log(`  expected ${result.expected}: ${result.rationale}`);
      if (result.trackedCount > 0) {
        console.log(`  tracked ${result.trackedCount} file(s): ${result.trackedFiles.join(', ')}`);
      }
      for (const probe of result.probes) {
        if (probe.ignoreMatch) {
          console.log(`  ignored by ${probe.ignoreMatch.source}:${probe.ignoreMatch.line} → "${probe.ignoreMatch.pattern}"`);
        } else if (!probe.present && result.status !== 'tracked') {
          console.log(`  not present: ${probe.path}`);
        }
      }
      if (result.ineffectiveOptOut) {
        console.log(`  ⚠ ineffective opt-out: "${result.ineffectiveOptOut.pattern}" in ${result.ineffectiveOptOut.source}:${result.ineffectiveOptOut.line} matches ${result.ineffectiveOptOut.path}, but the path is already tracked —`);
        console.log('    .gitignore does not untrack committed files. Either answer "tracked" or run `git rm --cached` on your own decision (CHECKPOINT, never silently).');
      }
      console.log('');
    }

    console.log(`Ask the user once about: ${questions.map((result) => result.id).join(', ') || 'nothing'}`);
    if (strays.length > 0) {
      console.log(`Stray landing points: ${strays.map((result) => result.id).join(', ')}`);
      console.log('Resolve by committing them, or by adding the exact pattern to .gitignore — never leave them floating.');
    }
    if (ineffective.length > 0) {
      console.log(`Ineffective opt-outs (listed in an ignore source yet still tracked): ${ineffective.map((result) => result.id).join(', ')}`);
    }
  }

  process.exit(args.strict && strays.length > 0 ? 1 : 0);
}

main().catch((error) => {
  console.error(`check-git-tracking failed: ${error.message}`);
  // A read-only reporter must never block a harness run: report and exit clean.
  process.exit(0);
});
