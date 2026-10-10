#!/usr/bin/env node
import { execFile as execFileCallback } from 'node:child_process';
import { chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  appendSectionIfMissing,
  appendVerificationCheck,
  copyTemplate,
  detectAgentFile,
  detectPackageManager,
  detectProject,
  diffSections,
  exists,
  extractSection,
  initScriptFromCommands,
  isPlaceholderVerification,
  lineCount,
  normalizeEntryPath,
  parseArgs,
  readText,
  renderTemplate,
  replaceBlueprintSlot,
  scriptCommand,
  statOrNull,
  TEMPLATE_DIR,
  verificationCommands,
  writeText
} from './lib/harness-utils.mjs';

const execFileAsync = promisify(execFileCallback);
const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`Usage: ${scriptCommand('create-harness.mjs')} [--target DIR] [--agent-file AGENTS.md|CLAUDE.md] [--package-manager npm|pnpm|yarn|bun] [--blueprint "WHAT THIS PROJECT IS"] [--commands "a,b"] [--add-check "cmd"] [--add-check-entry "./verify.sh"] [--spec-layer] [--no-agents-layer] [--no-verification] [--force] [--dry-run]

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

--add-check grows a gate instead of creating one: --add-check "npm run e2e" appends that check
to the region between the RAN=0 counter and the refusal that reads it, and never touches a step
already there. A harness should gain one check per new capability and lose none, so this is the
only edit a re-run can make to an existing init.sh, and there is no --force analogue for it: there
is nothing here to overwrite. Naming a check the gate already runs is reported and exits 0 with
the file byte-identical. The append is REFUSED with nothing written where there is no init.sh
(create the harness first, no flags), where the two anchors are not each present exactly once,
and where the command is one of this generator's own placeholders — a file whose shape is not
recognised gets a hand edit instead of a guess, because a check in the guessed place still looks
like a gate. The run reports the net line change, so "I added one check" is a number the reader
can check rather than a claim.

--add-check-entry PATH grows the gate with ONE line that calls a script this repository owns:
--add-check-entry ./verify.sh. The alternative is pasting every check into init.sh, where each one
makes the gate longer and the order they run in starts to matter for reasons nobody chose. The
appended line is the path itself — unquoted and unguarded, so it is exactly what was named here, and
a missing or non-executable entry fails the gate loudly instead of being skipped into a green one.
It is REFUSED with nothing written when the path is not a relative file inside this repository, when
no such file exists yet, when it is a directory, and when it is empty (an empty script exits 0, so it
would verify nothing for ever while looking like a check). A bare name is normalised to ./name, so
both spellings name the same step and a repeat of either is the byte-identical no-op. Name the
script, do not run it: authoring the checks this points at is the project's own work.

--spec-layer adds two project documents beside the harness: mission.md (what this project is and
what it delivers, what it does NOT do, who it is for) and tech-stack.md (what was detected, with the
file each detection came from). It is OFF by default and a run without it writes byte-identical
artifacts on disk to a run that never heard of the flag (the console names the optional layer so the
agent can ask about it) — the argument against these documents is a real one
("what can be derived does not belong in a resident instruction file"), and a switch is the only
form in which both positions stay true.

Neither file is a resident instruction file: the generated AGENTS.md says to read them ON DEMAND,
not every session. Project facts you did not state stay a visible 待补 marker in every file — they
are never filled in from the detected stack, because a guessed project fact reads like an aligned
answer and gets used to judge scope. The detected stack reaches tech-stack.md and nothing else; there
is no code path by which a manifest can become an answer to "what is this project", and the tech
stack may never be used to infer the mission. Both files skip when they already exist, so a re-run
cannot overwrite documents the project has since written in its own words.

By default the harness also writes two detail documents under docs/agents/ — verification rules and
maintenance rules — and the instruction file routes to them instead of carrying their paragraphs.
--no-agents-layer writes neither, and the routing section disappears with them: a file that pointed
at docs/agents/*.md that were never written is worse than a file with no detail layer at all. Use it
when you have authorized an exact file list, or when docs/agents/ is your own.

Existing files are skipped unless --force is set. --force does not overwrite a file whose content
another skill owns; it only lifts the skip on this skill's own artifacts.`);
  process.exit(0);
}

// A project may declare that it has nothing to run. The declaration is a disclosure rather than a
// pass, and it is refused nowhere but accepted nowhere silently either: the generated init.sh must
// say it verified nothing, and the instruction file must say the same, so the only way to collect
// this is to state it in both places an agent looks.
const noVerification = Boolean(args.noVerification);

// --spec-layer adds two project documents beside the harness. It is opt-in because the whole
// argument for it is disputed in this repository's own tradition — "what can be derived is not a
// resident instruction file" — and a switch is the only form in which both positions stay true:
// without it the artifacts on disk are byte-identical to a run that never heard of the idea; stdout
// still names the optional layer, which is how the agent learns it can ask for it.
//
// A bare flag is refused rather than read as "on". parseArgs hands back `true` when a flag has no
// value, and treating that as enabled is how a flag ends up silently selecting a mode the reader
// did not name; every other branch here treats an absent value as a refusal, and this one does too.
if (args.specLayer !== undefined && args.specLayer !== true && args.specLayer !== false) {
  console.error(`REFUSED: --spec-layer takes no value, but it was given "${args.specLayer}".`);
  console.error('It is a switch: either the spec layer is created or it is not. Nothing was created.');
  process.exit(1);
}
const specLayer = Boolean(args.specLayer);

