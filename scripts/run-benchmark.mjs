#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  bottleneckLabel,
  formatScoreReport,
  htmlReport,
  loadHarnessFiles,
  parseArgs,
  pickBottlenecks,
  readJson,
  readText,
  renderVerificationStep,
  scoreHarness,
  scriptCommand,
  writeText
} from './lib/harness-utils.mjs';

const execFileAsync = promisify(execFile);

// The root instruction file must stay short enough to actually be read and followed. Baseline
// is the pre-optimization SKILL.md; the cap is 150% of it and is enforced here rather than
// recorded only as a convention — a constraint with no mechanical carrier is the thing this
// skill tells everyone else to fix. Editing SKILL.md near the cap means de-duplicating first.
const SKILL_MD_BASELINE_BYTES = 7889;
const SKILL_MD_MAX_BYTES = Math.floor(SKILL_MD_BASELINE_BYTES * 1.5);

// Declared at module scope, ahead of the runSelfCheck() call: a const sitting next to the function
// that reads it would still be in its temporal dead zone at that call site.
const SELFTEXT_EXEMPT = new Set(['README.md']);
const RELATIVE_SELF_REFERENCE = /(?:node\s+scripts\/[a-z0-9-]+\.mjs|skills\/harness-creator\/scripts\/)/;

// A path relative to the SKILL repository (e.g. `skills/harness-creator/references/x.md`) is
// dead on arrival in a target repo: the generated AGENTS.md is read by an agent whose cwd is
// that repo, and the skill lives in the runtime's skills directory instead. A concrete path
// would be worse still — the runtime path varies, so the emitted form is a by-name reference
// the agent can resolve. Excludes `~/.agents/skills/...`, where `skills/` is not path-initial.
// Declared up here, not next to its user below: a const accessed from a function invoked by the
// top-level flow would still be in the TDZ.
const SKILL_RELATIVE_PATH = /(^|[^/\w.~])skills\/[a-z0-9][a-z0-9-]*\//im;

// English tracker-mode fixture used by the self-check's second stage. Declared before
// the top-level flow below — const initializers would still be in the TDZ otherwise.
const ENGLISH_AGENTS_MD = `# AGENTS.md

Project harness for reliable agent-assisted development.

## Startup workflow

Before writing code:

1. Read this file in full
2. Read \`CONTEXT.md\` for domain vocabulary and recent ADRs in \`docs/adr/\`
3. Run \`./init.sh\` to verify the environment
4. Read any handoff doc under \`.scratch/\` if one exists
5. Check the issue tracker for ticket status and blocking edges

## Working rules

- One feature at a time: pick exactly one unfinished ticket
- Dependencies are explicit: blocking edges are declared on tickets
- Stay in scope: do not touch files unrelated to the current ticket
- Decisions go to ADRs in \`docs/adr/\`, not into progress logs
- Task materials live in \`.scratch/\` and are deleted when the task is done

## Definition of done

- [ ] Behavior implemented
- [ ] Verification commands actually ran (tests, type checks)
- [ ] Evidence recorded as a CI run link or command output summary
- [ ] Repo restarts cleanly from \`./init.sh\`

## Verification commands

- \`npm test\`
- \`npm run build\`

## End of session

1. Write a reference-style handoff under \`.scratch/\` (any filename): goal, current status, recommended next step; reference specs, ADRs and commits by path, never copy their content
2. Record unresolved risks or blockers
3. Commit with a descriptive message and leave the repo clean
`;

const ENGLISH_CONTEXT_MD = `# CONTEXT

## Glossary

- **Ticket**: the smallest unit of work in the issue tracker, declaring its blocking edges.
- **Spec**: requirements published to the issue tracker via to-spec.

## State convention

Ticket status and dependencies live in the issue tracker; the repo keeps no feature_list.json.
`;

const ENGLISH_ADR_MD = `# ADR 0001: Adopt tracker mode

The issue tracker is the source of truth for state. Long-lived repo assets are
CONTEXT.md and this ADR directory only.
`;

const ENGLISH_HANDOFF_MD = `# Session handoff

## Goal

Implement ticket #12 (blocked by #9).

## Current status

Verification passed; evidence is the CI run linked from ticket #12.

## Blockers / risks

None.

## Next steps

1. Continue with the second tracer bullet of ticket #12.
`;

const args = parseArgs(process.argv.slice(2));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDir, '..');

