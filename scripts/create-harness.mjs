#!/usr/bin/env node
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  copyTemplate,
  detectAgentFile,
  detectPackageManager,
  detectProject,
  exists,
  initScriptFromCommands,
  parseArgs,
  verificationCommands,
  writeText
} from './lib/harness-utils.mjs';

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`Usage: node scripts/create-harness.mjs [--target DIR] [--agent-file AGENTS.md|CLAUDE.md] [--package-manager npm|pnpm|yarn|bun] [--mode auto|registry|tracker] [--tracking "CONCLUSION"] [--commands "a,b"] [--force]

Creates a minimal production harness:
  AGENTS.md or CLAUDE.md (an existing CLAUDE.md is kept and preferred)
  init.sh
  feature_list.json + progress.md — registry mode only

Tracker mode (--mode tracker, or auto-detected when docs/agents/ exists) skips the registry
state files: state lives in the ticket system, so writing feature_list.json/progress.md there
would create a second state source. matt setup owns docs/agents/*; CONTEXT.md and docs/adr/
are created lazily by matt's domain-modeling skill, so this script never scaffolds them.

--tracking records the one-time git-tracking alignment conclusion in the AGENTS.md
"## 产物追踪策略" section. Omit it and the section is written as pending: harness-creator
asks the question once and fills the conclusion in. See references/git-tracking-alignment.md.

Handoffs are a convention, not a repo file: write reference-style handoff docs
to .scratch/handoff.md or the OS temp directory (see AGENTS.md, end-of-session).

Existing files are skipped unless --force is set.`);
  process.exit(0);
}

const target = path.resolve(args.target || args._[0] || process.cwd());
// CLAUDE.md wins when it already exists, matching setup-matt-pocock-skills; --agent-file overrides.
const agentFile = await detectAgentFile(target, args.agentFile);
const force = Boolean(args.force);
const project = await detectProject(target);
project.packageManager = detectPackageManager(target, args.packageManager);
const commands = args.commands
  ? String(args.commands).split(',').map((command) => command.trim()).filter(Boolean)
  : verificationCommands(project, args.packageManager);

// Tracker mode: state lives in the ticket system, so registry artifacts must NOT be scaffolded —
// writing feature_list.json/progress.md would create a second state source, the exact drift this
// skill forbids (references/matt-coexistence.md, counterexample #1). docs/agents/ is matt setup's
// unambiguous marker; --mode tracker covers tracker repos configured by other means.
const mode = args.mode ? String(args.mode) : 'auto';
const mattSetup = await exists(path.join(target, 'docs/agents/domain.md'))
  || await exists(path.join(target, 'docs/agents/issue-tracker.md'));
const trackerMode = mode === 'tracker' || (mode === 'auto' && mattSetup);

await mkdir(target, { recursive: true });

const replacements = {
  AGENT_FILE_NAME: agentFile,
  PROJECT_PURPOSE: project.stack === 'generic'
    ? 'Project harness for reliable agent-assisted development.'
    : `Project harness for reliable agent-assisted development in a ${project.stack} codebase.`,
  VERIFICATION_COMMANDS: commands.map((command) => `- \`${command}\``).join('\n'),
  PRIMARY_VERIFICATION_COMMAND: './init.sh',
  // The tracking-alignment conclusion is filled by the one-time question harness-creator asks
  // before writing, or supplied up front with --tracking. Leaving it marked as pending is the
  // signal that the question has NOT been asked yet, so a later session asks it exactly once
  // instead of re-deriving an answer (references/git-tracking-alignment.md).
  TRACKING_STATUS: args.tracking
    ? String(args.tracking)
    : '待对齐——由 harness-creator 一次性询问后填入；此字样存在即表示尚未询问'
};

const results = [];
results.push(await copyTemplate('agents.md', path.join(target, agentFile), replacements, { force }));

if (trackerMode) {
  for (const name of ['feature_list.json', 'progress.md']) {
    results.push({
      path: path.join(target, name),
      status: 'skipped',
      reason: mode === 'tracker' ? 'tracker mode (--mode tracker)' : 'tracker mode (docs/agents/ present)'
    });
  }
} else {
  results.push(await copyTemplate('feature-list.json', path.join(target, 'feature_list.json'), {}, { force }));
  results.push(await copyTemplate('progress.md', path.join(target, 'progress.md'), {}, { force }));
}

const initPath = path.join(target, 'init.sh');
if (force || !await exists(initPath)) {
  await writeText(initPath, initScriptFromCommands(commands));
  await chmod(initPath, 0o755);
  results.push({ path: initPath, status: 'written' });
} else {
  results.push({ path: initPath, status: 'skipped', reason: 'exists' });
}

console.log(`Created harness for ${target}`);
console.log(`Detected stack: ${project.stack}`);
console.log(`Verification commands:`);
for (const command of commands) {
  console.log(`  - ${command}`);
}
console.log('');
for (const result of results) {
  console.log(`${result.status.toUpperCase()} ${path.relative(target, result.path)}${result.reason ? ` (${result.reason})` : ''}`);
}

if (!args.tracking) {
  console.log('');
  console.log('Git tracking alignment: pending.');
  console.log('  Run: node scripts/check-git-tracking.mjs --target ' + target);
  console.log('  Then ask ONCE which landing points stay untracked (.gitignore match = opt-out)');
  console.log(`  and record the conclusion in ${agentFile} → "## 产物追踪策略".`);
}