// --no-agents-layer suppresses the two detail documents under docs/agents/. The layer is ON by
// default because the argument for it is the one this skill is built on — a resident instruction
// file should carry routes, not paragraphs — and a switch nobody flips buys nothing. But "on by
// default" must not mean "the only way out is to overrule the agent": a user who authorizes exactly
// two files, or who keeps docs/agents/ for their own, otherwise has no way to say so, and the only
// compliant move left is to build nothing at all. That turns a default into a veto.
//
// Same shape as --spec-layer: a bare flag is refused rather than read as a value, so naming it
// never silently selects something the reader did not name.
if (args.noAgentsLayer !== undefined && args.noAgentsLayer !== true && args.noAgentsLayer !== false) {
  console.error(`REFUSED: --no-agents-layer takes no value, but it was given "${args.noAgentsLayer}".`);
  console.error('It is a switch: either the detail layer is written or it is not. Nothing was created.');
  process.exit(1);
}
const noAgentsLayer = Boolean(args.noAgentsLayer);

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
// Quoting is the only escape; there is no backslash form to remember. The label is a parameter
// because --add-check splits through the same function and would otherwise be told its error
// happened in --commands — a wrong file name in a refusal is the kind of small wrongness that
// teaches a reader to stop reading refusals.
function splitCommandList(raw, label = '--commands') {
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
  if (quote) return { error: `unterminated ${quote} in ${label}` };
  parts.push(current);
  return { commands: parts.map((part) => part.trim()).filter(Boolean) };
}

const availableCommands = verificationCommands(project, args.packageManager);
// The waiver asks the question the empty command list used to answer for it. Short-circuiting to
// `[]` meant the project was never asked what it could run, so a repository with a real test suite
// could collect a declaration that it has nothing to run — and the audit scored that harness
// 100/100, a perfect score for a gate that runs no check at all. Measured on a repo defining both
// `test` and `lint`: exit 0, the waiver in both artifacts, `run-benchmark --target` on the result
// reporting `Overall: 100/100`. An absent gate is a gate that cannot fail, so the declaration is
// only honest where there is genuinely nothing to run; everywhere else it is a way of turning the
// harness off while keeping the appearance of one.
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
  // The refusal itself is identical under --dry-run, because a dry run must not report a plan the
  // real run would refuse to execute. Only the last line differs: "Nothing was created" describes a
  // write that did not happen, which under a dry run is true of every run and therefore says nothing.
  console.error(dryRun
    ? 'Nothing would be created: the run described above is the run that would refuse.'
    : 'Nothing was created.');
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