if (args.help) {
  console.log(`Usage: ${scriptCommand('run-benchmark.mjs')} [--target DIR] [--output FILE] [--html FILE] [--no-self-check]

Runs a lightweight harness benchmark:
  1. Self-check: scaffold a throwaway harness and confirm it validates, then score an English
     tracker-mode fixture (proves the scripts work AND that scoring is bilingual).
  2. Scores the current target harness.
  3. Checks eval coverage in evals/evals.json.
  4. Checks the SKILL.md size budget (${SKILL_MD_MAX_BYTES} bytes, 150% of the ${SKILL_MD_BASELINE_BYTES}-byte baseline).
  5. Scores a tracker-mode scaffold and checks its emitted-artifact invariants: no skill-repo-relative
     path reaches a target repo, and no registry state file is emitted.
  6. Checks the mode gate: a signal-free target given no explicit --mode must refuse to write (exit 1,
     zero files), while an explicit --mode or a detected signal must still scaffold.
  7. Checks --dry-run: it must change nothing, plan real artifacts rather than recite a template
     list, and agree with the write that follows it.
  8. Checks the skill's own shipped files: no command it prints may use a script path that only
     resolves from the skill directory (the agent's cwd is the target repo).
  9. Checks the bottleneck headline: a tie must name every tied subsystem, a unique minimum must
     name one, and a complete harness must report none.
 10. Checks the blank-project gate: the placeholder verification step must exit non-zero, while a
     real command must still run — a gate that cannot fail is not a gate.
 11. Checks handoff recognition: a doc under .scratch/ is recognised by what it is, not by one
     filename, while a doc outside the landing points is ignored.
 12. Checks the blueprint slot: omitting --blueprint must leave a visible pending marker rather
     than stack-derived text, and a supplied blueprint must reach AGENTS.md verbatim.
 13. Checks the entry template: a fresh registry scaffold must not ship project-shaped feature
     entries, and must state the alignment rule before any entry may be added.
 14. Produces a JSON report and optional HTML report.

This is a structural benchmark, not an LLM judge. Use it before/after real agent sessions.`);
  process.exit(0);
}

const target = path.resolve(args.target || args._[0] || process.cwd());
const output = path.resolve(args.output || path.join(target, 'harness-benchmark.json'));
const evalPath = path.resolve(args.evals || path.join(skillRoot, 'evals', 'evals.json'));

const harnessResult = scoreHarness(await loadHarnessFiles(target));
const evals = await readJson(evalPath);
const evalResult = scoreEvals(evals);
const selfCheck = args.noSelfCheck ? { skipped: true } : await runSelfCheck();
const report = {
  generatedAt: new Date().toISOString(),
  target,
  selfCheck,
  harness: harnessResult,
  evals: evalResult,
  recommendation: recommend(harnessResult, evalResult)
};

