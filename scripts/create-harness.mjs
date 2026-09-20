#!/usr/bin/env node
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  copyTemplate,
  detectAgentFile,
  detectPackageManager,
  detectProject,
  diffSections,
  exists,
  initScriptFromCommands,
  parseArgs,
  readText,
  scriptCommand,
  TEMPLATE_DIR,
  verificationCommands,
  writeText
} from './lib/harness-utils.mjs';

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`Usage: ${scriptCommand('create-harness.mjs')} [--target DIR] [--agent-file AGENTS.md|CLAUDE.md] [--package-manager npm|pnpm|yarn|bun] [--mode auto|registry|tracker] [--tracking "CONCLUSION"] [--blueprint "WHAT THIS PROJECT IS"] [--commands "a,b"] [--force] [--dry-run]

Creates a minimal production harness:
  AGENTS.md or CLAUDE.md (an existing CLAUDE.md is kept and preferred)
  init.sh
  feature_list.json + progress.md — registry mode only

Tracker mode (--mode tracker, or auto-detected from docs/agents/*, CONTEXT.md or docs/adr/)
skips the registry state files: state lives in the ticket system, so writing
feature_list.json/progress.md there would create a second state source. An existing
feature_list.json wins over those signals. The upstream tracker setup owns docs/agents/*; CONTEXT.md and
docs/adr/ are created lazily upstream, so this script never scaffolds
them. Skill names and invocation modes: references/upstream-interlock.md.

--mode is required whenever nothing can be inferred. With no --mode (or with --mode auto) the
script infers the mode from the signals above; if none are present it refuses to write and exits
with code 1, printing what it probed. This is deliberate: an unasked mode question must not turn
into a silent scaffold. Ask the user which mode the repo uses, then re-run with an explicit
--mode registry or --mode tracker.

--dry-run prints the same plan the real run would execute (each artifact marked written or
skipped) and exits 0 without creating the target directory or writing any file. Run it before the
pre-write CHECKPOINT: that plan is what the user approves. It is exact rather than approximate —
every status depends only on --force and the file's current state, so a dry run cannot drift from
the real run that follows it.

--tracking records the one-time git-tracking alignment conclusion in the AGENTS.md
"## 产物追踪策略" section. Omit it and the section is written as pending: harness-creator
asks the question once and fills the conclusion in. See references/git-tracking-alignment.md.

--blueprint carries the user's own one-line description of what the project is and what it
delivers, and is written verbatim into the AGENTS.md "## 项目蓝图" section. It is the only
channel for that input: omit it and the section is written as a visible pending marker,
never assembled from the detected stack. A blueprint is a description — not product form,
not an implementation path, not tickets — and no feature entry may be derived from it
before the requirements have been aligned with the user.

An existing AGENTS.md/CLAUDE.md is never rewritten (skip, or --force) — instead the harness
sections it lacks are reported so the agent can merge them by hand, keeping third-party
blocks such as matt's "## Agent skills". See references/matt-coexistence.md.

Handoffs are a convention, not a repo file: write reference-style handoff docs
to .scratch/handoff.md or the OS temp directory (see AGENTS.md, end-of-session).

Existing files are skipped unless --force is set.`);
  process.exit(0);
}

const target = path.resolve(args.target || args._[0] || process.cwd());
// CLAUDE.md wins when it already exists, matching the upstream setup skill; --agent-file overrides.
const agentFile = await detectAgentFile(target, args.agentFile);
const force = Boolean(args.force);
// --dry-run: compute and print the exact plan (which files would be written vs skipped) without
// touching the filesystem. SKILL.md's pre-write CHECKPOINT asks for the artifact list *before*
// approval, which this script could not previously produce — it wrote as it went and printed the
// list afterwards, so that gate was unsatisfiable by construction.
const dryRun = Boolean(args.dryRun);
const project = await detectProject(target);
project.packageManager = detectPackageManager(target, args.packageManager);
const commands = args.commands
  ? String(args.commands).split(',').map((command) => command.trim()).filter(Boolean)
  : verificationCommands(project, args.packageManager);

