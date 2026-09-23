#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  bottleneckLabel,
  exists,
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
  verificationCommands,
  writeText
} from './lib/harness-utils.mjs';

const execFileAsync = promisify(execFile);

// The root instruction file must stay short enough to actually be read and followed, and the cap
// is enforced here rather than recorded only as a convention — a constraint with no mechanical
// carrier is the thing this skill tells everyone else to fix.
//
// The baseline moved once, deliberately, and the multiplier was tightened at the same time: the
// file had grown past the old 150%-of-7889 ceiling while gaining a capability family that has since
// been removed again, and three independent judges confirmed that the phrase-by-phrase compression
// paying for it had deleted real content. Rather than keep trading content for bytes, the baseline
// is the previous stable SKILL.md and the allowance drops from 150% to 15% — the same multiplier the
// generated AGENTS.md gets. Net effect: less headroom in absolute terms than re-interpreting the
// old 150% against the new baseline would have given, so the ratchet keeps biting.
//
// The baseline moved a second time, in the only direction that does not need the user: DOWN. The
// scope reduction that removed the two governance modes, the five landing points, the extracted
// agent-doc layer, git-tracking alignment and housekeeping took SKILL.md from 11801 to 9623 bytes.
// Leaving the baseline where it was would have handed the deleted doctrine a 3.9 KB runway to grow
// back into — the reduction would be undone by the next edit that "just adds one section back".
// Lowering a cap is enforcement of a reduction already agreed; RAISING it is a scope decision for
// the user, and so is widening this multiplier. The external comparison, for the record: upstream's
// SKILL.md is 5188 bytes, and a Chinese rendering costs roughly 1.3x more bytes at an equal token
// count, so 9623 is about 1.4x the upstream-equivalent — the difference is the boundary section,
// the counterexample blacklist and the edge-case table, none of which upstream carries.
const SKILL_MD_BASELINE_BYTES = 9623;
const SKILL_MD_MAX_BYTES = Math.floor(SKILL_MD_BASELINE_BYTES * 1.15);

// The generated instruction file gets the same treatment, for the same reason and with more at
// stake: it is the largest artifact this skill ships into every target repo, and it is read in
// full at every session start. Measured on a default render (no --blueprint, no --commands)
// because the cap must not depend on what a project happens to fill in.
//
// The anchor is EXTERNAL, not a ratchet around whatever this template currently renders at. The
// previous version set the baseline to the current render (8692 B) and the ceiling to 115% of it,
// which was two failures in one: it turned a 3.6x-oversized file into the compliant baseline, and
// it left no direction of travel except upward. A cap whose floor is the status quo can only ever
// ratify. It now anchors on the upstream reference template (2438 B, 68 lines, ~423 tokens) plus
// an allowance for CJK encoding — the same file costs roughly 1.3x more bytes in Chinese at an
// equal token count — and lines are capped on the lecture's own 50–200 guidance, which is
// language-neutral where bytes are not. Raising either number is a scope decision for the user,
// not a side effect of the template growing.
const AGENTS_MD_BASELINE_BYTES = 3200;
const AGENTS_MD_MAX_BYTES = Math.floor(AGENTS_MD_BASELINE_BYTES * 1.15);
const AGENTS_MD_MAX_LINES = 90;
// The template states this limit in its own self-restraint rule; the check keeps the statement
// honest, so a 9th rule has to displace something instead of just accumulating. Eight is the point
// where every remaining rule is a brake on the agent (stay in scope, verify before claiming done,
// do not invent entries, do not start work unasked) rather than an assignment of new work — which
// is what this skill is allowed to ship into someone else's repo.
const WORKING_RULES_MAX = 8;