await writeText(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Benchmark report written to ${output}`);
console.log('');
if (!selfCheck.skipped) {
  console.log(`Self-check: ${selfCheck.pass ? 'PASS' : 'FAIL'} — scaffolded harness scored ${selfCheck.score}/100, English tracker fixture scored ${selfCheck.englishScore ?? 0}/100`);
  if (selfCheck.budget) {
    const { size, max, pass, rawSize, crlfCount, lineEndingInvariant } = selfCheck.budget;
    console.log(`  SKILL.md budget: ${pass ? 'PASS' : 'FAIL'} — ${size}/${max} bytes LF-normalized (${max - size >= 0 ? `${max - size} left` : `${size - max} over`})${crlfCount ? `; checkout is CRLF (${crlfCount} lines → raw ${rawSize})` : ''}; line-ending invariant: ${lineEndingInvariant ? 'ok' : 'NO'}`);
  }
  if (selfCheck.tracker) {
    const { pass, score, offenders = [], leakedState = [], error } = selfCheck.tracker;
    console.log(`  Tracker scaffold: ${pass ? 'PASS' : 'FAIL'} — scored ${score}/100${offenders.length ? ` — skill-relative path in ${offenders.join(', ')}` : ''}${leakedState.length ? ` — registry state leaked into tracker mode: ${leakedState.join(', ')}` : ''}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.gate) {
    const { pass, refused, explicitOk, signalOk, wrote = [], error } = selfCheck.gate;
    console.log(`  Mode gate: ${pass ? 'PASS' : 'FAIL'} — signal-free with no --mode refused: ${refused ? 'yes' : 'NO'}${wrote.length ? ` (but still wrote: ${wrote.join(', ')})` : ''}; explicit --mode registry: ${explicitOk ? 'ok' : 'NO'}; CONTEXT.md signal: ${signalOk ? 'ok' : 'NO'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.dryRun) {
    const { pass, changesNothing, previewedFiles, reflectsState, planMatchesRun, wrote = [], error } = selfCheck.dryRun;
    console.log(`  Dry run: ${pass ? 'PASS' : 'FAIL'} — writes nothing: ${changesNothing ? 'ok' : `NO (still wrote ${wrote.join(', ') || 'files'})`}; plans artifacts: ${previewedFiles ? 'ok' : 'NO'}; reflects existing state: ${reflectsState ? 'ok' : 'NO'}; plan matches the real run: ${planMatchesRun ? 'ok' : 'NO'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.selfRefs) {
    const { pass, offenders = [], checked, error } = selfCheck.selfRefs;
    console.log(`  Self-reference paths: ${pass ? 'PASS' : 'FAIL'} — ${checked} shipped file(s) checked${offenders.length ? `; relative script path in ${offenders.join(', ')}` : ''}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.bottleneckTies) {
    const { pass, tieCount, uniqueCount, noneCount, tieLabel } = selfCheck.bottleneckTies;
    console.log(`  Bottleneck ties: ${pass ? 'PASS' : 'FAIL'} — 5-way tie names all 5: ${tieCount === 5 ? 'ok' : `NO (${tieCount})`}; unique minimum names one: ${uniqueCount === 1 ? 'ok' : `NO (${uniqueCount})`}; complete harness reports none: ${noneCount === 0 ? 'ok' : `NO (${noneCount})`} — ${tieLabel}`);
  }
  if (selfCheck.blankGate) {
    const { pass, placeholderFails, realRuns } = selfCheck.blankGate;
    console.log(`  Blank-project gate: ${pass ? 'PASS' : 'FAIL'} — placeholder verification exits non-zero: ${placeholderFails ? 'ok' : 'NO'}; a real command still runs: ${realRuns ? 'ok' : 'NO'}`);
  }
  if (selfCheck.handoff) {
    const { pass, recognized, strayIgnored, error } = selfCheck.handoff;
    console.log(`  Handoff recognition: ${pass ? 'PASS' : 'FAIL'} — timestamped doc under .scratch/ recognised: ${recognized ? 'ok' : 'NO'}; doc outside the landing points ignored: ${strayIgnored ? 'ok' : 'NO'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.blueprint) {
    const { pass, pendingMarked, noInventedFill, verbatim, error } = selfCheck.blueprint;
    console.log(`  Blueprint slot: ${pass ? 'PASS' : 'FAIL'} — omitted --blueprint stays a pending marker: ${pendingMarked ? 'ok' : 'NO'}; no stack-derived fill: ${noInventedFill ? 'ok' : 'NO'}; supplied blueprint reaches AGENTS.md verbatim: ${verbatim ? 'ok' : 'NO'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.entries) {
    const { pass, count, atMostExample, alignmentRuleStated, error } = selfCheck.entries;
    console.log(`  Entry restraint: ${pass ? 'PASS' : 'FAIL'} — no project-shaped entries at scaffold time (${count} entry/entries): ${atMostExample ? 'ok' : 'NO'}; alignment rule stated in feature_list.json and AGENTS.md: ${alignmentRuleStated ? 'ok' : 'NO'}${error ? ` — ${error}` : ''}`);
  }
  if (!selfCheck.pass && selfCheck.error) console.log(`  ${selfCheck.error}`);
}
console.log(formatScoreReport(harnessResult, target));
console.log(`Eval coverage: ${evalResult.score}/100 (${evalResult.passed}/${evalResult.total})`);
console.log(`Recommendation: ${report.recommendation}`);

if (args.html) {
  const htmlPath = path.resolve(args.html);
  await writeText(htmlPath, renderBenchmarkHtml(report));
  console.log(`HTML benchmark report written to ${htmlPath}`);
}

if (
  harnessResult.overall < Number(args.minScore || 70) ||
  evalResult.score < Number(args.minEvalScore || 80) ||
  selfCheck.pass === false
) {
  process.exitCode = 1;
}

// Prove the bundled scripts actually work end-to-end: scaffold a harness into a throwaway
// directory, then score it. A structural eval-coverage check can't catch a broken
// create-harness.mjs — this can. Failure here means the skill ships broken, not just thin.
// The second stage guards bilingual scoring: upstream toolchains
// produce English artifacts, so an English tracker-mode harness must
// score just as well as the Chinese registry-mode scaffold. The third stage keeps the skill's
// own instruction file inside its size budget, the next keeps every command the skill prints
// runnable from the target repo (the failure that silently disabled the mode gate), and the last
// keeps the audit's headline from asserting a ranking the scores do not support.
async function runSelfCheck() {
  let dir;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), 'harness-selfcheck-'));
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'selfcheck', scripts: { check: 'tsc', test: 'vitest run', build: 'vite build' } })
    );
    // --mode is explicit here on purpose: this fixture is signal-free, which is exactly the case the
    // mode gate refuses. Before that gate existed this call was the bypass's own regression test —
    // it scaffolded registry on a bare directory and called it a pass. The gate is asserted
    // separately by checkModeGate().
    await execFileAsync('node', [path.join(scriptDir, 'create-harness.mjs'), '--target', dir, '--mode', 'registry']);
    const scored = scoreHarness(await loadHarnessFiles(dir));
    const english = await scoreEnglishTrackerFixture(dir);
    const budget = await checkSkillBudget();
    const minScore = Number(args.minSelfCheckScore || 90);
    const tracker = await checkTrackerScaffold(minScore);
    const gate = await checkModeGate();
    const dryRun = await checkDryRun();
    const selfRefs = await checkSelfReferencePaths();
    const bottleneckTies = await checkBottleneckTies();
    const blankGate = await checkBlankProjectGate();
    const handoff = await checkHandoffRecognition();
    const blueprint = await checkBlueprintSlot();
    const entries = await checkEntryTemplateRestraint();
    return {
      pass: scored.overall >= minScore && english.overall >= minScore && budget.pass && tracker.pass && gate.pass && dryRun.pass && selfRefs.pass && bottleneckTies.pass && blankGate.pass && handoff.pass && blueprint.pass && entries.pass,
      score: scored.overall,
      englishScore: english.overall,
      budget,
      tracker,
      gate,
      dryRun,
      selfRefs,
      bottleneckTies,
      blankGate,
      handoff,
      blueprint,
      entries,
      bottleneck: scored.bottleneck ?? english.bottleneck,
      bottlenecks: scored.bottlenecks.length ? scored.bottlenecks : english.bottlenecks
    };
  } catch (error) {
    return { pass: false, score: 0, error: error.message };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

// The budget measures content, not checkout artifacts. git stores LF, but with core.autocrlf=true
// the file is checked out as CRLF, so the same commit measures one extra byte per line. A cap that
// flips with line endings is a cap with a platform-shaped hole: a Windows contributor would be
// forced to delete real content to satisfy an artifact of their checkout, while the identical
// content passes on Linux/macOS. Size is therefore measured LF-normalized, and the invariant is
// asserted (not assumed) so that a revert to raw bytes fails loudly instead of silently.
async function checkSkillBudget() {
  const raw = await readText(path.join(skillRoot, 'SKILL.md'));
  const size = Buffer.byteLength(raw.replace(/\r\n/g, '\n'), 'utf8');
  const rawSize = Buffer.byteLength(raw, 'utf8');
  const crlfCount = (raw.match(/\r\n/g) || []).length;
  // Holds only when the reported size differs from the raw size by exactly the CRLF overhead —
  // i.e. normalization happened and no other byte was dropped along the way.
  const lineEndingInvariant = rawSize - size === crlfCount;
  return {
    pass: size <= SKILL_MD_MAX_BYTES && lineEndingInvariant,
    size,
    max: SKILL_MD_MAX_BYTES,
    rawSize,
    crlfCount,
    lineEndingInvariant
  };
}

// The skill's own shipped files are checked here too. Every command it prints has to be runnable
// from where the agent actually stands: the scripts live under the runtime's skills directory, but
// the agent's cwd is the target repo — so a printed `node scripts/<name>.mjs` dies with MODULE_NOT_FOUND,
// and the gate the agent was told to run silently never runs. That is how the mode gate got
// bypassed in practice, so the rule gets a machine check instead of another sentence. README.md is
// exempt on purpose: one of its two blocks is the contributor's "from the repo root" invocation,
// where the relative form is correct.
async function checkSelfReferencePaths() {
  const collect = async (dir, prefix, keep) => (await readdir(path.join(skillRoot, dir), { withFileTypes: true }))
    .filter((entry) => entry.isFile() && keep(entry.name))
    .map((entry) => `${prefix}${entry.name}`);
  const files = [
    'SKILL.md',
    ...await collect('references', 'references/', (name) => name.endsWith('.md')),
    ...await collect('scripts', 'scripts/', (name) => name.endsWith('.mjs')),
    ...await collect('scripts/lib', 'scripts/lib/', (name) => name.endsWith('.mjs')),
    ...await collect('templates', 'templates/', () => true)
  ];
  const offenders = [];
  let checked = 0;
  for (const file of files) {
    if (SELFTEXT_EXEMPT.has(file)) continue;
    checked += 1;
    const text = await readText(path.join(skillRoot, file));
    if (RELATIVE_SELF_REFERENCE.test(text)) offenders.push(file);
  }
  return { pass: offenders.length === 0, offenders, checked };
}

// Stage four: the tracker-mode template is a separate rendering path from the registry scaffold
// above — different repo-layout block, different state vocabulary, no registry artifacts — so it is
// generated and scored here instead of assumed. Two invariants ride along: the generator must not
// emit skill-repo-relative paths into a target repo (a `skills/` path is dead there — the skill
// lives in the runtime's skills directory), and tracker mode must not emit registry state files,
// which would create a second state source. The path defect class already regressed once, so it
// gets a mechanical carrier rather than a convention — the same reason the SKILL.md byte cap above
// is enforced here instead of recorded as a note.
async function checkTrackerScaffold(minScore) {
  let dir;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), 'harness-tracker-'));
    await execFileAsync('node', [path.join(scriptDir, 'create-harness.mjs'), '--target', dir, '--mode', 'tracker']);
    const emitted = await loadHarnessFiles(dir);
    const offenders = emitted.filter(({ content }) => SKILL_RELATIVE_PATH.test(content)).map(({ path: file }) => file);
    const leakedState = emitted
      .map(({ path: file }) => file)
      .filter((file) => ['feature_list.json', 'feature-list.json', 'progress.md'].includes(file));
    const score = scoreHarness(emitted).overall;
    return { pass: offenders.length === 0 && leakedState.length === 0 && score >= minScore, score, offenders, leakedState };
  } catch (error) {
    return { pass: false, score: 0, offenders: [], leakedState: [], error: error.message };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

// Stage five: the mode gate. The design says a repo with no mode signal must not get a silent
// default — the mode is a decision the agent has to obtain from the user. That rule used to be
// prose-only, and it lost every live test: agents scaffolded registry into bare directories and
// moved on, because a successful write beats an instruction every time. So the gate became
// mechanical (create-harness.mjs refuses to write when nothing can be inferred) and is asserted
// here. Both failure directions matter equally: the signal-free case must NOT write, and the two
// legitimate paths must NOT become collateral damage — a gate that blocks everything would sail
// through a naive "did it refuse?" check.
async function checkModeGate() {
  let blank;
  let signal;
  try {
    blank = await mkdtemp(path.join(os.tmpdir(), 'harness-gate-blank-'));
    signal = await mkdtemp(path.join(os.tmpdir(), 'harness-gate-signal-'));

    // 1. Signal-free with no --mode must refuse. execFile rejects on non-zero exit, so triggering
    //    that rejection IS the assertion; catching it is the check, not an error path.
    let refused = false;
    try {
      await execFileAsync('node', [path.join(scriptDir, 'create-harness.mjs'), '--target', blank]);
    } catch (error) {
      refused = error.code === 1;
    }
    const wrote = await listDir(blank);

    // 2. An explicit --mode registry on that same signal-free directory must still scaffold.
    await execFileAsync('node', [path.join(scriptDir, 'create-harness.mjs'), '--target', blank, '--mode', 'registry']);
    const explicitFiles = await listDir(blank);
    const explicitOk = explicitFiles.includes('AGENTS.md') && explicitFiles.includes('feature_list.json');

    // 3. A detected signal must still infer the mode with no --mode — and infer tracker, not
    //    registry: landing here with a feature registry would be a second state source.
    await writeText(path.join(signal, 'CONTEXT.md'), '# Context\n');
    await execFileAsync('node', [path.join(scriptDir, 'create-harness.mjs'), '--target', signal]);
    const signalFiles = await listDir(signal);
    const signalOk = signalFiles.includes('AGENTS.md') && !signalFiles.includes('feature_list.json');

    return {
      pass: refused && wrote.length === 0 && explicitOk && signalOk,
      refused,
      explicitOk,
      signalOk,
      wrote
    };
  } catch (error) {
    return { pass: false, refused: false, explicitOk: false, signalOk: false, wrote: [], error: error.message };
  } finally {
    for (const dir of [blank, signal]) if (dir) await rm(dir, { recursive: true, force: true });
  }
}

// A raw listing rather than loadHarnessFiles: the gate's claim is "no files were written", and a
// known-name list would silently miss anything unexpected that did get written. A missing directory
// is itself the strongest pass — it means even mkdir never ran.
async function listDir(dir) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

// Stage six: --dry-run. SKILL.md's pre-write CHECKPOINT asks the agent to show the artifact list
// and get approval *before* anything is written; the generator used to write as it went and print
// the list afterwards, so that gate was unsatisfiable — the prose demanded an order the tool could
// not produce. --dry-run supplies the missing order. A preview can fail in three independent ways,
// so all three are asserted: it can write anyway, it can recite a static template list that ignores
// the target's real state, or it can disagree with the run it previews.
async function checkDryRun() {
  let dir;
  let pair;
  try {
    const script = path.join(scriptDir, 'create-harness.mjs');
    const capture = async (extra) => (await execFileAsync('node', [script, ...extra])).stdout;
    const planLines = (out) => out.split('\n').filter((line) => /^(WRITTEN|SKIPPED) /.test(line)).sort().join('\n');

    // 1. A preview on an empty target must change nothing — not even the target directory itself.
    dir = await mkdtemp(path.join(os.tmpdir(), 'harness-dryrun-'));
    const preview = await capture(['--target', dir, '--mode', 'registry', '--dry-run']);
    const wrote = await listDir(dir);
    const changesNothing = wrote.length === 0;
    const previewedFiles = /^WRITTEN /m.test(preview);

    // 2. The preview is a plan, not a recital. After a real run every artifact exists, so the next
    //    preview must report SKIPPED — a static list would still claim WRITTEN here.
    await execFileAsync('node', [script, '--target', dir, '--mode', 'registry']);
    const second = await capture(['--target', dir, '--mode', 'registry', '--dry-run']);
    const reflectsState = /^SKIPPED /m.test(second) && !/^WRITTEN /m.test(second);

    // 3. The plan must equal the run it previews, or the user approves a different action than the
    //    one that executes. Both runs target the same fresh directory, so the comparison is exact.
    pair = await mkdtemp(path.join(os.tmpdir(), 'harness-dryrun-pair-'));
    const plan = await capture(['--target', pair, '--mode', 'registry', '--dry-run']);
    const real = await capture(['--target', pair, '--mode', 'registry']);
    const planMatchesRun = planLines(plan) === planLines(real) && planLines(plan).length > 0;

    return {
      pass: changesNothing && previewedFiles && reflectsState && planMatchesRun,
      changesNothing,
      previewedFiles,
      reflectsState,
      planMatchesRun,
      wrote
    };
  } catch (error) {
    return { pass: false, changesNothing: false, previewedFiles: false, reflectsState: false, planMatchesRun: false, wrote: [], error: error.message };
  } finally {
    for (const target of [dir, pair]) if (target) await rm(target, { recursive: true, force: true });
  }
}

// Convert the scaffold in-place to an English tracker-mode harness: state lives in the
// issue tracker, long-lived assets are CONTEXT.md + ADRs, and the handoff is a
// reference-style doc in .scratch/. No feature_list.json, no progress.md.
async function scoreEnglishTrackerFixture(dir) {
  await rm(path.join(dir, 'feature_list.json'));
  await rm(path.join(dir, 'progress.md'));
  await writeText(path.join(dir, 'AGENTS.md'), ENGLISH_AGENTS_MD);
  await writeText(path.join(dir, 'CONTEXT.md'), ENGLISH_CONTEXT_MD);
  await writeText(path.join(dir, 'docs', 'adr', '0001-tracker-mode.md'), ENGLISH_ADR_MD);
  await writeText(path.join(dir, '.scratch', 'handoff.md'), ENGLISH_HANDOFF_MD);
  return scoreHarness(await loadHarnessFiles(dir));
}

function scoreEvals(evalsJson) {
  const cases = Array.isArray(evalsJson.evals) ? evalsJson.evals : [];
  const checks = [];
  checks.push({ pass: cases.length >= 10, message: 'At least 10 eval cases' });
  checks.push({ pass: cases.some((item) => /minimal|creation|最小化|创建/i.test(item.name)), message: 'Covers minimal harness creation' });
  checks.push({ pass: cases.some((item) => /session|continuity|会话|连续/i.test(item.name)), message: 'Covers session continuity' });
  checks.push({ pass: cases.some((item) => /assessment|score|评估|得分/i.test(item.name)), message: 'Covers harness assessment' });
  checks.push({ pass: cases.some((item) => /verification|验证/i.test(item.name)), message: 'Covers verification workflow' });
  checks.push({ pass: cases.some((item) => /memory|记忆/i.test(item.name)), message: 'Covers memory taxonomy' });
  checks.push({ pass: cases.some((item) => /tool|permission|safety|工具|权限|安全/i.test(item.name)), message: 'Covers tool safety' });
  checks.push({ pass: cases.some((item) => /multi-agent|delegation|coordination|多代理|协调|委派/i.test(item.name)), message: 'Covers multi-agent coordination' });
  checks.push({ pass: cases.every((item) => item.prompt && item.expected_output && Array.isArray(item.expectations)), message: 'Each eval has prompt, expected output, expectations' });
  checks.push({ pass: cases.every((item) => item.expectations?.length >= 3), message: 'Each eval has at least three expectation checks' });

  const passed = checks.filter((check) => check.pass).length;
  return {
    score: Math.round((passed / checks.length) * 100),
    passed,
    total: checks.length,
    cases: cases.length,
    checks
  };
}

// The audit's headline is a single "Bottleneck" line, and the recommendation repeats it, so that
// line has to reflect what the scores support. Reporting one member of a tie presents an arbitrary
// pick as a diagnosis: the code comment claimed uniqueness while the guard only checked "not full
// marks", so a four-way tie at 1/5 printed a single subsystem and pointed the user at it. That is
// the audit's most-quoted output giving a confident wrong answer, so it is asserted here instead
// of left to the comment.
async function checkBottleneckTies() {
  const full = { instructions: { score: 5 }, state: { score: 5 }, verification: { score: 5 }, scope: { score: 5 }, lifecycle: { score: 5 } };
  const tied = { instructions: { score: 1 }, state: { score: 1 }, verification: { score: 1 }, scope: { score: 1 }, lifecycle: { score: 1 } };
  const unique = { instructions: { score: 2 }, state: { score: 1 }, verification: { score: 3 } };
  const noneList = pickBottlenecks(full);
  const tieList = pickBottlenecks(tied);
  const uniqueList = pickBottlenecks(unique);
  const tieLabel = bottleneckLabel({ bottlenecks: tieList, subsystems: tied });
  const uniqueLabel = bottleneckLabel({ bottlenecks: uniqueList, subsystems: unique });
  const noneLabel = bottleneckLabel({ bottlenecks: noneList, subsystems: full });
  // Three cases, each with a distinct failure: a tie must name every tied subsystem (naming one is
  // the old defect), a unique minimum must still name exactly that one, and a complete harness must
  // report nothing to fix rather than the first subsystem in the list.
  const tieNamesAll = tieList.length === 5 && ['instructions', 'lifecycle'].every((name) => tieLabel.includes(name));
  const uniqueNamesOne = uniqueList.length === 1 && uniqueList[0] === 'state' && uniqueLabel === 'state';
  const noneStaysQuiet = noneList.length === 0 && /none/.test(noneLabel);
  return {
    pass: tieNamesAll && uniqueNamesOne && noneStaysQuiet,
    tieCount: tieList.length,
    uniqueCount: uniqueList.length,
    noneCount: noneList.length,
    tieLabel
  };
}

// Stage nine: a blank repo must not ship a gate that cannot fail. When no package manifest is
// detected the generator has nothing to verify, so it emits a placeholder step. Executing that
// placeholder as a plain echo exited 0, which made ./init.sh report success on a repo where
// nothing had been verified — and "no feature may be marked done without evidence" became
// structurally unreachable on a blank project. The placeholder now exits non-zero, so the gate
// opens exactly when it is replaced. Two directions are asserted, because "always exits 1" would
// be a different defect wearing the same fix: the placeholder must fail, and a real command must
// still pass. The probe hands in the generator's own sentence, so this code cannot pass by
// agreeing with a copy of the string it is meant to verify.
async function checkBlankProjectGate() {
  const placeholder = 'echo "No package manifest detected; replace this line with your project verification command."';
  const blank = renderVerificationStep(placeholder);
  const real = renderVerificationStep('go test ./...');
  const placeholderFails = /\bexit 1\b/.test(blank) && !/^\s*go test/m.test(blank);
  // The real command must render as something that runs, not as the refusal branch.
  const realRuns = !/\bexit 1\b/.test(real) && real.includes('go test ./...');
  return {
    pass: placeholderFails && realRuns,
    placeholderFails,
    realRuns
  };
}

// Stage ten: the handoff is identified by what it is, not by one hardcoded filename. Scaffolding
// writes `.scratch/handoff.md`, but the doc is produced later at the user's request and may be
// timestamped — upstream's own handoff skill timestamps it. If recognition keyed on the exact
// name, a repo holding a perfectly good handoff would score as having none and the startup
// checklist would never read it. Landing point stays enforced: only `.scratch/` is scanned.
async function checkHandoffRecognition() {
  let dir;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), 'harness-handoff-'));
    await mkdir(path.join(dir, '.scratch'), { recursive: true });
    await writeText(path.join(dir, '.scratch', 'handoff-20260101-000000.md'), '# Handoff\n');
    const loaded = await loadHarnessFiles(dir);
    const recognized = loaded.some(({ path: file }) => file === '.scratch/handoff-20260101-000000.md');
    // A stray doc outside the landing points must NOT be picked up: the five-landing-point rule is
    // the reason the check reads .scratch/ only, and widening it would quietly legitimise docs/.
    await writeText(path.join(dir, 'handoff-at-root.md'), '# Handoff\n');
    const afterStray = await loadHarnessFiles(dir);
    const strayIgnored = !afterStray.some(({ path: file }) => file === 'handoff-at-root.md');
    return { pass: recognized && strayIgnored, recognized, strayIgnored };
  } catch (error) {
    return { pass: false, recognized: false, strayIgnored: false, error: error.message };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

// Stage eleven: the blueprint slot. AGENTS.md's one place that answers "what is this project"
// used to be assembled from the detected stack, so a repo could ship a filled-in-looking blueprint
// that carried no project fact at all — and an agent holding a project-shaped blank went on to
// write feature entries nobody had agreed to. The slot is now fed by the user's own statement
// (--blueprint) or stays a visible pending marker. Both directions are asserted, because each
// failure is a different defect: an omitted --blueprint must NOT be papered over with invented
// text, and a supplied one must reach the file verbatim rather than being replaced or dropped.
// The probe asks for the marker by its own keyword, so this cannot pass by agreeing with a copy
// of a string it is meant to verify.
async function checkBlueprintSlot() {
  let dir;
  let supplied;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), 'harness-blueprint-'));
    const script = path.join(scriptDir, 'create-harness.mjs');
    const blueprint = 'Probe project: delivers one thing the probe names itself.';

    await execFileAsync('node', [script, '--target', dir, '--mode', 'registry']);
    const omitted = await readText(path.join(dir, 'AGENTS.md'));
    // Pending must be explicit and must not smuggle in stack-derived boilerplate.
    const pendingMarked = omitted.includes('待补');
    const noInventedFill = !/agent-assisted development/i.test(omitted);

    supplied = await mkdtemp(path.join(os.tmpdir(), 'harness-blueprint-set-'));
    await execFileAsync('node', [script, '--target', supplied, '--mode', 'registry', '--blueprint', blueprint]);
    const verbatim = (await readText(path.join(supplied, 'AGENTS.md'))).includes(blueprint);

    return {
      pass: pendingMarked && noInventedFill && verbatim,
      pendingMarked,
      noInventedFill,
      verbatim
    };
  } catch (error) {
    return { pass: false, pendingMarked: false, noInventedFill: false, verbatim: false, error: error.message };
  } finally {
    for (const target of [dir, supplied]) if (target) await rm(target, { recursive: true, force: true });
  }
}

// Stage twelve: the entry template must not pre-load project-shaped work. The scaffold used to
// ship five entries named like a plausible delivery path (first user-facing feature, verification
// coverage, docs, cleanup), and a scaffolded repo therefore started life looking like five agreed
// tasks had already been decided — which is how unaligned requirements became "entries". Nothing
// caught it: the old template scored 100/100, because every check asked for shape, never for
// emptiness. Two directions: the scaffold must carry no project-specific entry beyond the
// structural example, and the alignment rule must be present so the boundary is stated where the
// agent actually reads it.
async function checkEntryTemplateRestraint() {
  let dir;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), 'harness-entries-'));
    await execFileAsync('node', [path.join(scriptDir, 'create-harness.mjs'), '--target', dir, '--mode', 'registry']);
    const raw = await readText(path.join(dir, 'feature_list.json'));
    const parsed = JSON.parse(raw);
    const entries = Array.isArray(parsed.features) ? parsed.features : [];
    // The structural example is allowed; a third entry, or a name that reads like a delivery
    // milestone rather than a placeholder, is the defect this stage exists for.
    const atMostExample = entries.length <= 2;
    const namesArePlaceholders = entries.every((entry) => /项目初始化|示例/.test(entry.name));
    const alignmentRuleStated = /对齐/.test(raw);
    const agentsHasRule = /对齐/.test(await readText(path.join(dir, 'AGENTS.md')));
    return {
      pass: atMostExample && namesArePlaceholders && alignmentRuleStated && agentsHasRule,
      count: entries.length,
      atMostExample,
      namesArePlaceholders,
      alignmentRuleStated,
      agentsHasRule
    };
  } catch (error) {
    return { pass: false, count: 0, atMostExample: false, namesArePlaceholders: false, alignmentRuleStated: false, agentsHasRule: false, error: error.message };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

function recommend(harnessResult, evalResult) {  if (harnessResult.overall >= 85 && evalResult.score >= 90) {
    return 'Ready for realistic before/after agent-session benchmarking.';
  }
  if (harnessResult.overall < 70) {
    const names = harnessResult.bottlenecks?.length
      ? harnessResult.bottlenecks
      : [harnessResult.bottleneck].filter(Boolean);
    if (names.length === 0) {
      return 'Scored below the usable threshold without a single weakest subsystem; work the per-check failures above in order.';
    }
    return `Improve the ${names.join(' / ')} subsystem${names.length > 1 ? 's' : ''} before benchmarking agent behavior.`;
  }
  if (evalResult.score < 80) {
    return 'Expand eval coverage before treating benchmark results as representative.';
  }
  return 'Usable, with some gaps worth tightening after first real sessions.';
}

function renderBenchmarkHtml(report) {
  const budgetLine = report.selfCheck?.budget
    ? ` SKILL.md sits at ${report.selfCheck.budget.size}/${report.selfCheck.budget.max} bytes (${report.selfCheck.budget.pass ? 'within' : 'OVER'} budget).`
    : '';
  // The new stage has to surface in the shareable report too. A check whose result never reaches
  // the artifact people actually read is half a carrier: the gate would pass in the console and
  // be invisible where the round gets reviewed later.
  const selfRefLine = report.selfCheck?.selfRefs
    ? ` ${report.selfCheck.selfRefs.checked} shipped file(s) checked for command reachability from a target repo (${report.selfCheck.selfRefs.pass ? 'all runnable' : `relative self-reference in ${(report.selfCheck.selfRefs.offenders || []).join(', ')}`}).`
    : '';
  // Same reasoning as the self-reference line above: the tie guard decides what the audit's
  // headline is allowed to claim, so its own result belongs in the artifact people review later.
  const bottleneckTieLine = report.selfCheck?.bottleneckTies
    ? ` The bottleneck line names ${report.selfCheck.bottleneckTies.tieCount} tied subsystem(s) as a tie instead of picking one (${report.selfCheck.bottleneckTies.pass ? 'verified' : 'FAILED'}).`
    : '';
  const blankGateLine = report.selfCheck?.blankGate
    ? ` On a project with no detectable stack, the placeholder verification step exits non-zero rather than reporting a pass it did not earn (${report.selfCheck.blankGate.pass ? 'verified' : 'FAILED'}).`
    : '';
  const handoffLine = report.selfCheck?.handoff
    ? ` A handoff doc under .scratch/ is recognised regardless of filename, while one outside the landing points is ignored (${report.selfCheck.handoff.pass ? 'verified' : 'FAILED'}).`
    : '';
  // The blueprint slot decides whether AGENTS.md can claim project facts nobody supplied, so its
  // result belongs in the artifact people actually review — same reasoning as the lines above.
  const blueprintLine = report.selfCheck?.blueprint
    ? ` The project-blueprint slot stays a visible pending marker when the user has not stated one, rather than being filled from the detected stack (${report.selfCheck.blueprint.pass ? 'verified' : 'FAILED'}).`
    : '';
  // The entry template decides what a fresh harness already claims, so its restraint is reported too.
  const entryLine = report.selfCheck?.entries
    ? ` A freshly scaffolded registry ships no project-shaped feature entries, and states the alignment rule before any entry may be added (${report.selfCheck.entries.pass ? 'verified' : 'FAILED'}).`
    : '';
  const selfCheckSection = report.selfCheck?.skipped
    ? ''
    : `<section>
      <h2>Script Self-Check <span>${report.selfCheck.pass ? 'PASS' : 'FAIL'}</span></h2>
      <p>Scaffolded a throwaway harness and scored it ${report.selfCheck.score}/100, plus an English tracker-mode fixture at ${report.selfCheck.englishScore ?? 0}/100 — confirms the bundled scripts run end-to-end and scoring is bilingual.${budgetLine}${selfRefLine}${bottleneckTieLine}${blankGateLine}${handoffLine}${blueprintLine}${entryLine}${report.selfCheck.error ? ` Error: ${escapeHtml(report.selfCheck.error)}` : ''}</p>
    </section>`;
  const evalHtml = htmlReport(report.harness, `Harness Benchmark: ${path.basename(report.target)}`)
    .replace('</main>', `${selfCheckSection}<section>
      <h2>Eval Coverage <span>${report.evals.score}/100</span></h2>
      <p>${report.evals.passed}/${report.evals.total} benchmark checks passed across ${report.evals.cases} eval cases.</p>
      <ul>${report.evals.checks.map((check) => `<li class="${check.pass ? 'pass' : 'fail'}">${check.pass ? 'PASS' : 'FAIL'} ${escapeHtml(check.message)}</li>`).join('')}</ul>
    </section>
    <section>
      <h2>Recommendation</h2>
      <p>${escapeHtml(report.recommendation)}</p>
    </section>
  </main>`);
  return evalHtml;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
