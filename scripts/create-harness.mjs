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
  console.log(`Usage: ${scriptCommand('create-harness.mjs')} [--target DIR] [--agent-file AGENTS.md|CLAUDE.md] [--package-manager npm|pnpm|yarn|bun] [--blueprint "WHAT THIS PROJECT IS"] [--commands "a,b"] [--force] [--dry-run]

Creates a minimal production harness — the five subsystems, no more:
  AGENTS.md or CLAUDE.md (an existing CLAUDE.md is kept and preferred)
  feature_list.json + progress.md — current feature, status, evidence, next step
  init.sh — the verification gate that must pass before any feature is called done

Scope boundary: this skill builds and audits the harness FILES. The engineering workflow —
requirement alignment, specs, breakdown, implementation, testing, review, handoff — belongs to
whatever engineering skills are installed, and this script neither performs nor scaffolds any of
it: no feature entries are invented, no decisions are recorded, no tickets are filed, and the
AGENTS.md it writes says so explicitly. The harness ships artifacts that make an agent reliable;
it does not decide what the project should build.

--blueprint carries the user's own one-line description of what the project is and what it
delivers, written verbatim into the AGENTS.md purpose line. It is the only channel for that
input: omit it and the placeholder stays visible, never assembled from the detected stack.

--dry-run prints the same plan the real run would execute (each artifact marked written or
skipped) and exits 0 without creating the target directory or writing any file. Run it before the
pre-write CHECKPOINT: that plan is what the user approves. It is exact rather than approximate —
every status depends only on --force and the file's current state, so a dry run cannot drift from
the real run that follows it.

An existing AGENTS.md/CLAUDE.md is never rewritten (skip, or --force) — instead the harness
sections it lacks are reported so the agent can merge them by hand, keeping third-party blocks
such as a "## Agent skills" section another skill owns.

Existing files are skipped unless --force is set. --force does not overwrite a file whose content
another skill owns; it only lifts the skip on this skill's own artifacts.`);
  process.exit(0);
}

const target = path.resolve(args.target || args._[0] || process.cwd());
// CLAUDE.md wins when it already exists, matching the agent-file convention both upstream and this
// skill follow so two skills never end up maintaining divergent instruction files in one repo.
// --agent-file overrides.
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

// Skipped under --dry-run: a preview must not change the filesystem, and creating the target
// directory counts as a change. The existence probes above already tolerate a missing path.
if (!dryRun) await mkdir(target, { recursive: true });

const replacements = {
  AGENT_FILE_NAME: agentFile,
  // The project blueprint: what this project is and what it delivers. NOT product form, NOT an
  // implementation path, NOT a backlog — the purpose line says so, and the working rules forbid
  // deriving entries from it before the requirements have actually been aligned.
  // The value is never invented. It comes from the user's own statement via --blueprint, or it
  // stays a visible pending marker. Assembling it from `project.stack` meant the one place that
  // answers "what is this project" carried no project fact at all: a repo could ship a
  // filled-in-looking purpose line that says nothing. Left as the marker, the gap is visible and
  // askable; invented, it hides the same missing input that lets an agent go on to write
  // unaligned feature entries.
  PROJECT_PURPOSE: args.blueprint
    ? String(args.blueprint)
    : '待补——由用户陈述「这个项目是什么、最终交付什么」后填入；此字样存在即表示尚未确定',
  VERIFICATION_COMMANDS: commands.map((command) => `- \`${command}\``).join('\n'),
  PRIMARY_VERIFICATION_COMMAND: './init.sh'
};

const results = [];
const agentPath = path.join(target, agentFile);
const agentResult = await copyTemplate('agents.md', agentPath, replacements, { force, dryRun });
results.push(agentResult);

// Report, never write: a text-match append cannot tell whether the existing file already covers a
// section in English or in another wording, and would add a second startup path — two competing
// instruction files is the drift this skill exists to prevent. Merging is the agent's call.
const missingAgentSections = agentResult.status === 'skipped'
  ? diffSections(await readText(path.join(TEMPLATE_DIR, 'agents.md')), await readText(agentPath))
  : [];

results.push(await copyTemplate('feature-list.json', path.join(target, 'feature_list.json'), {}, { force, dryRun }));
results.push(await copyTemplate('progress.md', path.join(target, 'progress.md'), {}, { force, dryRun }));

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
  console.log('  Merge them by hand: keep existing content and any third-party block,');
  console.log('  and do not add a second copy of a section the file already covers in');
  console.log('  another language or wording.');
}

// The next step is the user's, not this skill's: entries must come out of requirement alignment.
console.log('');
console.log('Next: replace the placeholder feature entry with one that has been aligned with the');
console.log('user. This skill does not derive entries, acceptance criteria or decisions on its own.');