// Tracker mode: state lives in the ticket system, so registry artifacts must NOT be scaffolded —
// writing feature_list.json/progress.md would create a second state source, the exact drift this
// skill forbids (references/matt-coexistence.md, counterexample #1).
// Signal set mirrors scoreHarness and references/matt-coexistence.md: matt setup ran
// (docs/agents/*) OR the repo already keeps the long-lived tracker assets (CONTEXT.md, docs/adr/).
// Keying on docs/agents/ alone reported registry for team-maintained tracker repos, which is how
// the sandbox arm ended up bypassing this script with an explicit --mode tracker.
// Two guards keep the wider net safe: an existing feature_list.json wins (flipping a working
// registry repo would be the worse failure), and the signal that fired is always printed, so a
// wrong detection shows up in the pre-write checklist instead of silently changing the shape.
// `--mode` is a decision, not a default. Omitting it lets the script infer a mode from observable
// signals only; with no signal it refuses to write (see the guard below). Prose alone could not
// hold this gate — in live testing every statement of "无信号不得自行默认" lost to a successful
// write — so the refusal is the mechanical carrier for the mode CHECKPOINT in SKILL.md.
// `--mode auto` is refused on the same terms: an explicit "auto" that still picks a mode would
// just be the same bypass wearing a flag.
const rawMode = args.mode === undefined || args.mode === true ? null : String(args.mode);
if (rawMode !== null && !['auto', 'registry', 'tracker'].includes(rawMode)) {
  console.error(`Invalid --mode "${rawMode}". Expected one of: auto, registry, tracker.`);
  process.exit(2);
}
const trackerSignals = [];
if (await exists(path.join(target, 'docs/agents/domain.md'))) trackerSignals.push('docs/agents/domain.md');
if (await exists(path.join(target, 'docs/agents/issue-tracker.md'))) trackerSignals.push('docs/agents/issue-tracker.md');
if (await exists(path.join(target, 'CONTEXT.md'))) trackerSignals.push('CONTEXT.md');
if (await exists(path.join(target, 'docs/adr'))) trackerSignals.push('docs/adr/');
const registryStateExists = await exists(path.join(target, 'feature_list.json'));

// The guard: no observable signal plus no explicit decision means there is nothing to infer from.
// Refuse before any write — including mkdir — so the omission surfaces as a visible failure
// instead of a silent registry scaffold.
if (
  (rawMode === null || rawMode === 'auto') &&
  trackerSignals.length === 0 &&
  !registryStateExists
) {
  console.error(`Refusing to write: no governance mode could be determined for ${target}`);
  console.error('');
  console.error('Probed tracker signals (docs/agents/domain.md, docs/agents/issue-tracker.md,');
  console.error('CONTEXT.md, docs/adr/) and registry state (feature_list.json): none present,');
  console.error('and no explicit --mode was given, so there is nothing to infer the mode from.');
  console.error('');
  console.error('Mode choice belongs to the user: ask them, then re-run with --mode:');
  console.error('  --mode registry   state lives in the repo: feature_list.json + progress.md');
  console.error('  --mode tracker    state lives in an issue tracker; no in-repo registry');
  console.error('');
  console.error('No files were written.');
  process.exit(1);
}

const mode = rawMode === null ? 'auto' : rawMode;
const trackerMode = mode === 'tracker'
  || (mode === 'auto' && trackerSignals.length > 0 && !registryStateExists);
const trackerReason = mode === 'tracker'
  ? 'tracker mode (--mode tracker)'
  : `tracker mode (signals: ${trackerSignals.join(', ')})`;

// Skipped under --dry-run: a preview must not change the filesystem, and creating the target
// directory counts as a change. The existence probes above already tolerate a missing path.
if (!dryRun) await mkdir(target, { recursive: true });

// The repository-structure table is the one section that differs by mode: registry repos keep
// state in feature_list.json + progress.md, tracker repos keep it in the ticket system and must
// NOT be told a feature registry exists (that would be a second state source).
const REPO_LAYOUT = {
  registry: [
    '| `.scratch/` | 临时材料 | 写任务材料时创建；由收尾与整理按作用域分别清，不进默认上下文 |',
    '| `CONTEXT.md` | 领域语言 | 由上游领域建模 skill 延迟创建（首个术语定稿时）；缺失属正常状态；格式与创建时机归上游配置，不代改 |',
    '| `docs/adr/` | 决策记录 | 同上，首个 ADR 需要时创建；只增不删 |',
    '| `init.sh` | 可执行约束 | harness 创建；声称完成前必须运行 |',
    '| `feature_list.json`、`progress.md` | 状态与证据 | harness 创建；每会话更新，`evidence` 必填 |'
  ],
  tracker: [
    '| `.scratch/` | 临时材料 | 写任务材料时创建；由收尾与整理按作用域分别清，不进默认上下文 |',
    '| `CONTEXT.md` | 领域语言 | 由上游领域建模 skill 延迟创建（首个术语定稿时）；缺失属正常状态；格式与创建时机归上游配置，不代改 |',
    '| `docs/adr/` | 决策记录 | 同上，首个 ADR 需要时创建；只增不删 |',
    '| `init.sh` | 可执行约束 | harness 创建；声称完成前必须运行 |',
    '| 工单系统（仓外或本地） | 状态与依赖 | 工单即事实来源；仓内**不留** `feature_list.json`/`progress.md`，避免第二状态源 |'
  ]
};

// Mode-aware template fillers. The AGENTS.md template is shared by both modes, so any section
// that names the state artifact has to be filled per mode: leaving registry names in a tracker
// harness contradicts the repo-layout table ("仓内不留 feature_list.json") inside the same file
// — two state facts in one instruction file, the drift this skill exists to prevent.
const STATE_ARTIFACT = {
  registry: '`feature_list.json` 与 `progress.md`',
  tracker: '工单系统'
};
const modeKey = trackerMode ? 'tracker' : 'registry';

