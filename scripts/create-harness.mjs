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
  isPlaceholderVerification,
  parseArgs,
  readText,
  replaceBlueprintSlot,
  scriptCommand,
  TEMPLATE_DIR,
  verificationCommands,
  writeText
} from './lib/harness-utils.mjs';

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`Usage: ${scriptCommand('create-harness.mjs')} [--target DIR] [--agent-file AGENTS.md|CLAUDE.md] [--package-manager npm|pnpm|yarn|bun] [--blueprint "WHAT THIS PROJECT IS"] [--commands "a,b"] [--no-verification] [--force] [--dry-run]

Creates a minimal production harness — the three subsystems this skill owns, no more:
  AGENTS.md or CLAUDE.md (an existing CLAUDE.md is kept and preferred)
  init.sh — the verification gate that must pass before any feature is called done

One template, one tier. This script detects no mode and infers nothing from the directory contents,
and the rendered file names no external system: which tracker records progress, how requirements are
broken down, and who reviews a change are all decisions this skill does not make and the generated
file does not pretend to have made. What it does state is where a verified result gets written down,
because a harness that leaves that open is how one piece of work ends up recorded in three places.

Scope boundary: this skill builds and audits the harness FILES. The engineering workflow —
requirement alignment, specs, breakdown, implementation, testing, review, handoff — belongs to
whatever the project already runs, and this script neither performs nor scaffolds any of it: no
feature entries are invented, no decisions are recorded, no tickets are filed, and the AGENTS.md
it writes says so explicitly. The harness ships artifacts that make an agent reliable; it does not
decide what the project should build.

--blueprint carries the user's own one-line description of what the project is and what it
delivers, written verbatim into the AGENTS.md purpose line. It is the only channel for that
input: omit it and the placeholder stays visible, never assembled from the detected stack.

On a target whose instruction file already exists, --blueprint rewrites ONLY the blueprint slot —
the content between the H1 and the first following heading — and prints the previous text as
before -> after. Everything else is left byte-identical, so a merged section or a block another
skill owns cannot be clobbered by a blueprint change. If the slot cannot be located, nothing is
written and the run exits non-zero: guessing which paragraph was meant could rewrite prose this
skill never wrote. Without --blueprint an existing file is still skipped and reported.

--dry-run prints the same plan the real run would execute (each artifact marked written or
skipped) and exits 0 without creating the target directory or writing any file. Run it before the
pre-write CHECKPOINT: that plan is what the user approves. It is exact rather than approximate —
every status depends only on --force and the file's current state, so a dry run cannot drift from
the real run that follows it.

An existing AGENTS.md/CLAUDE.md is never rewritten (skip, or --force) — instead the harness
sections it lacks are reported so the agent can merge them by hand, keeping third-party blocks
such as a "## Agent skills" section another skill owns.

--no-verification lets a project with NOTHING TO RUN declare that fact. It is REFUSED (exit non-zero,
nothing created) wherever the project already has a runnable check — a gate that cannot fail is not a
gate, and a repository with a test suite is not short of one. When granted, the generated init.sh
prints a disclosure instead of the completion banner and never claims anything was verified, and the
same declaration is written into the instruction file so a reader sees it without opening the script.
Leaving the flag out keeps the ordinary behaviour: init.sh exits 1 until a real check replaces the
placeholder.

--commands takes a comma-separated list, one check per entry: --commands "npm test,npm run lint".
A comma inside a command has to be quoted, or it would separate rather than belong: --commands
"bash -c 'echo a,b'" is ONE command. An unterminated quote is refused with a non-zero exit and
nothing created, rather than split into steps that no longer check anything.

Existing files are skipped unless --force is set. --force does not overwrite a file whose content
another skill owns; it only lifts the skip on this skill's own artifacts.`);
  process.exit(0);
}

// A project may declare that it has nothing to run. The declaration is a disclosure rather than a
// pass, and it is refused nowhere but accepted nowhere silently either: the generated init.sh must
// say it verified nothing, and the instruction file must say the same, so the only way to collect
// this is to state it in both places an agent looks.
const noVerification = Boolean(args.noVerification);