// Content an instruction file must not restate, because the agent can read it from the repo
// itself: the tree, the stack, the scripts. Every external guide leads with this, and the failure
// is expensive — those lines are paid for at every session start. The stack rules key on the
// label-and-colon or heading shape, so a line that merely forbids touching the stack ("not product
// form: no UI, no interaction, no tech choices") is not a violation. Declared here, ahead of the
// runSelfCheck() call site: a const sitting next to the function that reads it is still in its
// temporal dead zone at that point.
const DISCOVERABLE_CONTENT = [
  { name: 'directory tree', pattern: /[├└]──/ },
  { name: 'stack listing', pattern: /^[|\-*].*(技术栈|技术选型|tech stack)\s*[:：]/im },
  { name: 'stack heading', pattern: /^#{2,3}\s*(技术栈|技术选型|tech stack)\s*$/im },
  { name: 'directory listing heading', pattern: /^#{2,3}\s*(目录结构|项目结构|directory structure|project structure)\s*$/im },
  { name: 'install or quickstart section', pattern: /^#{2,3}\s*(安装|installation|快速开始|quick ?start)\s*$/im }
];

// Every self-check group has to satisfy three things at once: it gets computed, it joins the pass
// conjunction, and it reaches the shareable HTML report. This list is the single source for all
// three, because the failure worth designing out is the fourth possibility — a gate that is added
// to the console and nowhere else. The report said as much already ("a check whose result never
// reaches the artifact people actually read is half a carrier"), and seven groups had drifted out
// of it. Declared here, ahead of the runSelfCheck() call site, for the temporal-dead-zone reason
// recorded above: a const sitting next to the function that reads it is still in its TDZ there.
const SELF_CHECK_GROUPS = [
  'budget', 'agentsBudget', 'agentsDiscover', 'scopeBrake', 'dryRun', 'selfRefs',
  'bottleneckTies', 'blankGate', 'blueprint', 'entries', 'agentFile'
];

// One sentence builder per group, keyed by the same names. The self-check asserts the two sets are
// equal in both directions, so a group without a line (console-only) and a line without a group
// (prose nothing backs) both fail instead of shipping. Each builder gets the group object and must
// return '' for a missing group.
const SELF_CHECK_REPORT_LINES = new Map([
  ['budget', (group) => ` SKILL.md sits at ${group.size}/${group.max} bytes (${group.pass ? 'within' : 'OVER'} budget).`],
  ['agentsBudget', (group) => ` The generated AGENTS.md stays inside its external byte, line and working-rule budgets (${group.pass ? 'verified' : 'FAILED'}).`],
  ['agentsDiscover', (group) => ` The instruction file does not restate what the agent can read for itself, and the detector is proven to have teeth by a seeded violation (${group.pass ? 'verified' : 'FAILED'}).`],
  ['scopeBrake', (group) => ` The generated instruction file states that the engineering workflow belongs to the engineering skills and carries none of the removed doctrine (${group.pass ? 'verified' : `leaked ${(group.leaked || []).join(', ') || 'none'}; brake ${group.brake ? 'present' : 'MISSING'}; detector ${group.seeded?.length ? 'has teeth' : 'BLIND'}`}).`],
  ['dryRun', (group) => ` --dry-run writes nothing, reports the target's real state, and its plan matches the live run entry for entry (${group.pass ? 'verified' : 'FAILED'}).`],
  ['selfRefs', (group) => ` ${group.checked} shipped file(s) checked for command reachability from a target repo (${group.pass ? 'all runnable' : `relative self-reference in ${(group.offenders || []).join(', ')}`}).`],
  ['bottleneckTies', (group) => ` The bottleneck line names ${group.tieCount} tied subsystem(s) as a tie instead of picking one (${group.pass ? 'verified' : 'FAILED'}).`],
  ['blankGate', (group) => ` A project with nothing to verify — no manifest, or a manifest with no runnable script — gets a placeholder step that exits non-zero instead of reporting a pass it did not earn (${group.pass ? 'verified' : 'FAILED'}).`],
  ['blueprint', (group) => ` The project-plain-description slot stays a visible pending marker when the user has not stated one, rather than being filled from the detected stack (${group.pass ? 'verified' : 'FAILED'}).`],
  ['entries', (group) => ` A freshly scaffolded harness ships no project-shaped feature entries, and states the alignment rule before any entry may be added (${group.pass ? 'verified' : 'FAILED'}).`],
  ['agentFile', (group) => ` An existing CLAUDE.md is reused instead of having AGENTS.md created beside it, and an existing instruction file is left byte-identical while its missing sections are still reported (${group.pass ? 'verified' : 'FAILED'}).`]
]);

// The single behavior this skill must not have. A harness that detected governance modes, assigned
// five landing points, routed ADRs and CONTEXT.md and handed out housekeeping duties did not merely
// describe a repo — it assigned the agent work that belongs to the engineering skills, and that
// assignment is exactly what collided with those skills over triggers. Two-sided on purpose: the
// brake must be present in the render, AND none of the removed doctrine may reappear in it. An
// assertion that only forbids is satisfied by an empty file; one that only requires is satisfied by
// a template that goes on to hand out work. The detector is also shown a seed that trips every
// pattern, because "found nothing" is worth nothing from a blind scanner.
//
// Declared up here, not next to checkScopeBoundary() below: a const read from a function invoked by
// the top-level flow is still in its temporal dead zone there, and the run died with exactly that
// error ("Cannot access 'FORBIDDEN_IN_AGENTS_MD' before initialization") the first time this check
// was added. Same trap the notes above record twice already.
const FORBIDDEN_IN_AGENTS_MD = [
  { name: 'ticket-system mode', pattern: /工单系统|issue tracker|ticket system/ },
  { name: 'ADR routing', pattern: /\bADR\b|docs\/adr/ },
  { name: 'domain-language file', pattern: /CONTEXT\.md/ },
  { name: 'scratch landing point', pattern: /\.scratch\// },
  { name: 'extracted agent docs', pattern: /docs\/agents\// },
  { name: 'landing-point doctrine', pattern: /落点/ },
  { name: 'tracking-policy section', pattern: /产物追踪策略/ }
];
const SEEDED_VIOLATION = '\n状态由工单系统承接；决策进 docs/adr/；术语进 CONTEXT.md；'
  + '材料入 .scratch/；详规落 docs/agents/；五落点；产物追踪策略。';

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





const args = parseArgs(process.argv.slice(2));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDir, '..');

if (args.help) {
  console.log(`Usage: ${scriptCommand('run-benchmark.mjs')} [--target DIR] [--output FILE] [--html FILE] [--no-self-check]

Runs a lightweight harness benchmark:
  1. Self-check: scaffold a throwaway harness into a temp directory and confirm it validates. This
     is the only check that proves the bundled scripts work end-to-end rather than being present.
  2. Scores the current target harness.
  3. Checks eval coverage in evals/evals.json.
  4. Checks the SKILL.md size budget (${SKILL_MD_MAX_BYTES} bytes, 15% over the ${SKILL_MD_BASELINE_BYTES}-byte baseline).
  5. Checks the generated AGENTS.md budget against an EXTERNAL anchor: the default render must stay
     inside byte, line and working-rule caps derived from the upstream reference template, not from
     whatever this template happens to render at. A cap whose baseline is the status quo can only
     ratify the status quo.
  6. Checks the generated AGENTS.md for restated, discoverable content — directory trees, stack
     descriptions — and proves the detector has teeth against a seeded violation.
  7. Checks the scope brake: the generated instruction file must state that the engineering workflow
     belongs to the engineering skills, and must carry none of the doctrine this skill used to ship
     (governance modes, landing points, ADR/CONTEXT routing, tracking policy, housekeeping duties).
     Seeded on both sides, because an assertion that only forbids is satisfied by an empty file.
  8. Checks --dry-run: it must change nothing, plan real artifacts rather than recite a template
     list, and agree with the write that follows it.
  9. Checks the skill's own shipped files: no command it prints may use a script path that only
     resolves from the skill directory (the agent's cwd is the target repo).
 10. Checks the bottleneck headline: a tie must name every tied subsystem, a unique minimum must
     name one, and a complete harness must report none.
 11. Checks the blank-project gate: the placeholder verification step must exit non-zero, a real
     command must still run, and — asserted through the real generator, not a hand-written string —
     a manifest that defines no check/typecheck/lint/test/build also refuses instead of exiting 0
     having verified nothing. A gate that cannot fail is not a gate.
 12. Checks the plain-description slot: omitting --blueprint must leave a visible pending marker
     rather than stack-derived text, and a supplied description must reach AGENTS.md verbatim.
 13. Checks the entry template: a fresh scaffold must not ship project-shaped feature entries, and
     must state the alignment rule before any entry may be added.
 14. Checks the instruction-file invariant: an existing CLAUDE.md must not get a second AGENTS.md
     beside it, and an existing instruction file must stay byte-identical while its missing
     harness sections are still reported.
 15. Checks the self-check's own coverage: every group in SELF_CHECK_GROUPS must have a bound check,
     a place in the pass conjunction, and a line in the shareable HTML report. A gate that only ever
     prints is half a carrier.
 16. Produces a JSON report and optional HTML report.

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
  console.log(`Self-check: ${selfCheck.pass ? 'PASS' : 'FAIL'} — scaffolded harness scored ${selfCheck.score}/100`);
  if (selfCheck.budget) {
    const { size, max, pass, rawSize, crlfCount, lineEndingInvariant } = selfCheck.budget;
    console.log(`  SKILL.md budget: ${pass ? 'PASS' : 'FAIL'} — ${size}/${max} bytes LF-normalized (${max - size >= 0 ? `${max - size} left` : `${size - max} over`})${crlfCount ? `; checkout is CRLF (${crlfCount} lines → raw ${rawSize})` : ''}; line-ending invariant: ${lineEndingInvariant ? 'ok' : 'NO'}`);
  }
  if (selfCheck.agentsBudget) {
    const { pass, size, max, lines, maxLines, ruleCount, maxRules, rawSize, crlfCount, lineEndingInvariant, error } = selfCheck.agentsBudget;
    console.log(`  AGENTS.md budget: ${pass ? 'PASS' : 'FAIL'} — ${size}/${max} bytes LF-normalized (${max - size >= 0 ? `${max - size} left` : `${size - max} over`}); ${lines}/${maxLines} lines; working rules ${ruleCount}/${maxRules}${crlfCount ? `; rendered CRLF (raw ${rawSize})` : ''}; line-ending invariant: ${lineEndingInvariant ? 'ok' : 'NO'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.agentsDiscover) {
    const { pass, offenders = [], selfRestraintStated, seededCaught, error } = selfCheck.agentsDiscover;
    console.log(`  AGENTS.md discoverability: ${pass ? 'PASS' : 'FAIL'} — default render free of restated content: ${offenders.length === 0 ? 'ok' : `NO (${offenders.join(', ')})`}; self-restraint rule stated: ${selfRestraintStated ? 'ok' : 'NO'}; seeded violation caught: ${seededCaught ? 'ok' : 'NO'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.scopeBrake) {
    const { pass, brake, leaked = [], seeded = [], error } = selfCheck.scopeBrake;
    console.log(`  Scope brake: ${pass ? 'PASS' : 'FAIL'} — engineering workflow delegated in the generated AGENTS.md: ${brake ? 'ok' : 'NO'}; doctrine carried over from the removed scope: ${leaked.length === 0 ? 'none' : `LEAKED (${leaked.join(', ')})`}; detector catches a seeded violation: ${seeded.length >= 7 ? 'ok' : `BLIND (${seeded.length}/7 patterns)`}${error ? ` — ${error}` : ''}`);
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
    const { pass, placeholderFails, realRuns, scriptlessRefuses, withTestRuns } = selfCheck.blankGate;
    console.log(`  Blank-project gate: ${pass ? 'PASS' : 'FAIL'} — placeholder verification exits non-zero: ${placeholderFails ? 'ok' : 'NO'}; a real command still runs: ${realRuns ? 'ok' : 'NO'}; a manifest with no runnable script refuses too: ${scriptlessRefuses ? 'ok' : 'NO'}; a manifest with a real script still runs: ${withTestRuns ? 'ok' : 'NO'}`);
  }
  if (selfCheck.blueprint) {
    const { pass, pendingMarked, noInventedFill, verbatim, error } = selfCheck.blueprint;
    console.log(`  Blueprint slot: ${pass ? 'PASS' : 'FAIL'} — omitted --blueprint stays a pending marker: ${pendingMarked ? 'ok' : 'NO'}; no stack-derived fill: ${noInventedFill ? 'ok' : 'NO'}; supplied blueprint reaches AGENTS.md verbatim: ${verbatim ? 'ok' : 'NO'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.entries) {
    const { pass, count, atMostExample, alignmentRuleStated, error } = selfCheck.entries;
    console.log(`  Entry restraint: ${pass ? 'PASS' : 'FAIL'} — no project-shaped entries at scaffold time (${count} entry/entries): ${atMostExample ? 'ok' : 'NO'}; alignment rule stated in feature_list.json and AGENTS.md: ${alignmentRuleStated ? 'ok' : 'NO'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.agentFile) {
    const { pass, noSecondFile, choseClaude, untouched, missingReported, error } = selfCheck.agentFile;
    console.log(`  Agent-file invariant: ${pass ? 'PASS' : 'FAIL'} — existing CLAUDE.md means no AGENTS.md is created: ${noSecondFile && choseClaude ? 'ok' : 'NO'}; existing instruction file left byte-identical: ${untouched ? 'ok' : 'NO'}; missing sections still reported: ${missingReported ? 'ok' : 'NO'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.reportCoverage) {
    const { pass, unbound = [], missingLines = [], orphanLines = [] } = selfCheck.reportCoverage;
    console.log(`  Report coverage: ${pass ? 'PASS' : 'FAIL'} — every self-check group is bound, gated and reported: ${pass ? 'ok' : `NO (unbound: ${unbound.join(', ') || 'none'}; missing report line: ${missingLines.join(', ') || 'none'}; orphan line: ${orphanLines.join(', ') || 'none'})`}`);
  }
  if (!selfCheck.pass && selfCheck.error) console.log(`  ${selfCheck.error}`);
  if (selfCheck.failedGroups?.length) console.log(`  Failing self-check group(s): ${selfCheck.failedGroups.join(', ')}`);
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
// The remaining groups keep the skill's own instruction file inside its size budget, keep every
// command the skill prints runnable from the target repo, keep the generated instruction file
// inside its external budgets and free of restated content — and keep it free of any instruction
// that would send the agent off to run the project's engineering workflow.
async function runSelfCheck() {
  let dir;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), 'harness-selfcheck-'));
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'selfcheck', scripts: { check: 'tsc', test: 'vitest run', build: 'vite build' } })
    );
    // A bare directory with a manifest is the plain case: no mode flag, no fixture project, no
    // signal to detect. If this call ever needs a flag again, a concept has crept back in.
    await execFileAsync('node', [path.join(scriptDir, 'create-harness.mjs'), '--target', dir]);
    const scored = scoreHarness(await loadHarnessFiles(dir));
    const minScore = Number(args.minSelfCheckScore || 90);
    // Driven by SELF_CHECK_GROUPS rather than a hand-written conjunction: the previous version listed
    // each group three times (call, conjunction, return object), so a new group could be computed and
    // printed while never joining the pass — a gate that reports and gates nothing.
    const groupChecks = {
      budget: () => checkSkillBudget(),
      agentsBudget: () => checkAgentFileBudget(),
      agentsDiscover: () => checkAgentFileDiscoverability(),
      scopeBrake: () => checkScopeBoundary(),
      dryRun: () => checkDryRun(),
      selfRefs: () => checkSelfReferencePaths(),
      bottleneckTies: () => checkBottleneckTies(),
      blankGate: () => checkBlankProjectGate(),
      blueprint: () => checkBlueprintSlot(),
      entries: () => checkEntryTemplateRestraint(),
      agentFile: () => checkAgentFileInvariant()
    };
    const groups = {};
    for (const key of SELF_CHECK_GROUPS) groups[key] = await groupChecks[key]();
    // Three ways the list can drift, all of them silent before: a group with no bound check (called
    // and crashed, or skipped), a group with no report line (console-only), and a report line for a
    // group that no longer exists (prose nothing backs). Each is named so a counter-example points
    // at the entry that broke.
    const unbound = SELF_CHECK_GROUPS.filter((key) => typeof groupChecks[key] !== 'function');
    const missingLines = SELF_CHECK_GROUPS.filter((key) => !SELF_CHECK_REPORT_LINES.has(key));
    const orphanLines = [...SELF_CHECK_REPORT_LINES.keys()].filter((key) => !SELF_CHECK_GROUPS.includes(key));
    const reportCoverage = {
      pass: unbound.length === 0 && missingLines.length === 0 && orphanLines.length === 0,
      unbound,
      missingLines,
      orphanLines
    };
    const failedGroups = SELF_CHECK_GROUPS.filter((key) => !groups[key]?.pass);
    return {
      pass: scored.overall >= minScore && reportCoverage.pass && failedGroups.length === 0,
      failedGroups,
      reportCoverage,
      score: scored.overall,
      ...groups,
      bottleneck: scored.bottleneck,
      bottlenecks: scored.bottlenecks
    };
  } catch (error) {
    return {
      pass: false,
      score: 0,
      failedGroups: [...SELF_CHECK_GROUPS],
      reportCoverage: { pass: false, unbound: [], missingLines: [], orphanLines: [] },
      error: error.message
    };
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
  // Holds for CRLF, LF and mixed endings alike: each CRLF removes exactly one byte, so this guards
  // the measurement definition — it fails the moment `size` stops normalizing (e.g. reverts to raw
  // bytes, where the difference becomes 0 and the guard goes red) — rather than the checkout's line
  // endings. Mixed endings are deliberately not detected here: they don't move the LF-normalized
  // size, so the cap stays honest and a line-ending hygiene check belongs elsewhere, if anywhere.
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

// The generated instruction file, measured end-to-end: the real template goes through the real
// renderer into a throwaway directory, because the thing being capped is what a target repo
// actually receives, not the template source. Same LF-normalized rule as SKILL.md, asserted rather
// than assumed, so a Windows checkout cannot force a contributor to delete content to satisfy a
// platform artifact.
async function checkAgentFileBudget() {
  let dir;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), 'harness-agents-budget-'));
    await execFileAsync('node', [path.join(scriptDir, 'create-harness.mjs'), '--target', dir]);
    const raw = await readText(path.join(dir, 'AGENTS.md'));
    const text = raw.replace(/\r\n/g, '\n');
    const size = Buffer.byteLength(text, 'utf8');
    const rawSize = Buffer.byteLength(raw, 'utf8');
    const crlfCount = (raw.match(/\r\n/g) || []).length;
    const lineEndingInvariant = rawSize - size === crlfCount;
    const lines = text.split('\n').length;
    // The working-rules list is the section that grows one line at a time, so it is counted on its
    // own instead of hiding inside the file total until the total is already too big.
    const section = text.split(/^##\s+/m).slice(1).find((part) => part.startsWith('工作规则')) || '';
    const ruleCount = section.split('\n').filter((line) => /^- \*\*/.test(line)).length;
    return {
      pass: size <= AGENTS_MD_MAX_BYTES && lines <= AGENTS_MD_MAX_LINES && ruleCount <= WORKING_RULES_MAX && lineEndingInvariant,
      size,
      max: AGENTS_MD_MAX_BYTES,
      lines,
      maxLines: AGENTS_MD_MAX_LINES,
      ruleCount,
      maxRules: WORKING_RULES_MAX,
      rawSize,
      crlfCount,
      lineEndingInvariant
    };
  } catch (error) {
    return { pass: false, error: error.message };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

// The failure every external guide names first: an instruction file that restates what the agent
// can read for itself — the directory tree, the stack, the package scripts. Those lines are paid
// for at every session start and buy nothing, and nothing here stopped them from being added.
// The detector is a pure function so the check can prove it has teeth against a seeded violation
// without writing anything into the repo. It reads DISCOVERABLE_CONTENT, declared up top.
function discoverableOffenders(text) {
  return DISCOVERABLE_CONTENT.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
}

async function checkAgentFileDiscoverability() {
  let dir;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), 'harness-agents-discover-'));
    await execFileAsync('node', [path.join(scriptDir, 'create-harness.mjs'), '--target', dir]);
    const rendered = await readText(path.join(dir, 'AGENTS.md'));
    const offenders = discoverableOffenders(rendered);
    // The self-restraint rule is the only thing in the shipped file that tells a future editor to
    // stop adding; losing it silently would re-open the unbounded growth this check exists to close.
    const selfRestraintStated = /本文件自我约束/.test(rendered) && /长期不变量/.test(rendered);
    const seeded = `${rendered}\n## 目录结构\n\n\`\`\`\n├── src\n└── dist\n\`\`\`\n\n- 技术栈：React + TypeScript\n`;
    const seededCaught = discoverableOffenders(seeded).length >= 2;
    return { pass: offenders.length === 0 && selfRestraintStated && seededCaught, offenders, selfRestraintStated, seededCaught };
  } catch (error) {
    return { pass: false, offenders: [], selfRestraintStated: false, seededCaught: false, error: error.message };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

async function checkScopeBoundary() {
  let dir;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), 'harness-scope-'));
    await execFileAsync('node', [path.join(scriptDir, 'create-harness.mjs'), '--target', dir]);
    const text = await readText(path.join(dir, 'AGENTS.md'));
    // The brake: the file must say the engineering workflow belongs to the engineering skills.
    const brake = /工程\s*skill/.test(text) && /不代做/.test(text);
    const leaked = FORBIDDEN_IN_AGENTS_MD.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
    const seeded = FORBIDDEN_IN_AGENTS_MD
      .filter(({ pattern }) => pattern.test(`${text}${SEEDED_VIOLATION}`))
      .map(({ name }) => name);
    return {
      pass: brake && leaked.length === 0 && seeded.length === FORBIDDEN_IN_AGENTS_MD.length,
      brake,
      leaked,
      seeded
    };
  } catch (error) {
    return { pass: false, brake: false, leaked: [], seeded: [], error: error.message };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
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

// A raw listing rather than loadHarnessFiles: the checks below assert "no files were written" and
// "the plan matches the run", and a known-name list would silently miss anything unexpected that
// did get written. A missing directory is itself the strongest pass — it means even mkdir never ran.
async function listDir(dir) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

// --dry-run. SKILL.md's pre-write CHECKPOINT asks the agent to show the artifact list and get
// approval *before* anything is written; the generator used to write as it went and print the list
// afterwards, so that gate was unsatisfiable — the prose demanded an order the tool could not
// produce. --dry-run supplies the missing order. A preview can fail in three independent ways, so
// all three are asserted: it can write anyway, it can recite a static template list that ignores
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
    const preview = await capture(['--target', dir, '--dry-run']);
    const wrote = await listDir(dir);
    const changesNothing = wrote.length === 0;
    const previewedFiles = /^WRITTEN /m.test(preview);

    // 2. The preview is a plan, not a recital. After a real run every artifact exists, so the next
    //    preview must report SKIPPED — a static list would still claim WRITTEN here.
    await execFileAsync('node', [script, '--target', dir]);
    const second = await capture(['--target', dir, '--dry-run']);
    const reflectsState = /^SKIPPED /m.test(second) && !/^WRITTEN /m.test(second);

    // 3. The plan must equal the run it previews, or the user approves a different action than the
    //    one that executes. Both runs target the same fresh directory, so the comparison is exact.
    pair = await mkdtemp(path.join(os.tmpdir(), 'harness-dryrun-pair-'));
    const plan = await capture(['--target', pair, '--dry-run']);
    const real = await capture(['--target', pair]);
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

function scoreEvals(evalsJson) {
  const cases = Array.isArray(evalsJson.evals) ? evalsJson.evals : [];
  const checks = [];
  checks.push({ pass: cases.length >= 10, message: 'At least 10 eval cases' });
  // This list is the coverage contract, and it must grow whenever a capability family ships —
  // otherwise the headline score keeps reading 100% while a new family has no behavioural case at
  // all. It went stale twice: the first entries were written when the skill was smaller, so later
  // families had gates but no case; and checking the reverse direction found cases the file left
  // unprotected — deleting them left the headline at 100%. A gate proves a SCRIPT is right; only a
  // case shows what an AGENT does. The entries are data, not inline predicates, because the guards
  // below reuse them for both pairing directions. Each entry keeps a distinct message so a
  // counter-example shows exactly which one broke.
  //
  // The list is one-for-one with the eval file and covers the scope this skill now claims: the five
  // subsystems, the safety and measurement properties of its own tooling, and — case 16 — the
  // boundary that keeps it from handing the agent work belonging to the engineering skills. Cases
  // for the removed scope (tracker mode, landing points, ADR/CONTEXT routing, housekeeping, the
  // upstream interlock lists) were deleted with that scope; keeping them would have asserted the
  // behaviour this skill no longer wants to have.
  const familyEntries = [
    ['Covers minimal harness creation', /最小化/],
    ['Covers session continuity', /连续性/],
    ['Covers harness assessment', /评估/],
    ['Covers verification workflow', /验证工作流/],
    ['Covers memory taxonomy', /记忆/],
    ['Covers tool safety', /工具/],
    ['Covers context budgeting', /上下文预算/],
    ['Covers multi-agent coordination', /多代理/],
    ['Covers lifecycle bootstrap', /生命周期/],
    ['Covers scripted validation tooling', /脚本化/],
    ['Covers the plain-description slot', /项目说明/],
    ['Covers entry-template restraint', /条目模板/],
    ['Covers the instruction-file invariant', /指令文件不变量/],
    ['Covers instruction-file size and discoverability', /不可发现/],
    ['Covers the gate that refuses when nothing can run', /无可跑脚本/],
    ['Covers the scope brake against doing the engineering workflow', /范围边界/],
    ['Covers the post-handoff boundary', /交接/],
    ['Covers session wrap-up', /收尾/]
  ];
  for (const [message, pattern] of familyEntries) {
    checks.push({ pass: cases.some((item) => pattern.test(item.name)), message });
  }
  // The guard asserts the reverse of every entry above: the entries prove each family still has
  // a case; this proves each case is still claimed by an entry. Without it a case can leave the
  // contract unnoticed — the state those 17 cases were in — and no deletion moves the headline.
  const orphans = cases.filter((item) => !familyEntries.some(([, pattern]) => pattern.test(item.name)));
  checks.push({
    pass: orphans.length === 0,
    message: `Every eval case is referenced by a contract entry${orphans.length ? ` — orphan case(s): ${orphans.map((item) => `${item.id} ${item.name}`).join('; ')}` : ''}`
  });
  // The over-claim check closes the last silent path: an entry matching two cases would let
  // either be deleted unnoticed — the family still looks covered by the other one — which is the
  // same invisible-deletion defect the orphan guard closes on the case side. An entry matching
  // nothing is already caught by its own check above.
  const overclaimed = familyEntries.filter(([, pattern]) => cases.filter((item) => pattern.test(item.name)).length > 1);
  checks.push({
    pass: overclaimed.length === 0,
    message: `No contract entry matches more than one eval case${overclaimed.length ? ` — over-claiming: ${overclaimed.map(([message]) => message).join('; ')}` : ''}`
  });
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
  // The no-manifest branch above was only half the trap. A repo that HAS a manifest but defines
  // none of check/typecheck/lint/test/build left the install as the only step, so ./init.sh ran,
  // printed "Verification Complete" and exited 0 having verified nothing — and the audit scored
  // that repo 100/100 with "Verification fails fast" PASS, since its checks are existence checks.
  // Asserted through the real generator with the real project shape: handing renderVerificationStep
  // a hand-written sentence would only prove this probe's copy of the string is right.
  const scriptless = verificationCommands({ stack: 'node', packageJson: { scripts: {} }, packageManager: 'npm' }, 'npm');
  const scriptlessRefuses = scriptless.length > 1
    && scriptless.slice(1).some((command) => /\bexit 1\b/.test(renderVerificationStep(command)));
  // The other direction: one real script must still yield a runnable gate, not a refusal. Without
  // this arm "always emit the placeholder" would pass, which is the failure mode of a gate that
  // refuses everything.
  const withTest = verificationCommands({ stack: 'node', packageJson: { scripts: { test: 'jest' } }, packageManager: 'npm' }, 'npm');
  const withTestRuns = withTest.some((command) => {
    const rendered = renderVerificationStep(command);
    return !/\bexit 1\b/.test(rendered) && rendered.includes('npm test');
  });
  return {
    pass: placeholderFails && realRuns && scriptlessRefuses && withTestRuns,
    placeholderFails,
    realRuns,
    scriptlessRefuses,
    withTestRuns
  };
}

// The plain-description slot. AGENTS.md's one place that answers "what is this project"
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

    await execFileAsync('node', [script, '--target', dir]);
    const omitted = await readText(path.join(dir, 'AGENTS.md'));
    // Pending must be explicit and must not smuggle in stack-derived boilerplate.
    const pendingMarked = omitted.includes('待补');
    const noInventedFill = !/agent-assisted development/i.test(omitted);

    supplied = await mkdtemp(path.join(os.tmpdir(), 'harness-blueprint-set-'));
    await execFileAsync('node', [script, '--target', supplied, '--blueprint', blueprint]);
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
    await execFileAsync('node', [path.join(scriptDir, 'create-harness.mjs'), '--target', dir]);
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

// Stage thirteen: the instruction-file choice invariant and the report-don't-write contract.
// The rule (shared with matt, so the two never drift) is: edit CLAUDE.md when it exists, otherwise
// AGENTS.md — and NEVER create AGENTS.md beside an existing CLAUDE.md. Two instruction files in one
// repo is the failure the partition exists to prevent: an agent reads two contradictory routing
// tables. It shipped ungated: `detectAgentFile()` had implementation but no assertion, and the only
// "coverage" was a prose expectation in evals.json, which no run mechanically enforces.
// The second half is the merge contract, split because each half fails differently: an existing
// instruction file must come out byte-identical (writing clobbers the user's own content), AND the
// run must still name the harness sections that file lacks (silently skipping leaves the agent with
// no idea what is absent). Asserting only "not written" would pass a script that skips everything.
async function checkAgentFileInvariant() {
  let claudeDir;
  let agentsDir;
  try {
    const script = path.join(scriptDir, 'create-harness.mjs');

    claudeDir = await mkdtemp(path.join(os.tmpdir(), 'harness-agentfile-claude-'));
    await writeText(path.join(claudeDir, 'CLAUDE.md'), '# Claude\n\n## Startup workflow\n\nExisting content.\n');
    const claudeRun = await execFileAsync('node', [script, '--target', claudeDir]);
    // The absence of AGENTS.md is the invariant; the report naming CLAUDE.md is what proves the
    // choice was made deliberately rather than by never writing an instruction file at all.
    const noSecondFile = !(await exists(path.join(claudeDir, 'AGENTS.md')));
    const choseClaude = /CLAUDE\.md/.test(claudeRun.stdout) && (await exists(path.join(claudeDir, 'CLAUDE.md')));

    agentsDir = await mkdtemp(path.join(os.tmpdir(), 'harness-agentfile-agents-'));
    const existing = '# AGENTS.md\n\n## Agent skills\n\nThird-party block that must survive.\n';
    const agentsPath = path.join(agentsDir, 'AGENTS.md');
    await writeText(agentsPath, existing);
    const agentsRun = await execFileAsync('node', [script, '--target', agentsDir]);
    const untouched = (await readText(agentsPath)) === existing;
    // At least one missing section heading must be listed; keying on the literal names would break
    // every time a section is renamed, while "lists nothing" is the actual defect.
    const missingReported = /\n\s*-\s*##\s/.test(agentsRun.stdout);

    return {
      pass: noSecondFile && choseClaude && untouched && missingReported,
      noSecondFile,
      choseClaude,
      untouched,
      missingReported
    };
  } catch (error) {
    return { pass: false, noSecondFile: false, choseClaude: false, untouched: false, missingReported: false, error: error.message };
  } finally {
    for (const target of [claudeDir, agentsDir]) if (target) await rm(target, { recursive: true, force: true });
  }
}

function recommend(harnessResult, evalResult) {
  if (harnessResult.overall >= 85 && evalResult.score >= 90) {
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
  // Built from SELF_CHECK_REPORT_LINES rather than one hand-written line per gate. Most groups had
  // drifted out of this report while the comment below kept promising they were here — they were
  // console-only, so the artifact a round is reviewed from said nothing about them. Generating the
  // lines from the same list the pass conjunction uses means a new gate cannot be half-carried
  // again.
  const selfCheckLines = SELF_CHECK_GROUPS
    .map((key) => {
      const group = report.selfCheck?.[key];
      const build = SELF_CHECK_REPORT_LINES.get(key);
      return group && build ? build(group) : '';
    })
    .join('');
  const coverageLine = report.selfCheck?.reportCoverage
    ? ` Every self-check group is bound, gated and reported (${report.selfCheck.reportCoverage.pass ? 'verified' : `FAILED — unbound: ${report.selfCheck.reportCoverage.unbound.join(', ') || 'none'}; missing report line: ${report.selfCheck.reportCoverage.missingLines.join(', ') || 'none'}; orphan line: ${report.selfCheck.reportCoverage.orphanLines.join(', ') || 'none'}`}).`
    : '';
  const selfCheckSection = report.selfCheck?.skipped
    ? ''
    : `<section>
      <h2>Script Self-Check <span>${report.selfCheck.pass ? 'PASS' : 'FAIL'}</span></h2>
      <p>Scaffolded a throwaway harness and scored it ${report.selfCheck.score}/100 — confirms the bundled scripts run end-to-end rather than merely being present.${coverageLine}${selfCheckLines}${report.selfCheck.error ? ` Error: ${escapeHtml(report.selfCheck.error)}` : ''}</p>
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