// --add-check GROWS a gate that already exists, so it is a mode of its own rather than a fifth
// thing the create flow does on the way past. A run that appended one check and also wrote
// AGENTS.md would carry two unrelated edits behind one flag, and the refusals below could no longer
// honestly say "nothing was written". It is entered before any artifact is created, and it touches
// init.sh and nothing else — no other file this script writes has a region worth growing into.
if (args.addCheck !== undefined || args.addCheckEntry !== undefined) {
  const addCheckHonoured = new Set(['addCheck', 'addCheckEntry', 'dryRun', 'target']);
  const addCheckConflicts = Object.keys(args)
    .filter((key) => key !== '_' && !addCheckHonoured.has(key));
  if (addCheckConflicts.length > 0) {
    const names = addCheckConflicts.map((key) => `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
    console.error(`REFUSED: --add-check cannot be combined with ${names.join(', ')}.`);
    console.error('This mode appends one check to an init.sh that already exists and creates nothing');
    console.error('elsewhere. Taking a second flag and quietly not honouring it would report an edit');
    console.error('that did not happen, which is the shape of failure this script refuses elsewhere.');
    console.error(dryRun
      ? 'Nothing would be created: the run described above is the run that would refuse.'
      : 'Nothing was created.');
    process.exit(1);
  }

  const addPath = path.join(target, 'init.sh');
  // A refusal naming the wrong flag is the defect the quote-splitter's own `label` parameter was
  // introduced to avoid, and this mode now has two flags. Both grow the same region, so the
  // message names whichever the reader actually typed.
  const growFlag = args.addCheckEntry !== undefined && args.addCheck === undefined
    ? '--add-check-entry'
    : '--add-check';
  if (!await exists(addPath)) {
    console.error(`REFUSED: ${growFlag}, but there is no ${addPath} to add to.`);
    console.error('A check has to join a gate that exists, because the gate is what decides whether a');
    console.error('feature may be called done. Create the harness first, with no flags, then re-run this');
    console.error('command to grow it:');
    console.error(`  ${scriptCommand('create-harness.mjs')} --target "${target}" --commands "npm test"`);
    console.error(dryRun
      ? 'Nothing would be created: the run described above is the run that would refuse.'
      : 'Nothing was created.');
    process.exit(1);
  }

  // An entry reference is checked on disk BEFORE anything is appended. The line itself is an
  // unguarded call precisely so that a later deletion turns the gate red rather than skipping it;
  // refusing here is the other half of that bargain — the gate is never left holding a line that
  // was known to be unable to succeed. Nothing has been written at this point, so "nothing was
  // written" is true of the file as well as of the message.
  let entryPath = null;
  if (args.addCheckEntry !== undefined) {
    if (args.addCheckEntry === true) {
      console.error('REFUSED: --add-check-entry takes a path: --add-check-entry ./verify.sh.');
      console.error('The flag names the one script the gate calls, and a bare flag names nothing, so');
      console.error('there is no entry to check and none was appended. Nothing was written.');
      process.exit(1);
    }
    const normalized = normalizeEntryPath(args.addCheckEntry);
    if (!normalized.ok) {
      console.error(`REFUSED: --add-check-entry — ${normalized.reason}.`);
      console.error('The appended line is the path itself, unquoted and unguarded, so the gate runs');
      console.error('exactly what was named here. Name a relative path inside this repository, such as');
      console.error('  --add-check-entry ./verify.sh');
      console.error('Nothing was written.');
      process.exit(1);
    }
    entryPath = normalized.path;
    const entryFull = path.join(target, entryPath);
    const entryStat = await statOrNull(entryFull);
    if (!entryStat) {
      console.error(`REFUSED: --add-check-entry ${entryPath} — there is no such file in ${target}.`);
      console.error('Appending a call to a file that is not there would leave a gate that fails on a');
      console.error('line nobody can fix, which is how a check stops being read and stays in the file');
      console.error('forever. Create the script, then re-run this command.');
      console.error('Nothing was written.');
      process.exit(1);
    }
    if (!entryStat.isFile()) {
      console.error(`REFUSED: --add-check-entry ${entryPath} — that is a directory, not a script.`);
      console.error('Nothing was written.');
      process.exit(1);
    }
    // An empty file exits 0. It would satisfy the gate for ever while running nothing at all, which
    // is the whole failure this harness exists to prevent — so it is refused here rather than
    // welcomed as a working entry the reader then trusts.
    if (entryStat.size === 0) {
      console.error(`REFUSED: --add-check-entry ${entryPath} — that file is empty.`);
      console.error('An empty script exits 0, so the gate would report success having verified');
      console.error('nothing, and every later green would inherit that. Give it the checks it is');
      console.error('meant to run first. Nothing was written.');
      process.exit(1);
    }
  }

  const addSplit = args.addCheck === undefined
    ? { commands: [] }
    : splitCommandList(String(args.addCheck), '--add-check');
  if (addSplit.error) {
    console.error(`REFUSED: ${addSplit.error}.`);
    console.error('--add-check takes one check per entry and separates entries with commas, so a comma');
    console.error('inside a check must be quoted: --add-check "bash -c \'echo a,b\'" is ONE check.');
    console.error('Splitting it would append a fragment that checks nothing. Nothing was written.');
    process.exit(1);
  }

  // renderVerificationStep turns a placeholder into a step that exits 1, which is exactly right
  // when the GENERATOR emits one — a blank repo must not collect a pass. Appended by a user it
  // would freeze the gate red on a line nobody could have meant to keep, so it is refused by name
  // here rather than left to fail later. Same reasoning as the waiver, opposite direction: that one
  // refuses a gate that cannot fail, this one refuses a gate that cannot pass.
  const addPlaceholders = addSplit.commands.filter(isPlaceholderVerification);
  if (addPlaceholders.length > 0) {
    console.error('REFUSED: --add-check, but these are this generator\'s own placeholders, not checks:');
    for (const command of addPlaceholders) console.error(`  - ${command}`);
    console.error('Appended to a live gate, a placeholder would make ./init.sh exit 1 forever. Add the');
    console.error('real command this repository can run instead.');
    console.error('Nothing was written.');
    process.exit(1);
  }

  const original = await readText(addPath);

  let script = original;
  const appended = [];
  const present = [];
  // One loop over both kinds of append, in the order they were named. They share the region, and
  // the region is rewritten per item — appending the entry first and the commands after it would
  // put them in the opposite order to the one the reader typed, and gate order is the thing this
  // mode exists to stop mattering.
  const requested = [
    ...addSplit.commands.map((command) => ({ command, isEntry: false })),
    ...(entryPath ? [{ command: entryPath, isEntry: true }] : [])
  ];
  for (const { command, isEntry } of requested) {
    const step = appendVerificationCheck(script, command);
    if (step.status === 'refused') {
      console.error(`REFUSED: ${growFlag} "${command}" — ${step.reason}.`);
      console.error('The check region is the span between the RAN=0 counter and the refusal that reads');
      console.error('it. A file without that exact shape is one this script did not generate, or one');
      console.error('restructured by hand since; appending into it would be a guess about where a check');
      console.error('belongs, and a check in the wrong place still looks like a gate. Nothing was written.');
      process.exit(1);
    }
    if (step.status === 'duplicate') {
      present.push({ ...step, isEntry });
      continue;
    }
    script = step.script;
    appended.push({ ...step, isEntry });
  }

  // Behaviour, not position: whether the grown gate actually RUNS the new check is answered by
  // running it, because the answer is not derivable from the anchors. A check inside a dead branch
  // still parses, still exits 0 and still looks like coverage — and templates/init.sh nests its
  // counter inside `if [ -f package.json ]`, so a Python repo appending to that gate gets a check
  // no code path ever reaches, reported as a check that was added.
  //
  // `bash` on PATH is not necessarily a shell that can run this project's gate. On Windows the name
  // often resolves to the WSL bridge, which cannot see the Windows drive: it runs ./init.sh, prints
  // that script's own opening banner, and then dies on the first real command with "npm: command not
  // found" and exit 127. So neither "did it start?" nor "did it print the banner?" separates the two —
  // the failing shell reproduces both. What only a shell that can actually execute this gate produces
  // is the TAIL of a run that got past every command. Asking for the closing banner is what turns "a
  // shell exists" into "a shell that can execute this gate".
  const SHELL_CANDIDATES = [
    process.env.HARNESS_BASH,
    'bash',
    'C:/Program Files/Git/bin/bash.exe',
    'C:/Program Files/Git/usr/bin/bash.exe'
  ].filter(Boolean);
  const GATE_COMPLETION = '=== Verification Complete ===';
  const runGateWith = async (shell) => {
    try {
      const { stdout } = await execFileAsync(shell, ['./init.sh'], { cwd: target, timeout: 300000 });
      return { ok: true, stdout };
    } catch (error) {
      if (error.code === 'ENOENT') return { ok: false, unavailable: true, stdout: '' };
      return { ok: false, stdout: `${error.stdout || ''}${error.stderr || ''}` };
    }
  };
  let shell = null;
  let anyShellRan = false;
  for (const candidate of SHELL_CANDIDATES) {
    const probe = await runGateWith(candidate);
    if (!probe.unavailable) anyShellRan = true;
    if (!probe.unavailable && probe.stdout.includes(GATE_COMPLETION)) { shell = candidate; break; }
  }

  // Unable to run the gate is indistinguishable from a check that does not run, and silence is the
  // one answer this must not give. Refuse with the reason and the way out rather than append on
  // trust: this is the branch where a wrong "ADDED" ships a regression net with a hole in it.
  //
  // The message names which of the two happened rather than a vague "could not verify", because the
  // two need opposite fixes. No shell at all is an environment problem. A shell that started the gate
  // but never reached the completion banner is a RED GATE — usually this repo's own placeholder
  // step, which is correct on a fresh skeleton — and telling someone to install bash would send them
  // off to fix something that is already fine.
  if (!dryRun && appended.length > 0 && !shell) {
    console.error('REFUSED: --add-check could not confirm the grown gate actually runs the new check.');
    if (!anyShellRan) {
      console.error(`No usable shell was found (tried: ${SHELL_CANDIDATES.join(', ')}).`);
      console.error('Install a POSIX shell (Git Bash or WSL), or point HARNESS_BASH at one, and re-run.');
    } else {
      console.error('A shell ran ./init.sh, but the gate never reached its completion line — it is red');
      console.error('before and after this change. Growing a gate that is already failing would report');
      console.error('coverage nobody can confirm, so fix the baseline first, then re-run this command.');
    }
    console.error('Appending on trust is how a check lands in a branch the gate never takes and is still');
    console.error('reported as coverage. Or add the check by hand to the branch ./init.sh actually takes.');
    console.error('Nothing was written.');
    process.exit(1);
  }

  // The baseline run is what keeps a red gate from being read as "the appended step did not run":
  // a gate that already fails is a broken project, not a rejected append. Requiring the command to
  // appear in the SECOND run and be absent from the first is what stops another step's echo from
  // making the confirmation pass by accident.
  const baseline = shell ? await runGateWith(shell) : { ok: false, unavailable: true, stdout: '' };

  // Written once, after every check has been accepted: a refusal halfway down the list would
  // otherwise leave the earlier ones on disk, and "nothing was written" has to be true of the file
  // as well as of the message. The mode is chmod 0o755, never set — writeFile keeps the existing
  // file's mode, and a growth pass has no business changing permissions it did not choose.
  if (!dryRun && appended.length > 0) await writeText(addPath, script);

  // The one thing a grown gate cannot be asked about afterwards is whether its new checks run, so
  // the growth pass answers it while the answer is still undoable.
  //
  // Step one is `bash -n`, a parse with no execution, and it is not an optimisation — it closes the
  // hole the banner test below cannot. A command like `npm test (unit)` renders a line the shell
  // cannot parse; the gate prints the step's banner and then dies on the syntax error, so "the banner
  // appeared" and "the check ran" are the same observation. Measured: the tool reported ADDED and
  // exit 0 on a gate that had gone from exit 0 to exit 2 with the check never executed. Parsing first
  // settles that whole class deterministically, and a syntax error is never a legitimate gate.
  const notRun = [];
  if (!dryRun && appended.length > 0) {
    let syntaxOk = true;
    try {
      await execFileAsync(shell, ['-n', './init.sh'], { cwd: target, timeout: 60000 });
    } catch {
      syntaxOk = false;
    }
    if (!syntaxOk) {
      await writeText(addPath, original);
      console.error('REFUSED: --add-check, and the appended check does not parse as shell.');
      for (const entry of appended) console.error(`  - ${entry.command}`);
      console.error('The file has been put back byte for byte. A check the shell cannot parse is not a');
      console.error('check: the gate would fail on the line itself, before running anything. Quote the');
      console.error('command if it needs spaces or shell metacharacters, e.g.');
      console.error(`  --add-check "bash -c 'go test ./pkg/...'"`);
      process.exit(1);
    }

    // Step two is the run. A check proves it ran by the gate reaching PAST it, and the banner alone
    // only proves the gate ENTERED it — so the evidence is the banner plus the gate still reaching
    // its completion line afterwards. Requiring the banner to be absent from the baseline run keeps
    // another step's banner from standing in for this one.
    const grown = await runGateWith(shell);
    for (const entry of appended) {
      const needle = `=== ${entry.command.trim()} ===`;
      if (!grown.stdout.includes(needle) || baseline.stdout.includes(needle)) notRun.push(entry.command);
    }
    // Entering a step is not finishing it. A check that runs and FAILS leaves its banner in the
    // output too, so on its own this test would call a broken gate a successful append — the mirror
    // of the false pass above. The gate must reach its completion line after the append, and it did
    // before it, so a check that cannot pass is refused rather than added on a technicality.
    if (notRun.length === 0 && !grown.stdout.includes(GATE_COMPLETION)) {
      for (const entry of appended) notRun.push(`${entry.command}  (the gate fails once this check is in)`);
    }
    if (notRun.length > 0) {
      await writeText(addPath, original);
      console.error('REFUSED: --add-check, and the gate does not actually pass with what was appended:');
      for (const entry of notRun) console.error(`  - ${entry}`);
      console.error('The file has been put back byte for byte. A check that never runs is not coverage,');
      console.error('and neither is one that turns the gate red on the spot: both would be reported as');
      console.error('a regression net that is not one. Fix the check until it passes, then add it.');
      console.error('Or add it by hand to the branch ./init.sh actually takes, or regenerate the gate:');
      console.error(`  ${scriptCommand('create-harness.mjs')} --target "${target}" --commands "..."`);
      process.exit(1);
    }
  }

  if (dryRun) {
    console.log(`DRY RUN — no files were written. Plan for ${target}:`);
  } else if (appended.length > 0) {
    console.log(`Grew the gate in ${path.relative(target, addPath)}`);
  } else {
    console.log(`${path.relative(target, addPath)} already runs every check you named.`);
  }
  for (const entry of appended) {
    console.log(`${dryRun ? 'WOULD ADD' : 'ADDED'}  ${entry.command}${entry.isEntry ? '  (entry reference — the gate calls it, it does not hold it)' : ''}`);
    for (const line of entry.step.split('\n')) console.log(`    ${line}`);
  }
  for (const entry of present) {
    console.log(`ALREADY PRESENT  ${entry.command}  (not added again, file unchanged)`);
  }
  // The net change is reported whether or not anything was appended, so "one check, no more" is a
  // number the reader can check rather than a claim. Removed is a structural zero — this path
  // deletes nothing — so it is stated instead of computed; a computed second number would be a
  // second copy of the guarantee that has to hold.
  const delta = lineCount(script) - lineCount(original);
  console.log(`  lines ${lineCount(original)} -> ${lineCount(script)}  (net +${delta} added / 0 removed)`);
  if (appended.length > 0) {
    console.log('  The gate only grows: no existing check is removed or reordered by this command.');
  }
  process.exit(0);
}

// One template, no branches. A second template had existed for a "plain" tier, chosen by a flag,
// and the two files could drift while the self-check asserted they matched; both halves of that
// arrangement are gone now, so the render has exactly one shape to keep correct.
const templateName = 'agents.md';

// Skipped under --dry-run: a preview must not change the filesystem, and creating the target
// directory counts as a change. The existence probes above already tolerate a missing path.
if (!dryRun) await mkdir(target, { recursive: true });

// One copy of the navigation block, read once. It is substituted into the rendered template AND
// appended into instruction files this skill did not render, so those two paths cannot disagree.
const layerSectionText = noAgentsLayer ? '' : (await readText(path.join(TEMPLATE_DIR, 'agents-layer-section.md'))).trim();

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
    : '',
  // Empty string without --spec-layer, so a run that was not asked for a spec layer produces the
  // instruction file it has always produced — byte for byte. The note rides on the existing
  // "read the task's documents" step instead of taking a line of its own, because a spec layer is
  // NOT a resident instruction file: telling the agent to read it every session would turn two
  // optional documents into permanent context cost, which is the mistake this feature exists to
  // avoid. One clause, no new line, no new rule.
  SPEC_LAYER_NOTE: specLayer
    ? '；规范层 `mission.md`、`tech-stack.md` **按需读**，与本次任务无关就不必打开'
    : '',
  // The artifact contract, not just the startup path. Without this the section listed two files
  // while two more sat in the repository root — measured by rendering with and without
  // --spec-layer and finding the section byte-identical. The agent that reads this file every
  // session would have been told what was delivered was two files, by a file that is itself the
  // thing that shipped them. Empty string when the switch is off, so the default render does not
  // move by a byte.
  SPEC_LAYER_ARTIFACTS: specLayer
    ? '- `mission.md`、`tech-stack.md` — 规范层：项目事实与栈证据，**按需读**，各格只由用户陈述或文件证据填入'
    : '',

  // The detail layer is on by default and has an off switch, so all three of these go empty
  // together when it is off. Leaving any of them populated would be worse than having no switch at
  // all: the file would route an agent to `docs/agents/*.md` that were never written, and the agent
  // spends a failed open deciding whether the rule is missing or the path is wrong.
  //
  // LAYER_SECTION is read from templates/agents-layer-section.md rather than written here, because
  // the same text is appended into instruction files this skill did not render (LAYER_APPEND
  // below). Two copies of one navigation block would drift, and the copy nobody regenerates is the
  // one that goes stale.
  // No leading newline: the template line already sits on its own, and a newline prefixed here would
  // leave two blank lines before the section while starving the one after it — the render would not
  // mean anything different, but this file's default output is held to byte-stability.
  LAYER_SECTION: noAgentsLayer ? '' : layerSectionText,
  // Placement matters more than the words: this sits before the verb, so 细则 reads as one more
  // route this file offers. Appended after the document list it read as a fourth document to open,
  // which is the opposite of what it is — and this is the line an agent reads every session.
  LAYER_ROUTE: noAgentsLayer ? '' : '「细则」与',
  // Named with a distinct suffix rather than sharing a prefix with SPEC_LAYER_ARTIFACTS:
  // renderTemplate replaces by split/join in declaration order, and `{{LAYER_ARTIFACTS}}` is a
  // substring of `{{SPEC_LAYER_ARTIFACTS}}`. It renders correctly only because the spec key is
  // declared first — an ordering nobody would notice breaking until a product line came out with a
  // hole in it. Renaming the placeholder removes the dependency instead of documenting it.
  LAYER_ARTIFACTS_LINE: noAgentsLayer
    ? ''
    : '- `docs/agents/harness-creator-verification.md`、`docs/agents/harness-creator-maintenance.md` — 细则层：判据与处置动作，**按需读**\n'
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

// The one append this skill performs. A repo that already has an instruction file — typically one
// another setup skill wrote first, with its own navigation block and its own detail files under
// `docs/agents/` — would otherwise never learn that the detail layer exists, because every other
// section report leaves the merge to a human. This one section is ours, its title is fixed, and
// appending it cannot contradict or overwrite what is already there: no existing line moves.
//
// Mutually exclusive with the blueprint path above, so a single run edits one thing. A file this
// skill rendered itself already carries the section, so the repeat is a no-op rather than a second
// copy.
let layerAppend = null;
if (agentResult.status === 'skipped' && args.blueprint === undefined) {
  const rendered = renderTemplate(templateName, await readText(path.join(TEMPLATE_DIR, templateName)), replacements);
  const section = extractSection(rendered, '## 细则');
  if (section) {
    layerAppend = appendSectionIfMissing(await readText(agentPath), section);
    if (layerAppend.status === 'appended' && !dryRun) await writeText(agentPath, layerAppend.markdown);
    results.push({ path: agentPath, status: layerAppend.status, reason: layerAppend.reason });
  }
}

// Report, never write: a text-match append cannot tell whether the existing file already covers a
// section in English or in another wording, and would add a second startup path — two competing
// instruction files is the drift this skill exists to prevent. Merging is the agent's call.
//
// Compared against the RENDERED template, not the file on disk. The section headings a user has to
// merge are the ones they will see after the placeholders resolve; the raw template still carries
// `{{LAYER_SECTION}}` where `## 细则` belongs, so reading it would drop that section from the report
// and leave the two detail documents on disk with nothing pointing at them — orphans the agent is
// never told about. Only a run that would render the section needs it named.
const missingAgentSections = agentResult.status === 'skipped'
  ? diffSections(
    renderTemplate(templateName, await readText(path.join(TEMPLATE_DIR, templateName)), replacements),
    await readText(agentPath)
  )
  : [];

// No state artifacts are written. Writing a second record beside whatever the project already uses
// is the double-write this skill exists to prevent: whichever file the agent reads second
// contradicts the first. The AGENTS.md says where a verified result goes; it does not create that
// place.

const initPath = path.join(target, 'init.sh');
if (force || !await exists(initPath)) {
  if (!dryRun) {
    // The next-steps block names the instruction file the agent must read. Hardcoding AGENTS.md
    // there made a repository whose instruction file is CLAUDE.md open a file that does not exist,
    // in the one gate every session runs. The literal lives in harness-utils NEXT_STEPS and the
    // hand-copy fallback templates/init.sh carries the same text, so the substitution is applied to
    // the rendered text here rather than to the template: a placeholder in templates/init.sh would
    // break the `nextSteps` agreement gate, which compares that file against NEXT_STEPS verbatim.
    // A target with no instruction file yet renders AGENTS.md, so the self-check's own fixture
    // (empty temp dir) is byte-identical to before.
    const NEXT_STEPS_AGENT_LINE_PREFIX = '1. Read AGENTS.md for the startup path';
    const initScript = initScriptFromCommands(commands, { noVerification })
      .replace(NEXT_STEPS_AGENT_LINE_PREFIX, `1. Read ${agentFile} for the startup path`);
    await writeText(initPath, initScript);
    await chmod(initPath, 0o755);
  }
  results.push({ path: initPath, status: 'written' });
} else {
  results.push({ path: initPath, status: 'skipped', reason: 'exists' });
}

// The spec layer, and only when it was asked for. Same skip rule as the two artifacts above, so a
// re-run cannot quietly rewrite documents the project has since edited in its own words — that is
// the one behaviour an existing-file rule exists for, and the new files do not get an exception.
//
// Detected stack goes into tech-stack.md and NOWHERE else, in particular not into mission.md: the
// two templates are rendered from separate maps on purpose, so there is no code path by which a
// `package.json` can end up as an answer to "what is this project". That separation is the whole
// guarantee, and it is why the detected values are not threaded through one shared map.
const specReplacements = {
  mission: {
    BLUEPRINT: args.blueprint
      ? String(args.blueprint)
      : '待补——由用户陈述「这个项目是什么、最终交付什么」后填入；此字样存在即表示尚未确定'
  },
  'tech-stack': {
    DETECTED_MANIFEST: project.packageJson
      ? '`package.json`（存在）'
      : '待补——未检测到包清单',
    DETECTED_STACK: project.stack === 'generic'
      ? '待补——目录里没有可识别的栈标志文件'
      : `\`${project.stack}\`（由目录内文件名机械得出，非选型结论）`
  }
};

const specResults = [];
if (specLayer) {
  for (const [name, replacementsFor] of Object.entries(specReplacements)) {
    const specPath = path.join(target, `${name}.md`);
    const specResult = await copyTemplate(`spec-layer/${name}.md`, specPath, replacementsFor, { force, dryRun });
    specResults.push(specResult);
    results.push(specResult);
  }
}

// The two pointers into the spec layer (SPEC_LAYER_NOTE, SPEC_LAYER_ARTIFACTS) are rendered into
// the instruction file, and nothing else. So a run that writes the documents while the instruction
// file is skipped or refused leaves two files on disk that no session will ever be told about: the
// instruction file is the one artifact read every session, so "the documents exist" is not
// "the agent knows they exist". Same shape as the --blueprint orphan fixed earlier today — a product
// written with no edge pointing at it.
//
// The predicate is about THIS run, not about the filesystem: an idempotent re-run skips all three
// files, and warning there would be a line printed on every repeat, which is how an agent learns to
// ignore the line. Written documents plus an untouched instruction file is the only orphan shape.
const orphanSpecLayer = specResults.some((r) => r.status === 'written') && agentResult.status !== 'written';

// The detail layer, unconditionally. The instruction file is read in full every session, so what
// belongs there is what every session needs: the startup path, the brakes, the completion gate. The
// judgement behind those — why evidence needs an anchor, what to do about a check the project
// defines but the gate never runs, how a deletion earns its A/B evidence — is needed only when that
// question comes up, and inlining it costs context on every session that will never ask it.
//
// No switch, because the alternative is a second convention: an opt-in layer is a layer most repos
// never turn on, and the rules whose evidence they most need are the ones nobody opts in for. The
// cost is two small files per repo, which is less than the cost of a 4KB instruction file read
// hundreds of times to carry paragraphs most sessions skip.
//
// Paths carry this skill's prefix. `docs/agents/` is an established landing place shared with other
// skills, so a bare `verification.md` there would collide with theirs and leave a reader unable to
// tell whose rule they are reading. The H2 is `## 细则`, never `## Agent skills` — that title
// belongs to another skill, and holdsForeignSections uses this template's own headings to decide
// what `--force` may overwrite, so adopting it would disarm that guard.
const AGENTS_LAYER_FILES = {
  'agents-layer/verification.md': 'docs/agents/harness-creator-verification.md',
  'agents-layer/maintenance.md': 'docs/agents/harness-creator-maintenance.md'
};

if (!noAgentsLayer) {
  for (const [template, relative] of Object.entries(AGENTS_LAYER_FILES)) {
    // The two 细则 point at the instruction file that actually exists in this target. Passing no
    // replacement left the literal `AGENTS.md` behind in a CLAUDE.md repository, which is an
    // on-demand doc telling the agent to open a file that was never written.
    results.push(await copyTemplate(template, path.join(target, relative),
      { AGENT_FILE_NAME: agentFile }, { force, dryRun }));
  }
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

// The optional layer gets a line here for the same reason --dry-run exists at all: the pre-write
// CHECKPOINT tells the agent to show the plan and wait, and this is the only place it learns there
// is anything ELSE it could have written. Without it the criterion for asking lives solely in prose
// the agent has to remember to apply — measured in a live run, an agent that had correctly detected
// the package manifest still produced no question, because a self-consistent dry-run gave it nothing
// to ask about. The gate is the evidence the agent already holds — a detected package manifest
// (package.json, pyproject.toml, requirements.txt, go.mod, Cargo.toml, pom.xml,
// build.gradle[.kts], *.csproj, *.sln) or a stated blueprint — so a directory with neither still
// prints nothing: there the two documents would be all 待补, and naming them would be the
// placeholder-cost this skill exists to avoid. Deliberately NOT also gated on !noAgentsLayer: that
// switch controls the docs/agents/* detail layer, an orthogonal choice from the repository-root
// spec layer. Tying the two meant asking "build only the detail layer?" silently suppressed the
// spec-layer question too — the same class of defect as asking a question whose answer changes
// nothing.
//
// Printed by both paths, and matching in both: the plan must equal the run it previews.
if (!specLayer && (project.stack !== 'generic' || args.blueprint !== undefined)) {
  console.log('');
  console.log('Optional, not written: --spec-layer adds mission.md and tech-stack.md (read on demand).');
  console.log('Ask the user before adding them; without --spec-layer the artifacts on disk are unchanged.');
}

// An orphaned spec layer exits non-zero, for the same reason a refused --force and an unlocatable
// blueprint slot do: the status lines above read as a successful delivery ("WRITTEN mission.md"),
// and an agent that stops there reports work done while the only artifact any session reads carries
// no mention of it. That is the silent degradation this skill exists to refuse, so the exit code is
// the signal that the run is unfinished — the remedy is a hand edit, and the message names it.
if (orphanSpecLayer) {
  console.log('');
  console.log(`ORPHANED SPEC LAYER — ${dryRun ? 'would be written' : 'written'}, but ${agentFile} was not:`);
  for (const r of specResults) if (r.status === 'written') console.log(`  - ${path.relative(target, r.path)}`);
  console.log(`  ${agentFile} (${agentResult.status}${agentResult.reason ? ` (${agentResult.reason})` : ''})`);
  console.log('  Nothing points at these documents: the instruction file is read every session, and the');
  console.log('  only channel for the pointers is the render that just did not happen.');
  console.log(`  Merge them into ${agentFile} by hand, in both places: the startup path (the read-on-demand pointer)`);
  console.log('  and 必需产物. Do not add a second copy of a section the file already covers.');
  process.exitCode = 1;
}

// A refused --force exits non-zero. The status line above already names the file and the sections,
// but exit 0 on a run whose whole point was to overwrite would report success for work that
// deliberately did not happen — the same shape the blueprint refusal and every other refusal here
// refuses. The file is untouched, so there is no partial write to report around.
const refusedResults = results.filter((result) => result.status === 'refused');
if (refusedResults.length > 0) {
  console.log('');
  console.log('REFUSED — nothing was overwritten. Sections this template does not define belong to');
  console.log('whoever wrote them; merge the missing sections by hand, or drop --force when the file');
  console.log('is only stale in wording. Refused:');
  for (const result of refusedResults) console.log(`  - ${path.relative(target, result.path)}`);
  process.exitCode = 1;
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
  // The detail layer is appended even when the rest of the file is left alone, so this sentence used
  // to claim the file "was NOT written" on a run that had just appended ## 细则 to it. Both halves
  // appeared in the same output — the APPENDED status line above and this one — so a reader could
  // not tell which was true, and "NOT written" is the half a user checking their constraint would
  // believe. The append preserves every existing byte and is idempotent, so the honest statement is
  // that the sections below were NOT merged, not that nothing was.
  console.log(`${agentFile}: the sections below were NOT merged in — merge them by hand:`);
  for (const section of missingAgentSections) {
    console.log(`  - ${section}`);
  }
  console.log('  Keep existing content and any third-party block, and do not add a second copy');
  console.log('  of a section the file already covers in another language or wording.');
}

// The next step is the user's, not this skill's. This script places the two artifacts and says
// where they came from; what the project does with them is decided in the repo, not here.
console.log('');
console.log(`Next: read ${agentFile} for the startup path and the invariants, and make ./init.sh run`);
console.log('this project\'s real checks. Until it does, a green ./init.sh proves nothing.');
console.log('This skill creates no tracker, no ticket list and no record file: it derives no entries,');
console.log('no acceptance criteria and no decisions on its own.');
