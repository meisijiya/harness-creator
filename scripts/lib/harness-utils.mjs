import { existsSync } from 'node:fs';
import { access, chmod, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const TEMPLATE_DIR = path.join(SKILL_ROOT, 'templates');

// Help text has to print a command the reader can actually paste. A bare `scripts/x.mjs` only
// resolves from the skill directory, but the agent's cwd is the target repo it is working on —
// so the printed line died with MODULE_NOT_FOUND, and the gate it was meant to invoke never ran.
// SKILL_ROOT is this script's real location; forward slashes keep the line pasteable in bash.
export function scriptCommand(scriptName) {
  return `node ${SKILL_ROOT.replaceAll('\\', '/')}/scripts/${scriptName}`;
}
// Three subsystems, not upstream's five. State and lifecycle are real subsystems of a harness, but
// they are not this skill's to build: they belong to the engineering skills, and the instruction
// file states the delegation. Scoring them here would rate a correctly-delegated repo as broken —
// five checks per subsystem, all failing on artifacts that are supposed to be absent.
export const SUBSYSTEMS = ['instructions', 'verification', 'scope'];

// --- Tier: engineering (default) vs plain -------------------------------------------------
//
// A plain target is a working directory with no engineering workflow to hand to anyone: a
// documentation set, a skill repository, a teaching outline. The artifact is the same one — a
// startup path, a verification entrypoint, invariants — but there is no owner to name, because
// there is nothing the engineering stages could be delegated to. The tier is chosen by the USER
// through a flag and never inferred from the directory: this skill's standing rule is that it does
// not guess a project's shape from what the directory happens to contain, and a tier inferred from
// "there is no package.json here" would fire on every empty engineering repo too.
//
// The marker is a structured line the render writes and the scorer reads, so the two tiers can
// never be satisfied by the same file: engineering must NAME the owner, plain must NOT.
export const PLAIN_TEMPLATE = 'agents-plain.md';
export const PLAIN_TIER_MARKER = '档位：非工程';
// Both halves of the plain tier's claim. A file that merely omits the owner names has said
// nothing at all; a file that states the plain claim while still naming an owner has said two
// contradictory things, and each half is checked so neither can stand in for the other.
export const PLAIN_DELEGATION_TERMS = ['项目自有', '不代建'];
// Duplicated on purpose, not shared with the self-check's OWNER_TERMS: the audit and the gate
// must be able to disagree. One shared list would let a single shrinkage weaken both sides at
// once, so the self-check instead asserts the two lists are set-equal and a divergence is caught
// rather than drifting quietly.
export const DELEGATION_OWNER_TERMS = ['mattpocock', 'to-tickets', 'handoff', 'setup-matt-pocock-skills'];
// Printed by the generated init.sh when a plain project explicitly declares it has nothing to
// verify. It is a disclosure, never a pass: the script must not print the completion banner.
export const NO_VERIFICATION_MARKER = 'NO VERIFICATION DECLARED';

export function isPlainTier(markdown) {
  return String(markdown).includes(PLAIN_TIER_MARKER);
}

export function termsAbsentFrom(text, terms) {
  return terms.filter((term) => !String(text).includes(term));
}

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const [rawKey, inlineValue] = token.slice(2).split('=', 2);
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inlineValue !== undefined) {
      args[key] = inlineValue;
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      args[key] = argv[i + 1];
      i += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

export async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readText(filePath) {
  return readFile(filePath, 'utf8');
}

export async function readJson(filePath) {
  return JSON.parse(await readText(filePath));
}

export async function writeText(filePath, contents) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, 'utf8');
}

export async function copyTemplate(templateName, targetPath, replacements = {}, { force = false, dryRun = false } = {}) {
  if (!force && await exists(targetPath)) {
    return { path: targetPath, status: 'skipped', reason: 'exists' };
  }

  // dryRun decides the same status and stops before touching the filesystem. The plan it reports
  // stays faithful to a following real run because every status here depends only on `force` and on
  // the file's state *now* — never on an earlier write in the same run — so the two cannot disagree.
  // The template is still read under dryRun on purpose: a missing or unreadable template should fail
  // during the preview, not surface for the first time on the real write.
  let contents = await readText(path.join(TEMPLATE_DIR, templateName));
  for (const [key, value] of Object.entries(replacements)) {
    contents = contents.split(`{{${key}}}`).join(value);
  }
  if (!dryRun) {
    await writeText(targetPath, contents);
    if (templateName.endsWith('.sh')) {
      await chmod(targetPath, 0o755);
    }
  }
  return { path: targetPath, status: 'written' };
}

// The template's own H2 headings ARE the section contract: single source, no parallel list to
// keep in sync. Nothing scores a target repo on this — pinning structure at the generation end
// (verbatim copy) is the guarantee, and a title check would only reward empty headings
// (counterexample #6).
export function markdownSections(markdown) {
  return markdown.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^##\s+\S/.test(line));
}