const replacements = {
  AGENT_FILE_NAME: agentFile,
  // The project blueprint: what this project is and what it delivers. NOT product form, NOT an
  // implementation path, NOT tickets — the section it fills says so, and the working rules forbid
  // deriving entries from it before the requirements have actually been aligned.
  // The value is never invented. It comes from the user's own statement via --blueprint, or it
  // stays a visible pending marker. This used to be assembled from `project.stack`, which meant the
  // one place in AGENTS.md that answers "what is this project" carried no project fact at all: a
  // repo could ship a filled-in-looking blueprint that says nothing. Left as the pending marker,
  // the gap is visible and askable; invented, it hides the same missing input that lets an agent
  // go on to write unaligned feature entries.
  PROJECT_PURPOSE: args.blueprint
    ? String(args.blueprint)
    : '待补——由用户陈述「这个项目是什么、最终交付什么」后填入；此字样存在即表示蓝图尚未确定',
  VERIFICATION_COMMANDS: commands.map((command) => `- \`${command}\``).join('\n'),
  PRIMARY_VERIFICATION_COMMAND: './init.sh',
  REPO_LAYOUT: REPO_LAYOUT[modeKey].join('\n'),
  STATE_ARTIFACT: STATE_ARTIFACT[modeKey],
  // The tracking-alignment conclusion is filled by the one-time question harness-creator asks
  // before writing, or supplied up front with --tracking. Leaving it marked as pending is the
  // signal that the question has NOT been asked yet, so a later session asks it exactly once
  // instead of re-deriving an answer (references/git-tracking-alignment.md).
  TRACKING_STATUS: args.tracking
    ? String(args.tracking)
    : '待对齐——由 harness-creator 一次性询问后填入；此字样存在即表示尚未询问'
};

const results = [];
const agentPath = path.join(target, agentFile);
const agentResult = await copyTemplate('agents.md', agentPath, replacements, { force, dryRun });
results.push(agentResult);

// Report, never write: a text-match append cannot tell whether the existing file already covers
// a section in English or in another wording, and would add a second startup path — the shape
// references/matt-coexistence.md warns about. Merging is the agent's call.
const missingAgentSections = agentResult.status === 'skipped'
  ? diffSections(await readText(path.join(TEMPLATE_DIR, 'agents.md')), await readText(agentPath))
  : [];

if (trackerMode) {
  for (const name of ['feature_list.json', 'progress.md']) {
    results.push({
      path: path.join(target, name),
      status: 'skipped',
      reason: trackerReason
    });
  }
} else {
  results.push(await copyTemplate('feature-list.json', path.join(target, 'feature_list.json'), {}, { force, dryRun }));
  results.push(await copyTemplate('progress.md', path.join(target, 'progress.md'), {}, { force, dryRun }));
}

const initPath = path.join(target, 'init.sh');
if (force || !await exists(initPath)) {
  if (!dryRun) {
    await writeText(initPath, initScriptFromCommands(commands));
    await chmod(initPath, 0o755);
  }
  results.push({ path: initPath, status: 'written' });
} else {
  results.push({ path: initPath, status: 'skipped', reason: 'exists' });
}

// A dry run must not claim it created anything — not writing is the entire point. "DRY RUN" leads
// the line rather than trailing it so it survives being skimmed.
if (dryRun) {
  console.log(`DRY RUN — no files were written. Plan for ${target}:`);
} else {
  console.log(`Created harness for ${target}`);
}
console.log(`Detected stack: ${project.stack}`);
if (mode === 'auto' && trackerSignals.length > 0 && registryStateExists) {
  console.log(`Mode: registry — tracker signals present (${trackerSignals.join(', ')}) but feature_list.json exists; pass --mode tracker to override.`);
}
console.log(`Verification commands:`);
for (const command of commands) {
  console.log(`  - ${command}`);
}
console.log('');
for (const result of results) {
  console.log(`${result.status.toUpperCase()} ${path.relative(target, result.path)}${result.reason ? ` (${result.reason})` : ''}`);
}

if (missingAgentSections.length > 0) {
  console.log('');
  console.log(`${agentFile} already exists and was NOT written. Harness sections it lacks:`);
  for (const section of missingAgentSections) {
    console.log(`  - ${section}`);
  }
  console.log('  Merge them by hand: keep existing content and any third-party block');
  console.log('  (matt setup owns "## Agent skills"), and do not add a second copy of a');
  console.log('  section the file already covers in another language or wording.');
  console.log('  Section ownership: references/matt-coexistence.md');
}

if (!args.tracking) {
  console.log('');
  console.log('Git tracking alignment: pending.');
  console.log('  Run: ' + scriptCommand('check-git-tracking.mjs') + ' --target ' + target);
  console.log('  Then ask ONCE which landing points stay untracked (.gitignore match = opt-out)');
  console.log(`  and record the conclusion in ${agentFile} → "## 产物追踪策略".`);
}