// `--no-engineering-owner` selected a second template that named no owner, on the reasoning that
// a directory with nothing to delegate to should not claim one. Both templates named an external
// system, so the honest form is neither of them: one template that names none. Accepting the flag
// silently would render the default template and print a success line for a flag that changed
// nothing — the exact shape of degradation this skill's own SKILL.md calls out.
if (args.noEngineeringOwner !== undefined) {
  console.error('REFUSED: --no-engineering-owner no longer exists.');
  console.error('There is one template now, and it names no external system at all, so there is');
  console.error('nothing left for the flag to select. Nothing was created.');
  process.exit(1);
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
// --commands is a comma-separated list, and a comma INSIDE one of the commands used to split it in
// two: `--commands "bash -c 'echo a,b'"` became the steps `bash -c 'echo a` and `b'`, the second of
// which is not a check at all — a gate silently rewritten into something that cannot fail, which is
// the silent degradation this skill exists to forbid. The split is now quote-aware, and an
// unterminated quote is refused instead of guessed at, because guessing is what produced the split.
// Quoting is the only escape; there is no backslash form to remember.
function splitCommandList(raw) {
  const parts = [];
  let current = '';
  let quote = null;
  for (const char of String(raw)) {
    if (quote) {
      current += char;
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'" || char === '`') {
      quote = char;
      current += char;
    } else if (char === ',') {
      parts.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  if (quote) return { error: `unterminated ${quote} in --commands` };
  parts.push(current);
  return { commands: parts.map((part) => part.trim()).filter(Boolean) };
}

const availableCommands = verificationCommands(project, args.packageManager);
// The waiver asks the question the empty command list used to answer for it. Short-circuiting to
// `[]` meant the project was never asked what it could run, so a repository with a real test suite
// could collect a declaration that it has nothing to run — and the audit then gave that harness 93/100.
// Measured before this check: a repo defining both `test` and `lint` exited 0 with the waiver in both
// artifacts. An absent gate is a gate that cannot fail, so the declaration is only honest where there
// is genuinely nothing to run; everywhere else it is a way of turning the harness off while keeping
// the appearance of one.
//
// "Genuinely nothing" is read from the detected commands with the placeholders removed, NOT from
// their count: a project with no manifest, or one whose manifest defines no check the generator
// knows how to run, still gets a non-empty list back — the placeholder that will fail closed until
// someone replaces it. Counting entries would have refused exactly the two cases the waiver exists
// for, which is the opposite of the intended rule.
const realCommands = availableCommands.filter((command) => !isPlaceholderVerification(command));
if (noVerification && realCommands.length > 0) {
  console.error('REFUSED: --no-verification, but this project already has checks it can run:');
  for (const command of realCommands) console.error(`  - ${command}`);
  console.error('An absent gate is a gate that cannot fail, and this repository is not short of one.');
  console.error('Drop the flag, or pass --commands with the checks this project actually uses.');
  console.error('Nothing was created.');
  process.exit(1);
}

const commandSplit = noVerification
  ? { commands: [] }
  : args.commands
    ? splitCommandList(String(args.commands))
    : { commands: availableCommands };
if (commandSplit.error) {
  console.error(`REFUSED: ${commandSplit.error}.`);
  console.error('--commands separates commands with commas, so a comma inside a command must be');
  console.error('quoted: --commands "bash -c \'echo a,b\'" is one command. Splitting it silently');
  console.error('would ship a gate that no longer checks what it was asked to. Nothing was created.');
  process.exit(1);
}
const commands = commandSplit.commands;

// One template, no branches. A second template had existed for a "plain" tier, chosen by a flag,
// and the two files could drift while the self-check asserted they matched; both halves of that
// arrangement are gone now, so the render has exactly one shape to keep correct.
const templateName = 'agents.md';

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
  VERIFICATION_COMMANDS: noVerification
    ? '- （本项目显式声明：无验证命令）'
    : commands.map((command) => `- \`${command}\``).join('\n'),
  PRIMARY_VERIFICATION_COMMAND: './init.sh',
  // A waiver has to be visible in the artifact the agent READS, not only in the script it runs: an
  // agent that reads AGENTS.md must be able to see that nothing is verified here without opening
  // init.sh. Rendered on its own line so the disclosure is a statement in the file rather than a
  // trailing clause the reader can miss.
  NO_VERIFICATION_NOTE: noVerification
    ? '**本仓库显式声明：无验证命令**（`./init.sh` 只作启动路径，不验证任何东西）。'
    : ''
};

const results = [];
const agentPath = path.join(target, agentFile);
const agentResult = await copyTemplate(templateName, agentPath, replacements, { force, dryRun });
results.push(agentResult);

// A blueprint change is not a re-run of create. The blueprint is the one slot the user owns and
// rewrites as the project's description sharpens, so --blueprint also has to work on a file that
// already exists — but ONLY on that slot: every other line has been edited since (merged sections,
// a block another skill owns) and re-rendering the template over it would destroy that work. The
// trigger is the flag, never the mere presence of a file — which is why a run without --blueprint
// still reports SKIPPED and leaves the file byte-identical.
const blueprintUpdate = agentResult.status === 'skipped' && args.blueprint !== undefined
  ? replaceBlueprintSlot(await readText(agentPath), String(args.blueprint))
  : null;
if (blueprintUpdate?.ok && !dryRun) await writeText(agentPath, blueprintUpdate.markdown);

// Report, never write: a text-match append cannot tell whether the existing file already covers a
// section in English or in another wording, and would add a second startup path — two competing
// instruction files is the drift this skill exists to prevent. Merging is the agent's call.
const missingAgentSections = agentResult.status === 'skipped'
  ? diffSections(await readText(path.join(TEMPLATE_DIR, templateName)), await readText(agentPath))
  : [];

// No state artifacts are written. Writing a second record beside whatever the project already uses
// is the double-write this skill exists to prevent: whichever file the agent reads second
// contradicts the first. The AGENTS.md says where a verified result goes; it does not create that
// place.

const initPath = path.join(target, 'init.sh');
if (force || !await exists(initPath)) {
  if (!dryRun) {
    await writeText(initPath, initScriptFromCommands(commands, { noVerification }));
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
if (noVerification) {
  console.log('  - (none declared — the generated init.sh says so and verifies nothing)');
}
console.log('');
for (const result of results) {
  console.log(`${result.status.toUpperCase()} ${path.relative(target, result.path)}${result.reason ? ` (${result.reason})` : ''}`);
}

// Printed whether or not the write happened, because a change to someone's instruction file should
// be visible as before → after rather than only happening. A refusal exits non-zero: an exit-0
// no-op would leave the user believing the blueprint changed.
if (blueprintUpdate) {
  console.log('');
  if (blueprintUpdate.ok) {
    console.log(`BLUEPRINT ${dryRun ? 'PLANNED' : 'UPDATED'} ${path.relative(target, agentPath)}`);
    console.log(`  before: ${blueprintUpdate.before}`);
    console.log(`  after:  ${args.blueprint}`);
  } else {
    console.log(`BLUEPRINT REFUSED ${path.relative(target, agentPath)} — ${blueprintUpdate.reason}`);
    console.log('  Nothing was written. The slot is the content between the H1 and the first following');
    console.log('  heading; a file that does not have that shape gets a hand edit instead of a guess.');
    process.exitCode = 1;
  }
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

// The next step is the user's, not this skill's. This script places the two artifacts and says
// where they came from; what the project does with them is decided in the repo, not here.
console.log('');
console.log(`Next: read ${agentFile} for the startup path and the invariants, and make ./init.sh run`);
console.log('this project\'s real checks. Until it does, a green ./init.sh proves nothing.');
console.log('This skill creates no tracker, no ticket list and no record file: it derives no entries,');
console.log('no acceptance criteria and no decisions on its own.');