// Sections the template carries that an existing instruction file does not. Used to REPORT a
// merge gap, never to write one: a text match cannot tell whether the existing file already
// covers the section in English or in another wording, so appending would produce a second
// startup path that contradicts the one already there.
export function diffSections(templateMarkdown, existingMarkdown) {
  const existing = existingMarkdown.toLowerCase();
  return markdownSections(templateMarkdown)
    .filter((section) => !existing.includes(section.replace(/^#+\s*/, '').toLowerCase()));
}

// The blueprint is the one slot the user owns and rewrites as the project's plain description
// sharpens, so --blueprint has to work on a file that already exists. This locates that slot and
// rewrites it, and it is the ONLY edit a re-run may make to such a file: everything else has been
// edited since (merged sections, blocks another skill owns), and re-rendering would clobber it.
//
// The locator is syntactic, not heuristic — "the content between the H1 and the first following
// heading" is the shape this template renders. Guessing at "the first paragraph" in a file this
// skill did not author would silently replace prose it never wrote, so an unrecognised shape is
// returned as a refusal for the caller to report. `before` comes back too, because a change to
// someone's instruction file should be printable as before → after rather than only happening.
export function replaceBlueprintSlot(markdown, blueprint) {
  const lines = markdown.split('\n');
  const bare = (line) => line.replace(/\r$/, '');
  const h1 = lines.findIndex((line) => /^#\s+\S/.test(bare(line)));
  if (h1 === -1) return { ok: false, reason: 'no H1 heading to anchor the blueprint slot' };

  let end = lines.length;
  for (let i = h1 + 1; i < lines.length; i += 1) {
    if (/^#{1,6}\s+\S/.test(bare(lines[i]))) { end = i; break; }
  }

  // Blank lines framing the slot are spacing, not content. Trimming them keeps the rewritten file
  // looking like the render instead of collapsing the paragraph against the neighbouring headings.
  let from = h1 + 1;
  let to = end - 1;
  while (from <= to && bare(lines[from]).trim() === '') from += 1;
  while (to >= from && bare(lines[to]).trim() === '') to -= 1;
  if (from > to) return { ok: false, reason: 'no content between the H1 and the next heading' };

  // Every untouched line is carried over verbatim (a CRLF checkout keeps its \r), and the inserted
  // lines adopt the same ending, so "only the slot changed" is true byte for byte.
  const carriageReturn = lines.some((line) => /\r$/.test(line)) ? '\r' : '';
  const written = [
    ...lines.slice(0, from),
    ...String(blueprint).split('\n').map((line) => `${line.replace(/\r$/, '')}${carriageReturn}`),
    ...lines.slice(to + 1)
  ];
  return {
    ok: true,
    markdown: written.join('\n'),
    before: lines.slice(from, to + 1).map(bare).join('\n')
  };
}

export function detectPackageManager(root, explicit) {
  if (explicit) return explicit;
  if (existsSync(path.join(root, 'bun.lockb')) || existsSync(path.join(root, 'bun.lock'))) return 'bun';
  if (existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

export async function detectProject(root) {
  const files = await listFiles(root, { maxFiles: 800 });
  const has = (name) => files.some((file) => file === name || file.endsWith(`/${name}`));
  const hasPrefix = (prefix) => files.some((file) => file.startsWith(prefix));
  const packageJsonPath = path.join(root, 'package.json');
  const packageJson = await exists(packageJsonPath).then((ok) => ok ? readJson(packageJsonPath) : null);

  let stack = 'generic';
  if (packageJson) {
    const deps = { ...packageJson.dependencies, ...packageJson.devDependencies };
    if (deps.react || hasPrefix('src/renderer')) stack = 'typescript-react';
    else if (deps.typescript || has('tsconfig.json')) stack = 'typescript';
    else stack = 'node';
  } else if (has('pyproject.toml') || has('requirements.txt')) {
    stack = 'python';
  } else if (has('go.mod')) {
    stack = 'go';
  } else if (has('Cargo.toml')) {
    stack = 'rust';
  } else if (has('pom.xml')) {
    stack = 'java-maven';
  } else if (has('build.gradle') || has('build.gradle.kts')) {
    stack = 'java-gradle';
  } else if (files.some((file) => file.endsWith('.csproj') || file.endsWith('.sln'))) {
    stack = 'dotnet';
  }

  return {
    root,
    stack,
    packageJson,
    files,
    packageManager: detectPackageManager(root)
  };
}

export async function listFiles(root, { maxFiles = 1000 } = {}) {
  const ignored = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.venv', 'venv', '__pycache__']);
  const results = [];

  async function walk(current, relative) {
    if (results.length >= maxFiles) return;
    let entries = [];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      if (ignored.has(entry.name)) continue;
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, rel);
      } else if (entry.isFile()) {
        results.push(rel);
      }
    }
  }

  await walk(root, '');
  return results.sort();
}

export function verificationCommands(project, explicitPackageManager) {
  const pm = explicitPackageManager || project.packageManager || 'npm';
  const scripts = project.packageJson?.scripts ?? {};
  const run = (script) => {
    if (pm === 'npm') return `npm run ${script}`;
    if (pm === 'yarn') return `yarn ${script}`;
    return `${pm} run ${script}`;
  };

  if (project.stack === 'python') {
    // python3 is the portable name (many systems no longer ship a bare `python`).
    // pytest exits 5 when it collects zero tests — harmless here, so don't let `set -e`
    // treat "no tests yet" as a failure. compileall's -x skips virtualenvs and build
    // artifacts so a syntax check doesn't choke on dependencies it shouldn't compile.
    const py = 'python3';
    return [
      `${py} -m pytest || [ $? -eq 5 ]`,
      `${py} -m compileall -q -x '(^|/)(\\.?venv|env|node_modules|build|dist|__pycache__)(/|$)' .`
    ];
  }

  if (project.stack === 'go') return ['go test ./...'];
  if (project.stack === 'rust') return ['cargo test'];
  if (project.stack === 'java-maven') return ['mvn test'];
  if (project.stack === 'java-gradle') return ['./gradlew test'];
  if (project.stack === 'dotnet') return ['dotnet test'];

  if (!project.packageJson) {
    return [
      'echo "No package manifest detected; replace this line with your project verification command."'
    ];
  }

  const install = pm === 'npm'
    ? 'npm install'
    : pm === 'yarn'
      ? 'yarn install'
      : `${pm} install`;
  const candidates = [
    scripts.check ? run('check') : null,
    scripts.typecheck ? run('typecheck') : null,
    scripts['type-check'] ? run('type-check') : null,
    scripts.lint ? run('lint') : null,
    scripts.test ? (pm === 'npm' ? 'npm test' : `${pm} test`) : null,
    scripts.build ? run('build') : null
  ].filter(Boolean);

  const real = dedupe(candidates);
  // A manifest that defines none of check/typecheck/lint/test/build is the same trap as no
  // manifest at all, and it was left open: install became the only step, so ./init.sh ran,
  // printed "Verification Complete" and exited 0 having verified nothing — while
  // validate-harness.mjs scored that repo 100/100 with "Verification fails fast" PASS, because
  // its checks are existence checks and ./init.sh does exist. Only the placeholder branch
  // refuses, so emit one whenever nothing real is left to run. The contract matches the
  // no-manifest branch: the gate opens when the line is REPLACED, not when it is deleted.
  if (real.length === 0) return [install, SCRIPTLESS_PLACEHOLDER];
  return [install, ...real];
}

export function initScriptFromCommands(commands, { plain = false, noVerification = false } = {}) {
  if (noVerification) return noVerificationScript();
  const body = (commands || []).map(renderVerificationStep).join('\n\n');
  // The next-steps block names state, so it names exactly the artifacts this skill writes and
  // nothing else. A startup script that tells the agent to read a file this skill never creates is
  // a dangling instruction, and the artifact list stays clean because the leak sits in the
  // contents of a file that IS expected to exist.
  //
  // State no longer appears here because it no longer lives here: it is delegated, and the route
  // to it is the instruction file, which exists before the tracker is configured. Naming the
  // tracker's own files instead would be exactly the dangling pointer this block is built to
  // avoid — a fresh repo has none of them until setup has run.
  // The startup route has to match the tier the artifact was rendered for. A plain project has no
  // tracker to configure and no tickets to pick from, so naming them here would send the agent after
  // files this skill deliberately does not create — the dangling pointer this block exists to avoid.
  const nextSteps = plain ? [
    '1. Read AGENTS.md for the startup path and the invariants',
    '2. Pick ONE unfinished deliverable whose prerequisites are clear',
    '3. Produce only that deliverable, staying inside its scope',
    '4. Re-run this script before claiming done'
  ] : [
    '1. Configure the tracker once: /setup-matt-pocock-skills',
    '2. Read AGENTS.md for the startup path, the invariants and where state lives',
    '3. Pick ONE unfinished ticket whose blocking edges are clear',
    '4. Implement only that ticket, staying inside its scope',
    '5. Re-run this script before claiming done'
  ];
  return `#!/bin/bash
set -e

# Verification gate. It must exit 0 before any feature is claimed done.

echo "=== Harness Initialization ==="

# A script that package.json does not define yet is SKIPPED with a notice, so a
# fresh skeleton runs cleanly; a real verification failure still aborts below.
has_script() {
  [ -f package.json ] && node -e "const s=require('./package.json').scripts||{};process.exit(s[process.argv[1]]?0:1)" "$1"
}

explain_failure() {
  echo ""
  echo "=== Verification FAILED ==="
  echo "Either the baseline is broken, or this skeleton has no runnable check yet."
  echo "Fix the baseline first, then re-run ./init.sh."
  echo "Do NOT mark any feature done until ./init.sh exits 0."
}
trap explain_failure ERR

# Counts the checks that actually ran. A guarded step SKIPS with a notice when package.json does not
# define the script yet, so before this counter existed ./init.sh could skip every check, print
# "Verification Complete" and exit 0 having verified nothing — the gate cannot fail, and "no feature
# may be marked done without evidence" becomes structurally unreachable on exactly the fresh skeleton
# where it matters most. Emitted unconditionally, because the branch that reaches the success tail at
# exit 0 must be the one that earned it. Same contract as the manual fallback templates/init.sh,
# which is the other producer of this file and carried the counter while this one did not.
RAN=0

${body}

if [ "$RAN" -eq 0 ]; then
  echo ""
  echo "ERROR: nothing in this harness verified anything — every check was skipped."
  echo "This project does not define the scripts named above yet, so none of them ran."
  echo "Replace them in ./init.sh with commands this repository can really run."
  echo "Until then ./init.sh MUST fail: a gate that cannot fail is not a gate."
  exit 1
fi

echo "=== Verification Complete ==="
echo ""
echo "Next steps:"
${nextSteps.map((line) => `echo "${line}"`).join('\n')}
`;
}

// A plain project that declares it has nothing to verify still gets a startup script: the
// instruction file tells the agent to run ./init.sh, so the file has to exist and has to be honest.
// What it must never do is report a success it did not earn. The completion banner the other
// branches print is deliberately absent here, the disclosure leads, and the exit-0 answers "is the
// startup path walkable?" — never "was anything verified?". The declaration is reachable only
// through an explicit flag AND the plain tier, so a repository that does have a baseline cannot
// collect it as a waiver; there, the placeholder branch still exits 1 until a real check replaces it.
function noVerificationScript() {
  const body = [
    'echo "=== Harness Initialization ==="',
    'echo ""',
    `echo "=== ${NO_VERIFICATION_MARKER} ==="`,
    'echo "This non-engineering project declares that it has no runnable baseline check."',
    'echo "This script therefore verified NOTHING. It exits 0 so the startup path stays walkable."',
    'echo "Nothing here proves a deliverable is complete: evidence is still required by AGENTS.md."',
    'echo "Replace this file with real checks when the project has any."',
    'exit 0'
  ].join('\n');
  return `#!/bin/bash
set -e

# Verification gate — DECLARED ABSENT.
#
# A gate that cannot fail is not a gate, so this file does not pretend to be one. It is a
# disclosure, not a pass: the project has declared, explicitly and in AGENTS.md as well, that there
# is nothing to run. Deleting this file is not a bypass — replacing it with real checks is the fix.
${body}
`;
}

const INSTALL_STEP = /^(?:npm|pnpm|yarn|bun) (?:install|ci|i)$/;
// The generator's own placeholder for "no manifest detected". Matched as a substring so the
// scripted probe in run-benchmark.mjs can hand the real sentence in and get the real branch,
// rather than restating this code's output and testing its own copy of the string.
const PLACEHOLDER_VERIFICATION = /No package manifest detected; replace this line/;
// The second shape that reaches renderVerificationStep with nothing real to verify: a manifest
// exists but defines none of the scripts this generator knows how to run. Declared beside the
// no-manifest sentence so both refusal branches are visible in one place.
const SCRIPTLESS_PLACEHOLDER = 'echo "package.json defines no check, typecheck, lint, test or build script yet; replace this line with the project verification command."';
const SCRIPTLESS_PLACEHOLDER_VERIFICATION = /defines no check, typecheck, lint, test or build script yet/;
const SCRIPT_STEP = /^(?:npm|pnpm|yarn|bun) (?:run )?([\w:.-]+)$/;
const NON_SCRIPT_ARGS = new Set(['install', 'ci', 'i', 'exec', 'dlx', 'create']);

export function renderVerificationStep(command) {
  // An empty project has nothing to verify yet, so the generator can only leave a placeholder.
  // Executing that placeholder as a plain echo would exit 0 and make ./init.sh report success
  // while verifying nothing — the harness would ship a gate that cannot fail, and "no feature
  // may be marked done without evidence" becomes structurally unreachable on a blank repo.
  // The step therefore exits non-zero until it is replaced: the gate opens exactly when the
  // byte-identical placeholder disappears. Its exit status is the honest answer to
  // "was any baseline verified?" — no. Deleting the line is not a bypass; replacing it is the fix.
  if (PLACEHOLDER_VERIFICATION.test(command) || SCRIPTLESS_PLACEHOLDER_VERIFICATION.test(command)) {
    return `echo "=== ${escapeForEcho(command)} ==="
echo "ERROR: this is an unreplaced placeholder — nothing is being verified."
echo "Replace this step in ./init.sh with the project's real verification command."
echo "Until then ./init.sh MUST fail: a gate that cannot fail is not a gate."
exit 1`;
  }

  if (INSTALL_STEP.test(command)) {
    return `if [ -d node_modules ]; then
  echo "SKIP: ${escapeForEcho(command)} (node_modules already present)"
else
  echo "=== ${escapeForEcho(command)} ==="
  ${command}
fi`;
  }

  const script = command.match(SCRIPT_STEP);
  if (script && !NON_SCRIPT_ARGS.has(script[1])) {
    const name = script[1];
    // RAN=1 sits inside the branch that really executes, never beside the SKIP notice. The counter,
    // not the notice, is what lets the assembled script tell "this check ran" apart from "this check
    // was skipped" — and a notice cannot be asserted on without asserting on our own prose.
    return `if has_script "${name}"; then
  echo "=== ${escapeForEcho(command)} ==="
  ${command}
  RAN=1
else
  echo "SKIP: ${escapeForEcho(command)} (package.json has no \\"${name}\\" script yet)"
fi`;
  }

  // Reached by every command that is not a package-manager script step and not an install: pytest,
  // cargo test, mvn test, dotnet test, and anything handed in through --commands. It always runs, so
  // it always counts. The install branch above deliberately does not: installing dependencies is a
  // prerequisite, and a run whose only step was an install is exactly the shape the refusal at the
  // foot of the script exists to catch.
  return `echo "=== ${escapeForEcho(command)} ==="
${command}
RAN=1`;
}

function escapeForEcho(value) {
  return value.replaceAll('"', '\\"');
}

export function dedupe(values) {
  return [...new Set(values)];
}

// --- Command references ---------------------------------------------------------------
//
// A harness is a set of instructions to run things. When one of those things stops existing — a
// script renamed in package.json, a helper deleted — nothing else fails: the harness keeps telling
// the agent to run a command that no longer resolves, and no score moves. This is the one species of
// staleness that can be settled without judgment, so it is settled mechanically here. The rest
// cannot be, which is why the wrap-up procedure hands those items to the user instead.
//
// Two constraints shape the design. (1) It never executes the target's init.sh: scoring arbitrary
// repositories by running them is a different tool with a different risk profile, and the failure
// above is visible from the text. (2) Partial coverage has to stay visible. Resolvers exist for
// manifest scripts and for runnable files; `pytest -q`, `cargo test` and friends have no local
// existence proof. Those land in `unchecked` and are reported BY NAME, because a check that silently
// skips what it cannot verify reads as full coverage while delivering less.
//
// Deliberately NOT checked: documentation and configuration references such as
// `docs/agents/issue-tracker.md`. The upstream setup skills create those on their own schedule, so
// flagging their absence would fail a correct harness — and a scorer that fails a correct outcome is
// worse than no scorer.
const MANIFEST_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
// Requires a `./` prefix or an embedded slash. A bare `build.sh` in prose usually names a file the
// reader is expected to have, not one this harness promises exists; flagging it is the
// false-positive shape described above. Executable extensions only, for the same reason.
const RUNNABLE_REFERENCE = /^(?:\.{1,2}\/[\w./-]+|[\w.-]+\/[\w./-]+)\.(?:sh|bash|zsh|mjs|cjs|js|ts|py|rb|go|rs)$/;
// Words that can open a command segment but name no binary. `has_script` is deliberately absent: it
// is a function the generated init.sh defines itself, and shellFunctions() excludes it by the same
// rule that would exclude any other helper — the directory, not a list, is what decides.
const SHELL_WORDS = new Set([
  'if', 'then', 'else', 'elif', 'fi', 'for', 'while', 'until', 'do', 'done', 'case', 'esac', 'in',
  'function', 'return', 'local', 'export', 'declare', 'typeset', 'unset', 'echo', 'printf', 'exit',
  'set', 'cd', 'pwd', 'test', 'source', 'true', 'false', 'read', 'trap', 'shift', 'eval', 'exec',
  'command', 'wait', 'let', 'break', 'continue', ':', '[', ']'
]);

// Functions the file defines are callable names, not external commands. Without this the generated
// init.sh's own `has_script` helper would be reported as an unresolvable command on every harness
// this skill renders — the false-positive shape again, this time aimed at our own output.
function shellFunctions(text) {
  const names = new Set();
  for (const match of text.matchAll(/(?:^|[\n;])\s*([A-Za-z_][\w-]*)\s*\(\)\s*\{/g)) names.add(match[1]);
  return names;
}

export async function collectCommandReferences(root, files) {
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  const sources = [
    ['init.sh', byPath.get('init.sh') || ''],
    ['AGENTS.md', byPath.get('AGENTS.md') || byPath.get('CLAUDE.md') || '']
  ];

  // Guard detection is deliberately cross-file. A script that the harness's executable gate skips
  // with a notice is handled on that basis, and the instruction file's "required checks" list naming
  // the same script describes that gate rather than making an independent promise. Scoping the guard
  // to its own file made the generator's OWN output fail: init.sh wraps `npm run lint` in
  // `has_script "lint"` while AGENTS.md lists it plainly, so one command collected two verdicts —
  // guarded on one side, dangling on the other.
  const guardedScripts = new Set();
  for (const match of sources[0][1].matchAll(/has_script\s+"([^"]+)"/g)) guardedScripts.add(match[1]);

  let manifestScripts = null;
  const manifestPath = path.join(root, 'package.json');
  if (await exists(manifestPath)) {
    try {
      const manifest = JSON.parse(await readText(manifestPath));
      if (manifest && typeof manifest.scripts === 'object' && manifest.scripts) {
        manifestScripts = manifest.scripts;
      }
    } catch {
      // An unparseable manifest proves nothing, so script references fall to `unchecked` rather than
      // being called dangling on the strength of a file this scan could not read.
      manifestScripts = null;
    }
  }

  const resolved = [];
  const dangling = [];
  const guarded = [];
  const unchecked = [];
  const push = (bucket, value) => { if (!bucket.includes(value)) bucket.push(value); };

  for (const [source, text] of sources) {
    const defined = shellFunctions(text);
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.replace(/(^|\s)#.*$/, '').trim();
      if (!line) continue;
      for (const segment of line.split(/[;|&]+/)) {
        const tokens = segment.trim().replace(/[`"']/g, ' ').split(/[\s()<>{}]+/).filter(Boolean);
        if (tokens.length === 0) continue;
        // Whether this segment already carries a reference the stronger buckets can speak to. A
        // covered segment is not ALSO reported as an unresolvable binary: the file or manifest check
        // is the more specific statement, and emitting both would double-count one command.
        let covered = false;
        for (let i = 0; i < tokens.length; i += 1) {
          const token = tokens[i];
          if (MANIFEST_MANAGERS.has(token)) {
            covered = true;
            const name = tokens[i + 1] === 'run' ? tokens[i + 2] : tokens[i + 1];
            if (!name) continue;
            // Install/exec/create are prerequisites, not verification commands, and no static scan
            // proves them. They are reported rather than dropped — the bucket exists so that what
            // could not be checked stays on the record.
            if (NON_SCRIPT_ARGS.has(name)) { push(unchecked, `${token} ${name}`); continue; }
            const label = `${token} run ${name}`;
            if (!manifestScripts) { push(unchecked, label); continue; }
            if (Object.prototype.hasOwnProperty.call(manifestScripts, name)) { push(resolved, label); continue; }
            // A script the manifest does not define is a handled skip when the harness's own gate
            // wraps it, not a broken reference. Flagging it would fail the generator's own output.
            if (guardedScripts.has(name)) { push(guarded, label); continue; }
            push(dangling, label);
            continue;
          }
          const candidate = token.replace(/[.,;:]+$/, '');
          if (RUNNABLE_REFERENCE.test(candidate)) {
            covered = true;
            if (await exists(path.resolve(root, candidate))) push(resolved, candidate);
            else push(dangling, candidate);
          }
        }
        // Command-position names are tracked for init.sh only: that is the file which actually runs,
        // so a binary there that no resolver knows is a real gap. The instruction file is prose.
        if (source !== 'init.sh' || covered) continue;
        // Read the lead from the segment BEFORE its first quote. Quoted text is data — an echo
        // banner, or the body of `node -e "…"` — and tokenising it reported `process.exit` as a
        // command name, which asserts a program that does not exist.
        const leadText = segment.split(/["'`]/)[0].trim();
        const lead = leadText ? leadText.split(/\s+/)[0] : '';
        if (!lead || !/^[A-Za-z_][\w.-]*$/.test(lead)) continue;
        if (SHELL_WORDS.has(lead) || defined.has(lead)) continue;
        push(unchecked, lead);
      }
    }
  }

  return { resolved, dangling, guarded, unchecked };
}

// One sentence, because both reporting surfaces print `check.message` verbatim. The unchecked list
// is present whenever it is non-empty — that is the entire point of the bucket.
function referencesCheck(references, message = 'Documented commands resolve') {
  if (!references) {
    return { pass: false, message: `${message} (reference scan not collected — unverified, not resolved)` };
  }
  const { resolved = [], dangling = [], guarded = [], unchecked: uncheckedRefs = [] } = references;
  const parts = [`${resolved.length} resolved`, `${guarded.length} guarded`];
  if (uncheckedRefs.length) parts.push(`${uncheckedRefs.length} not statically checkable: ${uncheckedRefs.join(', ')}`);
  if (dangling.length) parts.unshift(`DANGLING: ${dangling.join(', ')}`);
  return { pass: dangling.length === 0, message: `${message} (${parts.join('; ')})` };
}

export function scoreHarness(files, { references } = {}) {
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  const allText = files.map((file) => `${file.path}\n${file.content}`).join('\n\n');
  const agents = byPath.get('AGENTS.md') || byPath.get('CLAUDE.md') || '';
  const init = byPath.get('init.sh') || '';

  // The tier is read OFF THE ARTIFACT rather than passed in, because validate-harness.mjs only
  // ever receives a directory: there is no flag to thread through, and inferring the tier from the
  // directory's contents is exactly what this skill refuses to do. The marker is written by the
  // render, so it is a claim the artifact makes about itself — and both halves are then checked, so
  // a file cannot make the claim and contradict it in the same breath.
  const plain = isPlainTier(agents);
  const structured = structuredText(agents);
  const plainDelegation = {
    pass: plain
      && PLAIN_DELEGATION_TERMS.every((term) => structured.includes(term))
      && DELEGATION_OWNER_TERMS.every((term) => !agents.includes(term)),
    message: 'Owner-free: state left to the project, and no delegated owner named'
  };
  // A plain project may legitimately have nothing to verify, but only by SAYING SO in both places
  // an agent looks: the instruction file it reads and the script it runs. Silence still falls
  // through to the ordinary static-check requirement, so this arm cannot be satisfied by omission —
  // and the engineering tier keeps the plain check unchanged, so the disclosure is not a route out
  // of the gate for a repository that does have a baseline.
  const plainGate =
    textHas(init + agents, ['build', 'type', 'lint', 'compile', '类型', '构建']).pass
    || (init.includes(NO_VERIFICATION_MARKER) && agents.includes('无验证命令'));

  // A harness is scored on the artifacts a harness ships — and only on the ones this skill ships.
  // Nothing below reads CONTEXT.md, docs/adr/, docs/agents/*, feature_list.json or progress.md.
  // The first three belong to whichever skill produces them; the last two no longer exist here at
  // all, because state left with them. Reading another skill's output made this scorer treat it as
  // this one's evidence, which in turn pushed the template toward writing those files itself so the
  // scorer would find them — the check and the template arguing the same side of the question.

  const checks = {
    instructions: [
      hasFile(byPath, ['AGENTS.md', 'CLAUDE.md'], 'Agent instruction file exists'),
      structuredHas(agents, ['Startup Workflow', 'Before writing code', '启动工作流', '编写代码前'], 'Startup workflow documented'),
      structuredHas(agents, ['Definition of Done', 'done only when', '完成定义'], 'Definition of done documented'),
      structuredHas(agents, ['Verification Commands', '验证命令', './init.sh', 'test', 'verify', '测试'], 'Verification commands discoverable'),
      // State and handoff are delegated, so what the instruction file must state is WHO owns them
      // and what the prerequisite is — not where a local file lives. Requiring an in-repo artifact
      // here is what made this scorer reward shipping one.
      //
      // All-of, not any-of, since 09-28: the two fixed slots ARE the content of the delegation, and
      // `.some()` let a file name only one of them and still pass. The conjunction used to be carried
      // by the two-owner check below; when the user collapsed the delegation to a single owner the
      // conjunction moved to the slots rather than leaving this helper unwired.
      // On the plain tier these two collapse into one check: there is no owner to name, so what the
      // artifact must state instead is WHERE state goes when nobody owns it — and that it names no
      // owner anyway. The tiers are mutually exclusive by construction (one requires the names the
      // other forbids), so neither can be satisfied by the other's render.
      ...(plain
        ? [plainDelegation]
        : [
            structuredHasAll(agents, ['to-tickets', 'handoff'], 'Delegated state and handoff owners named'),
            // Was all-of over two owners until 09-28, when the user removed the runtime-routed second
            // owner (superpowers) and made the engineering workflow one system's. What the render must
            // now name is that single owner; the removed one is forbidden instead, in
            // FORBIDDEN_IN_AGENTS_MD over in run-benchmark.mjs. A required name and a forbidden name
            // are the two sides of the same claim, and either alone is satisfied by a degenerate file.
            structuredHas(agents, ['mattpocock'], 'Single named owner holds the engineering workflow')
          ])
    ],
    verification: [
      hasFile(byPath, ['init.sh'], 'Verification entrypoint exists'),
      textHas(init, ['set -e'], 'Verification fails fast'),
      // The engineering tier asks for a test command; a plain target has no such concept, so that
      // one requirement is replaced by the tier's own: EITHER a real static check is documented, OR
      // both the instruction file and the generated gate carry the explicit no-verification
      // disclosure. Silence satisfies neither half, so the waiver cannot be collected by saying
      // nothing. The static-check requirement below stays in force for BOTH tiers — which is what
      // gives the declaration a visible cost: the harness still scores, but no longer perfectly, and
      // the audit can say why. A waiver that reached full marks would be the cheapest route to a
      // perfect score, and this suite exists to stop exactly that.
      ...(plain
        ? [{ pass: plainGate, message: 'A real static check, or an explicit no-verification disclosure in both places' }]
        : [textHas(init + agents, ['test', 'pytest', 'vitest', 'cargo test', 'go test', 'dotnet test', '测试'], 'Test command documented')]),
      textHas(init + agents, ['build', 'type', 'lint', 'compile', '类型', '构建'], 'Static/build check documented'),
      textHas(allText, ['Evidence', 'Verification Evidence', 'command and output', '证据', 'CI'], 'Verification evidence is recorded'),
      // Inside the existing verification subsystem, never a fourth one: the three subsystems are a
      // ratified boundary, and a dangling command is a verification defect — the harness names a
      // check that cannot run. `references` is threaded in from the caller because resolving it needs
      // the target root (package.json, file existence), which loadHarnessFiles deliberately does not
      // read: its candidates remain exactly the artifacts this skill ships.
      referencesCheck(references)
    ],
    scope: [
      // The one-at-a-time rule is the same invariant on both tiers; only its noun differs, because a
      // plain working directory produces deliverables rather than tickets. Both nouns are listed
      // here rather than branched, since this is one requirement and a branch would let the two
      // tiers drift into two separate rules that no longer have to agree.
      structuredHas(agents, ['One feature at a time', 'one-feature-at-a-time', 'one requirement at a time', 'one ticket at a time', '一次一个功能', '一次一个需求', '一次一个工单', '一次一个交付物'], 'One-ticket-at-a-time rule exists'),
      textHas(agents, ['dependencies', 'blocking', '阻塞边', '依赖'], 'Blocking edges are stated'),
      textHas(agents, ['status', '状态'], 'Ticket status is explicit'),
      structuredHas(agents, ['Stay in scope', 'scope', '保持在本工单范围内', '保持在范围内', '保持在本交付物范围内', '范围'], 'Scope boundary documented'),
      structuredHas(agents, ['Definition of Done', '完成定义'], 'Completion gate limits scope closure')
    ]
  };

  const subsystems = Object.fromEntries(Object.entries(checks).map(([name, subsystemChecks]) => {
    const passed = subsystemChecks.filter((check) => check.pass).length;
    const score = Math.max(1, Math.round((passed / subsystemChecks.length) * 5));
    return [name, {
      score,
      passed,
      total: subsystemChecks.length,
      checks: subsystemChecks
    }];
  }));

  const total = Object.values(subsystems).reduce((sum, item) => sum + item.score, 0);
  const overall = Math.round((total / (SUBSYSTEMS.length * 5)) * 100);
  // A bottleneck only means something when a subsystem is weaker than the rest. Two ways that
  // stops being true: every subsystem maxes out (nothing to fix), or several sit at the same
  // lowest score (no ranking exists to single one out). Picking the first of a tie is not a
  // smaller answer than the tie — it is a different claim, and the audit's headline is the one
  // line a user will quote, so it must not assert a ranking the scores do not support.
  const bottlenecks = pickBottlenecks(subsystems);
  return {
    overall,
    bottlenecks,
    // For callers that need one name. Null when the tie makes a single name unrepresentative.
    bottleneck: bottlenecks.length === 1 ? bottlenecks[0] : null,
    subsystems
  };
}

// Every subsystem sharing the lowest score, in subsystem order. Empty when nothing is weak.
export function pickBottlenecks(subsystems) {
  const entries = Object.entries(subsystems);
  if (entries.length === 0) return [];
  const lowest = Math.min(...entries.map(([, item]) => item.score));
  if (lowest === 5) return [];
  return entries.filter(([, item]) => item.score === lowest).map(([name]) => name);
}

// One line for consoles and HTML. Naming one of several tied subsystems would print an arbitrary
// pick with the same confidence as a real diagnosis, so a tie is spelled out as a tie.
export function bottleneckLabel(result) {
  const names = result.bottlenecks?.length
    ? result.bottlenecks
    : (result.bottleneck ? [result.bottleneck] : []);
  if (names.length === 0) return 'none — all subsystems at full score';
  if (names.length === 1) return names[0];
  return `${names.join(', ')} (${names.length} tied at ${result.subsystems?.[names[0]]?.score}/5)`;
}

function hasFile(byPath, names, message) {
  return { pass: names.some((name) => byPath.has(name)), message };
}

function textHas(text, needles, message) {
  const lower = text.toLowerCase();
  return { pass: needles.some((needle) => lower.includes(needle.toLowerCase())), message };
}

// A real instruction doc carries its load-bearing phrases in structure — headings,
// list items, tables, fenced code, or bold lead-ins — not in free prose. Scoring only
// the structured lines means a genuine harness still passes, while a file that just
// sprinkles the right keywords across a paragraph to game the score does not.
function structuredText(markdown) {
  const kept = [];
  let inFence = false;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    if (inFence) { kept.push(line); continue; }
    if (!line) continue;
    const isHeading = /^#{1,6}\s/.test(line);
    const isList = /^([-*+]|\d+\.)\s/.test(line);
    const isTable = line.startsWith('|');
    const isBoldLead = /^\*\*[^*]+\*\*/.test(line);
    if (isHeading || isList || isTable || isBoldLead) kept.push(line);
  }
  return kept.join('\n');
}

function structuredHas(markdown, needles, message) {
  return textHas(structuredText(markdown), needles, message);
}

// Conjunction, which structuredHas cannot express — it is `.some()`, so a file that names only ONE
// of the two delegated slots still passes it. Carried by the two-owner check until 09-28, when the
// user collapsed the delegation to a single owner and removed the second one; the conjunction moved
// to the two slots that remain, because those names ARE the content of the delegation sentence.
//
// Scope note: this audit check is deliberately coarse. The exact wording the render must carry — the
// owner's name, both slots and the setup prerequisite — is enforced with word-by-word precision by
// the GATE on files this skill renders, `checkScopeBoundary`'s OWNER_TERMS. The audit scores
// arbitrary repos, including hand-written ones, and the doctrine at the top of this file applies:
// a scorer that fails a correct outcome is worse than no scorer.
function structuredHasAll(markdown, needles, message) {
  const structured = structuredText(markdown).toLowerCase();
  return { pass: needles.every((needle) => structured.includes(needle.toLowerCase())), message };
}

// The upstream setup skill edits CLAUDE.md when it exists and treats AGENTS.md and
// CLAUDE.md as mutually exclusive ("never create AGENTS.md when CLAUDE.md already exists").
// harness-creator follows the same invariant so the two skills never end up maintaining
// divergent instruction files in one repo.
export async function detectAgentFile(root, explicit) {
  if (explicit) return explicit;
  if (await exists(path.join(root, 'CLAUDE.md'))) return 'CLAUDE.md';
  return 'AGENTS.md';
}

// The harness artifacts are a closed, known set of exactly what this skill ships: the instruction
// file and the verification entrypoint. Nothing here probes for directories owned by other skills —
// scanning for them was how this loader used to end up reading CONTEXT.md, docs/adr/ and
// docs/agents/* and scoring them as if this skill had produced them. The two state files that used
// to sit in this list are gone for the same reason one level further out: state is delegated, so
// their absence is the correct state, and listing them here would report a properly delegated repo
// as broken — a scorer that fails the correct outcome is worse than no scorer.
export async function loadHarnessFiles(root) {
  const candidates = [
    'AGENTS.md',
    'CLAUDE.md',
    'init.sh'
  ];
  const files = [];
  for (const candidate of candidates) {
    const fullPath = path.join(root, candidate);
    if (await exists(fullPath)) {
      files.push({ path: candidate, content: await readText(fullPath) });
    }
  }
  return files;
}

export function formatScoreReport(result, root = '.') {
  const lines = [
    `Harness validation for ${root}`,
    `Overall: ${result.overall}/100`,
    `Bottleneck: ${bottleneckLabel(result)}`,
    ''
  ];

  for (const [name, subsystem] of Object.entries(result.subsystems)) {
    lines.push(`${name}: ${subsystem.score}/5 (${subsystem.passed}/${subsystem.total})`);
    for (const check of subsystem.checks) {
      lines.push(`  ${check.pass ? 'PASS' : 'FAIL'} ${check.message}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function htmlReport(result, title = 'Harness Assessment') {
  const rows = Object.entries(result.subsystems).map(([name, subsystem]) => {
    const checks = subsystem.checks.map((check) =>
      `<li class="${check.pass ? 'pass' : 'fail'}">${check.pass ? 'PASS' : 'FAIL'} ${escapeHtml(check.message)}</li>`
    ).join('');
    return `<section>
      <h2>${escapeHtml(name)} <span>${subsystem.score}/5</span></h2>
      <ul>${checks}</ul>
    </section>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 32px; color: #172026; background: #f7f8fa; }
    main { max-width: 960px; margin: 0 auto; }
    header { margin-bottom: 24px; }
    h1 { margin: 0 0 8px; font-size: 32px; }
    .summary { display: flex; gap: 16px; flex-wrap: wrap; margin: 20px 0; }
    .metric { background: white; border: 1px solid #d9dee5; border-radius: 8px; padding: 16px 18px; min-width: 180px; }
    .metric strong { display: block; font-size: 28px; margin-top: 4px; }
    section { background: white; border: 1px solid #d9dee5; border-radius: 8px; margin: 14px 0; padding: 16px 18px; }
    h2 { margin: 0 0 10px; font-size: 20px; display: flex; justify-content: space-between; }
    ul { margin: 0; padding-left: 20px; }
    li { margin: 6px 0; }
    .pass { color: #126c43; }
    .fail { color: #a23020; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${escapeHtml(title)}</h1>
      <p>Three-subsystem harness validation report.</p>
      <div class="summary">
        <div class="metric">Overall<strong>${result.overall}/100</strong></div>
        <div class="metric">Bottleneck<strong>${escapeHtml(bottleneckLabel(result))}</strong></div>
      </div>
    </header>
    ${rows}
  </main>
</body>
</html>
`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export async function copyFileSafe(source, target, { force = false } = {}) {
  if (!force && await exists(target)) {
    return { path: target, status: 'skipped', reason: 'exists' };
  }
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
  return { path: target, status: 'written' };
}
