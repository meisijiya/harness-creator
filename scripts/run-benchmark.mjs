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
  harnessAgentDocs,
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
// file grew past the old 150%-of-7889 ceiling while gaining a whole capability family (the
// instruction-file extraction layer — templates, generator, scorer, maintenance flow, gates), and
// three independent judges confirmed that the phrase-by-phrase compression paying for it had
// deleted real content. Rather than keep trading content for bytes, the baseline is now the
// previous stable SKILL.md and the allowance drops from 150% to 15% — the same multiplier the
// generated AGENTS.md gets. Net effect: less headroom in absolute terms than re-interpreting the
// old 150% against the new baseline would have given, so the ratchet keeps biting.
const SKILL_MD_BASELINE_BYTES = 11801;
const SKILL_MD_MAX_BYTES = Math.floor(SKILL_MD_BASELINE_BYTES * 1.15);

// The generated instruction file gets the same treatment, for the same reason and with more at
// stake: it is the largest artifact this skill ships into every target repo, it is read in full at
// every session start, and nothing used to measure it — while the audit's instruction checks are
// all presence checks, so extra text could only ever help. Measured on a default render (no
// --blueprint, no --commands) because the cap must not depend on what a project happens to fill in.
//
// Ratcheted down when the file became a routing layer: situation-specific detail moved into
// docs/agents/*.md, so the default render should stay near the new, smaller baseline instead of
// having the old, manual-shaped ceiling silently available as headroom for re-growth.
const AGENTS_MD_BASELINE_BYTES = 8692;
const AGENTS_MD_MAX_BYTES = Math.floor(AGENTS_MD_BASELINE_BYTES * 1.15);
const AGENTS_MD_MAX_LINES = 113;
// The template states this limit in its own "本文件自我约束" rule; the check keeps the statement
// honest, so a 13th rule has to displace something instead of just accumulating.
const WORKING_RULES_MAX = 12;

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
  'budget', 'agentsBudget', 'agentsDiscover', 'extraction', 'tracker', 'gate', 'dryRun',
  'selfRefs', 'bottleneckTies', 'blankGate', 'handoff', 'blueprint', 'entries', 'agentFile',
  'housekeeping', 'modeReport'
];

// One sentence builder per group, keyed by the same names. The self-check asserts the two sets are
// equal in both directions, so a group without a line (console-only) and a line without a group
// (prose nothing backs) both fail instead of shipping. Each builder gets the group object and must
// return '' for a missing group.
const SELF_CHECK_REPORT_LINES = new Map([
  ['budget', (group) => ` SKILL.md sits at ${group.size}/${group.max} bytes (${group.pass ? 'within' : 'OVER'} budget).`],
  ['agentsBudget', (group) => ` The generated AGENTS.md stays inside its byte, line and working-rule budgets (${group.pass ? 'verified' : 'FAILED'}).`],
  ['agentsDiscover', (group) => ` The instruction file does not restate what the agent can read for itself, and the detector is proven to have teeth by a seeded violation (${group.pass ? 'verified' : 'FAILED'}).`],
  ['extraction', (group) => ` The split-out instruction layer is scaffolded and routed, the scorer follows those routes, and a dangling route or an orphan doc is caught (${group.pass ? 'verified' : 'FAILED'}).`],
  ['tracker', (group) => ` A tracker-mode scaffold keeps no registry state and its init.sh routes to the ticket system rather than to files that mode skips (${group.pass ? 'verified' : 'FAILED'}).`],
  ['gate', (group) => ` A signal-free repo with no explicit --mode refuses to write, while both legitimate paths still pass (${group.pass ? 'verified' : 'FAILED'}).`],
  ['dryRun', (group) => ` --dry-run writes nothing, reports the target's real state, and its plan matches the live run entry for entry (${group.pass ? 'verified' : 'FAILED'}).`],
  ['selfRefs', (group) => ` ${group.checked} shipped file(s) checked for command reachability from a target repo (${group.pass ? 'all runnable' : `relative self-reference in ${(group.offenders || []).join(', ')}`}).`],
  ['bottleneckTies', (group) => ` The bottleneck line names ${group.tieCount} tied subsystem(s) as a tie instead of picking one (${group.pass ? 'verified' : 'FAILED'}).`],
  ['blankGate', (group) => ` A project with nothing to verify — no manifest, or a manifest with no runnable script — gets a placeholder step that exits non-zero instead of reporting a pass it did not earn (${group.pass ? 'verified' : 'FAILED'}).`],
  ['handoff', (group) => ` A handoff doc under .scratch/ is recognised regardless of filename, while one outside the landing points is ignored (${group.pass ? 'verified' : 'FAILED'}).`],
  ['blueprint', (group) => ` The project-blueprint slot stays a visible pending marker when the user has not stated one, rather than being filled from the detected stack (${group.pass ? 'verified' : 'FAILED'}).`],
  ['entries', (group) => ` A freshly scaffolded registry ships no project-shaped feature entries, and states the alignment rule before any entry may be added (${group.pass ? 'verified' : 'FAILED'}).`],
  ['agentFile', (group) => ` An existing CLAUDE.md is reused instead of having AGENTS.md created beside it, and an existing instruction file is left byte-identical while its missing sections are still reported (${group.pass ? 'verified' : 'FAILED'}).`],
  ['housekeeping', (group) => ` The housekeeping scanner changes nothing, refuses to call uncommitted history stale without a --session-ref (and still marks history when given one), suppresses pruning during wrap-up, and never prunes a done-without-evidence entry (${group.pass ? 'verified' : 'FAILED'}).`],
  ['modeReport', (group) => ` The housekeeping scanner reads .scratch/ as work in progress rather than as a tracker signal, while a real tracker signal is still detected (${group.pass ? 'verified' : 'FAILED'}).`]
]);

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
  4. Checks the SKILL.md size budget (${SKILL_MD_MAX_BYTES} bytes, 15% over the ${SKILL_MD_BASELINE_BYTES}-byte baseline).
  5. Checks the generated AGENTS.md budget: the default render must stay within its byte and line
     caps, and the working-rules list within the limit its own self-restraint rule states.
  6. Checks the generated AGENTS.md for restated, discoverable content — directory trees, stack
     descriptions — and proves the detector has teeth against a seeded violation.
  7. Checks the extraction layer: the generator ships docs/agents/*.md and routes to it, the scorer
     follows those routes (a harness-owned doc counts; the same content under an upstream-owned
     name does not), a dangling route is caught, and an orphan doc is caught.
  8. Scores a tracker-mode scaffold and checks its emitted-artifact invariants: no skill-repo-relative
     path reaches a target repo, no registry state file is emitted, and — the leak a file-name check
     cannot see — the generated init.sh routes to the ticket system instead of naming the two state
     files this mode skips. A registry scaffold is checked in the same run so "delete the block"
     cannot pass.
  9. Checks the mode gate: a signal-free target given no explicit --mode must refuse to write (exit 1,
     zero files), while an explicit --mode or a detected signal must still scaffold.
 10. Checks --dry-run: it must change nothing, plan real artifacts rather than recite a template
     list, and agree with the write that follows it.
 11. Checks the skill's own shipped files: no command it prints may use a script path that only
     resolves from the skill directory (the agent's cwd is the target repo).
 12. Checks the bottleneck headline: a tie must name every tied subsystem, a unique minimum must
     name one, and a complete harness must report none.
 13. Checks the blank-project gate: the placeholder verification step must exit non-zero, a real
     command must still run, and — asserted through the real generator, not a hand-written string —
     a manifest that defines no check/typecheck/lint/test/build also refuses instead of exiting 0
     having verified nothing. A gate that cannot fail is not a gate.
 14. Checks handoff recognition: a doc under .scratch/ is recognised by what it is, not by one
     filename, while a doc outside the landing points is ignored.
 15. Checks the blueprint slot: omitting --blueprint must leave a visible pending marker rather
     than stack-derived text, and a supplied blueprint must reach AGENTS.md verbatim.
 16. Checks the entry template: a fresh registry scaffold must not ship project-shaped feature
     entries, and must state the alignment rule before any entry may be added.
 17. Checks the instruction-file invariant: an existing CLAUDE.md must not get a second AGENTS.md
     beside it, and an existing instruction file must stay byte-identical while its missing
     harness sections are still reported.
 18. Checks the housekeeping scanner: it must change nothing, must not treat history as prunable
     when no --session-ref is given, must still mark history when one is, must never prune a
     done-without-evidence entry, and must report the instruction file's own health — ranked
     sections, unfilled placeholders — without editing it. Dangling exemption rows are read from the
     split-out doc the generator actually writes AND from an inline table in the root file, because
     reading only one of the two is how this stayed green over a shape no real harness has.
 19. Checks the housekeeping scanner's mode report against the authoritative detector: `.scratch/`
     must not count as a tracker signal, feature_list.json must win over a signal, and a real
     tracker signal — including the AGENTS.md vocabulary of the lazily-created window — must still
     be detected. A detector that only ever answers "registry" must not pass.
 20. Checks the self-check's own coverage: every group in SELF_CHECK_GROUPS must have a bound check,
     a place in the pass conjunction, and a line in the shareable HTML report. A gate that only ever
     prints is half a carrier, and seven groups had drifted into exactly that.
 21. Produces a JSON report and optional HTML report.

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
  if (selfCheck.agentsBudget) {
    const { pass, size, max, lines, maxLines, ruleCount, maxRules, rawSize, crlfCount, lineEndingInvariant, error } = selfCheck.agentsBudget;
    console.log(`  AGENTS.md budget: ${pass ? 'PASS' : 'FAIL'} — ${size}/${max} bytes LF-normalized (${max - size >= 0 ? `${max - size} left` : `${size - max} over`}); ${lines}/${maxLines} lines; working rules ${ruleCount}/${maxRules}${crlfCount ? `; rendered CRLF (raw ${rawSize})` : ''}; line-ending invariant: ${lineEndingInvariant ? 'ok' : 'NO'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.agentsDiscover) {
    const { pass, offenders = [], selfRestraintStated, seededCaught, error } = selfCheck.agentsDiscover;
    console.log(`  AGENTS.md discoverability: ${pass ? 'PASS' : 'FAIL'} — default render free of restated content: ${offenders.length === 0 ? 'ok' : `NO (${offenders.join(', ')})`}; self-restraint rule stated: ${selfRestraintStated ? 'ok' : 'NO'}; seeded violation caught: ${seededCaught ? 'ok' : 'NO'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.extraction) {
    const { pass, scaffolded, followsRoutes, upstreamNotCounted, sanePasses, danglingCaught, orphanCaught, docCount, error } = selfCheck.extraction;
    console.log(`  Instruction extraction: ${pass ? 'PASS' : 'FAIL'} — ${docCount ?? 0} doc(s) scaffolded and routed: ${scaffolded ? 'ok' : 'NO'}; scorer follows routes: ${followsRoutes ? 'ok' : 'NO'}; upstream doc cannot substitute: ${upstreamNotCounted ? 'ok' : 'NO'}; clean split passes: ${sanePasses ? 'ok' : 'NO'}; dangling route caught: ${danglingCaught ? 'ok' : 'NO'}; orphan doc caught: ${orphanCaught ? 'ok' : 'NO'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.tracker) {
    const { pass, score, offenders = [], leakedState = [], trackerNamesNoRegistry, registryNamesItsState, error } = selfCheck.tracker;
    console.log(`  Tracker scaffold: ${pass ? 'PASS' : 'FAIL'} — scored ${score}/100; tracker init.sh routes to its own state, not the registry files: ${trackerNamesNoRegistry ? 'ok' : 'NO'}; registry init.sh still routes to its own state: ${registryNamesItsState ? 'ok' : 'NO'}${offenders.length ? ` — skill-relative path in ${offenders.join(', ')}` : ''}${leakedState.length ? ` — registry state leaked into tracker mode: ${leakedState.join(', ')}` : ''}${error ? ` — ${error}` : ''}`);
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
    const { pass, placeholderFails, realRuns, scriptlessRefuses, withTestRuns } = selfCheck.blankGate;
    console.log(`  Blank-project gate: ${pass ? 'PASS' : 'FAIL'} — placeholder verification exits non-zero: ${placeholderFails ? 'ok' : 'NO'}; a real command still runs: ${realRuns ? 'ok' : 'NO'}; a manifest with no runnable script refuses too: ${scriptlessRefuses ? 'ok' : 'NO'}; a manifest with a real script still runs: ${withTestRuns ? 'ok' : 'NO'}`);
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
  if (selfCheck.agentFile) {
    const { pass, noSecondFile, choseClaude, untouched, missingReported, error } = selfCheck.agentFile;
    console.log(`  Agent-file invariant: ${pass ? 'PASS' : 'FAIL'} — existing CLAUDE.md means no AGENTS.md is created: ${noSecondFile && choseClaude ? 'ok' : 'NO'}; existing instruction file left byte-identical: ${untouched ? 'ok' : 'NO'}; missing sections still reported: ${missingReported ? 'ok' : 'NO'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.housekeeping) {
    const { pass, readOnly, noRefMeansUnverified, refMarksHistory, pruneActive, pruneSuppressed, noEvidenceNeverPruned, porcelainPathIntact, instructionReported, danglingExemptionReported, placeholderReported, docEntryReported, error } = selfCheck.housekeeping;
    console.log(`  Housekeeping safety: ${pass ? 'PASS' : 'FAIL'} — scan changes nothing: ${readOnly ? 'ok' : 'NO'}; no --session-ref means unverified, not stale: ${noRefMeansUnverified ? 'ok' : 'NO'}; a ref still marks history: ${refMarksHistory ? 'ok' : 'NO'}; housekeeping still emits prune candidates: ${pruneActive ? 'ok' : 'NO'}; wrap-up suppresses prune: ${pruneSuppressed ? 'ok' : 'NO'}; done-without-evidence never pruned: ${noEvidenceNeverPruned ? 'ok' : 'NO'}; porcelain path keeps its first character: ${porcelainPathIntact ? 'ok' : 'NO'}; instruction file reported with ranked sections: ${instructionReported ? 'ok' : 'NO'}; dangling exemption rows named in both layouts (split-out doc + inline), live one left alone: ${danglingExemptionReported ? 'ok' : 'NO'}; unfilled placeholder surfaced: ${placeholderReported ? 'ok' : 'NO'}; document entry: unowned + dangling named, compliant ones left alone: ${docEntryReported ? 'ok' : 'NO'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.modeReport) {
    const { pass, scratchIsNotSignal, trackerDetected, registryWins, windowCaseDetected, error } = selfCheck.modeReport;
    console.log(`  Housekeeping mode report: ${pass ? 'PASS' : 'FAIL'} — .scratch/ is not a tracker signal: ${scratchIsNotSignal ? 'ok' : 'NO'}; a real tracker signal is still detected: ${trackerDetected ? 'ok' : 'NO'}; feature_list.json wins over a signal: ${registryWins ? 'ok' : 'NO'}; tracker vocabulary in the setup window detected: ${windowCaseDetected ? 'ok' : 'NO'}${error ? ` — ${error}` : ''}`);
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
    const minScore = Number(args.minSelfCheckScore || 90);
    // Driven by SELF_CHECK_GROUPS rather than a hand-written conjunction: the previous version listed
    // each group three times (call, conjunction, return object), so a new group could be computed and
    // printed while never joining the pass — a gate that reports and gates nothing. Lazy entries
    // because checkTrackerScaffold needs minScore.
    const groupChecks = {
      budget: () => checkSkillBudget(),
      agentsBudget: () => checkAgentFileBudget(),
      agentsDiscover: () => checkAgentFileDiscoverability(),
      extraction: () => checkExtractionLayer(),
      tracker: () => checkTrackerScaffold(minScore),
      gate: () => checkModeGate(),
      dryRun: () => checkDryRun(),
      selfRefs: () => checkSelfReferencePaths(),
      bottleneckTies: () => checkBottleneckTies(),
      blankGate: () => checkBlankProjectGate(),
      handoff: () => checkHandoffRecognition(),
      blueprint: () => checkBlueprintSlot(),
      entries: () => checkEntryTemplateRestraint(),
      agentFile: () => checkAgentFileInvariant(),
      housekeeping: () => checkHousekeepingSafety(),
      modeReport: () => checkHousekeepingMode()
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
      pass: scored.overall >= minScore && english.overall >= minScore && reportCoverage.pass && failedGroups.length === 0,
      failedGroups,
      reportCoverage,
      score: scored.overall,
      englishScore: english.overall,
      ...groups,
      bottleneck: scored.bottleneck ?? english.bottleneck,
      bottlenecks: scored.bottlenecks.length ? scored.bottlenecks : english.bottlenecks
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
    await execFileAsync('node', [path.join(scriptDir, 'create-harness.mjs'), '--target', dir, '--mode', 'registry']);
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
    await execFileAsync('node', [path.join(scriptDir, 'create-harness.mjs'), '--target', dir, '--mode', 'registry']);
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

// The instruction subsystem is two layers: the root file routes, and docs/agents/*.md carries the
// situation-specific detail. Four things have to hold or the split silently degrades into either a
// manual again or a place detail disappears into:
//   - the generator ships the layer, and the root file carries routes to it;
//   - the scorer follows the routes (reading only the root file would score extraction as deletion,
//     which is the incentive that grew the file in the first place) — asserted as a differential
//     pair so it cannot pass by accident: the same body must count under a harness-owned path and
//     must NOT count under one of matt's names, which harness content cannot hide behind;
//   - a route to a missing file is caught (dangling);
//   - a doc nothing routes to is caught (orphan).
async function checkExtractionLayer() {
  let dir;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), 'harness-extraction-'));
    const create = () => execFileAsync('node', [
      path.join(scriptDir, 'create-harness.mjs'), '--target', dir, '--mode', 'registry', '--force'
    ]);
    await create();

    const rendered = await readText(path.join(dir, 'AGENTS.md'));
    const docPaths = await harnessAgentDocs();
    const routed = [...new Set(
      [...rendered.matchAll(/docs\/agents\/([A-Za-z0-9._-]+\.md)/g)].map((match) => `docs/agents/${match[1]}`)
    )];
    let shipped = 0;
    for (const doc of docPaths) if (await exists(path.join(dir, doc))) shipped += 1;
    const scaffolded = docPaths.length > 0 && shipped === docPaths.length && routed.length > 0;

    const ownCheck = (result, message) => result.subsystems.instructions.checks
      .find((check) => check.message === message).pass;
    const doneMessage = 'Definition of done documented';
    const body = '## 完成定义\n\n- [ ] proof\n';
    const followsRoutes = ownCheck(scoreHarness([
      { path: 'AGENTS.md', content: '# x\n' },
      { path: `${docPaths[0]}`, content: body, role: 'instruction-doc' }
    ]), doneMessage) === true;
    const upstreamNotCounted = ownCheck(scoreHarness([
      { path: 'AGENTS.md', content: '# x\n' },
      { path: 'docs/agents/issue-tracker.md', content: body }
    ]), doneMessage) === false;

    const routingCheck = (result) => result.subsystems.instructions.checks
      .find((check) => check.message.startsWith('Instruction routing')).pass;
    const sanePasses = routingCheck(scoreHarness(await loadHarnessFiles(dir))) === true;

    await rm(path.join(dir, docPaths[0]));
    const danglingCaught = routingCheck(scoreHarness(await loadHarnessFiles(dir))) === false;

    await create();
    const docName = path.basename(docPaths[0]);
    const withoutRoute = (await readText(path.join(dir, 'AGENTS.md')))
      .split(/\r?\n/)
      .filter((line) => !line.includes(`docs/agents/${docName}`))
      .join('\n');
    await writeFile(path.join(dir, 'AGENTS.md'), withoutRoute, 'utf8');
    const orphanCaught = routingCheck(scoreHarness(await loadHarnessFiles(dir))) === false;

    return {
      pass: scaffolded && followsRoutes && upstreamNotCounted && sanePasses && danglingCaught && orphanCaught,
      scaffolded,
      followsRoutes,
      upstreamNotCounted,
      sanePasses,
      danglingCaught,
      orphanCaught,
      docCount: docPaths.length
    };
  } catch (error) {
    return { pass: false, error: error.message };
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
    ...await collect('templates', 'templates/', () => true),
    ...await collect('templates/agent-docs', 'templates/agent-docs/', (name) => name.endsWith('.md'))
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
    const trackerDir = path.join(dir, 'tracker');
    const registryDir = path.join(dir, 'registry');
    await mkdir(trackerDir, { recursive: true });
    await mkdir(registryDir, { recursive: true });
    await execFileAsync('node', [path.join(scriptDir, 'create-harness.mjs'), '--target', trackerDir, '--mode', 'tracker']);
    await execFileAsync('node', [path.join(scriptDir, 'create-harness.mjs'), '--target', registryDir, '--mode', 'registry']);
    const emitted = await loadHarnessFiles(trackerDir);
    const offenders = emitted.filter(({ content }) => SKILL_RELATIVE_PATH.test(content)).map(({ path: file }) => file);
    const leakedState = emitted
      .map(({ path: file }) => file)
      .filter((file) => ['feature_list.json', 'feature-list.json', 'progress.md'].includes(file));
    // The artifact list was clean while the contents were not: init.sh still told the agent to read
    // the two files that same run had reported as SKIPPED, so every tracker repo shipped a startup
    // script pointing at files that do not exist. The guard reads the startup script's own text
    // instead of the file list, because that is where the leak lived. AGENTS.md and
    // tracking-policy.md name the registry artifacts on purpose — they draw the mode boundary — so
    // the guard is scoped to the one file whose entire job is telling the agent what to do first.
    const nextStepsOf = async (target) => (await readText(path.join(target, 'init.sh'))).split(/Next steps:/)[1] || '';
    const namesRegistryArtifacts = (text) => /feature_list\.json|progress\.md/.test(text);
    const trackerNamesNoRegistry = !namesRegistryArtifacts(await nextStepsOf(trackerDir));
    // The other direction: registry mode must still route to its own state, so "delete the whole
    // next-steps block" cannot pass this guard.
    const registryNamesItsState = namesRegistryArtifacts(await nextStepsOf(registryDir));
    const score = scoreHarness(emitted).overall;
    return {
      pass: offenders.length === 0 && leakedState.length === 0 && trackerNamesNoRegistry && registryNamesItsState && score >= minScore,
      score,
      offenders,
      leakedState,
      trackerNamesNoRegistry,
      registryNamesItsState
    };
  } catch (error) {
    return {
      pass: false,
      score: 0,
      offenders: [],
      leakedState: [],
      trackerNamesNoRegistry: false,
      registryNamesItsState: false,
      error: error.message
    };
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
  // This list is the coverage contract, and it must grow whenever a capability family ships —
  // otherwise the headline score keeps reading 100% while a new family has no behavioural case at
  // all. It went stale twice: the first entries were written when the skill was smaller, so later
  // families had gates but no case; and checking the reverse direction found 17 of the 23 cases
  // then in the file unprotected — deleting them left the headline at 100%. A gate proves a
  // SCRIPT is right; only a case shows what an AGENT does. The entries are data, not inline
  // predicates, because the guards below reuse them for both pairing directions. Each entry keeps
  // a distinct message so a counter-example shows exactly which one broke.
  const familyEntries = [
    ['Covers minimal harness creation', /minimal|creation|最小化/i],
    ['Covers session continuity', /session|continuity|连续性/i],
    ['Covers harness assessment', /assessment|score|评估|得分/i],
    ['Covers verification workflow', /verification|验证工作流/i],
    ['Covers memory taxonomy', /memory|记忆/i],
    ['Covers tool safety', /tool|permission|safety|工具|权限|安全/i],
    ['Covers multi-agent coordination', /multi-agent|delegation|coordination|多代理|协调|委派/i],
    ['Covers scripted validation tooling', /脚本化|scripted/i],
    ['Covers the blueprint slot', /蓝图|blueprint/i],
    ['Covers entry-template restraint', /条目模板|克制|restraint/i],
    ['Covers the instruction-file invariant', /指令文件不变量|CLAUDE|instruction.file invariant/i],
    ['Covers instruction-file size and discoverability', /不可发现|discoverab/i],
    ['Covers instruction extraction', /抽离|extraction|精简/i],
    ['Covers context budgeting', /上下文预算|context budget/i],
    ['Covers lifecycle bootstrap', /生命周期|lifecycle/i],
    ['Covers tracker mode', /tracker/i],
    ['Covers repo housekeeping', /整理仓库|清账|housekeeping/i],
    ['Covers matt coexistence', /共存|coexist|matt/i],
    ['Covers artifact tracking alignment', /跟踪|tracking/i],
    ['Covers third-party artifact routing', /受控放行|放行|第三方|third-party/i],
    ['Covers session wrap-up', /收尾|wrap.?up/i],
    ['Covers task advancement', /任务推进|advancement|条目即工单/i],
    ['Covers the post-handoff boundary', /交接/i],
    ['Covers upstream maintenance', /上游变更|upstream/i],
    // The three families below close coverage for defects found by auditing the scripts rather than
    // the prose — the blank-project gate's second arm, the content-level state leak in a tracker
    // startup script, and the exemption table read from where the generator actually puts it. Each
    // was a reproduced defect that no case exercised, which is how it survived with the headline
    // reading 100%.
    ['Covers the gate that refuses when nothing can run', /无可跑脚本|必须失败/i],
    ['Covers mode-aware startup state routing', /不指向被跳过|状态文件/i],
    ['Covers the exemption table in its real location', /豁免表|exemption/i]
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
    const claudeRun = await execFileAsync('node', [script, '--target', claudeDir, '--mode', 'registry']);
    // The absence of AGENTS.md is the invariant; the report naming CLAUDE.md is what proves the
    // choice was made deliberately rather than by never writing an instruction file at all.
    const noSecondFile = !(await exists(path.join(claudeDir, 'AGENTS.md')));
    const choseClaude = /CLAUDE\.md/.test(claudeRun.stdout) && (await exists(path.join(claudeDir, 'CLAUDE.md')));

    agentsDir = await mkdtemp(path.join(os.tmpdir(), 'harness-agentfile-agents-'));
    const existing = '# AGENTS.md\n\n## Agent skills\n\nThird-party block that must survive.\n';
    const agentsPath = path.join(agentsDir, 'AGENTS.md');
    await writeText(agentsPath, existing);
    const agentsRun = await execFileAsync('node', [script, '--target', agentsDir, '--mode', 'registry']);
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

// Stage fifteen: the housekeeping scanner's safety invariants. `scan-housekeeping.mjs` is the one
// script allowed to look at artefacts with deletion in mind, and every guardrail around it lived in
// prose — "扫描器均只读", "不删 done 无 evidence 条目", "--session-ref 不默认 HEAD", "收尾不 prune
// 历史". None had a mechanical carrier, so all four could be reverted in a single commit with every
// gate still green. The failure is asymmetric: a scanner that reports too little gets noticed, a
// scanner that quietly widens its own delete scope does not.
// Both directions are asserted, because a suppression that can never be lifted is its own defect:
// given a ref the scanner MUST be able to identify history (stale) and MUST emit prune candidates;
// without one it must refuse both. Asserting only the refusal would pass a scanner that never prunes
// anything — the "会拦下一切的闸门是最没用的闸门" trap.
async function checkHousekeepingSafety() {
  const fixtures = [];
  const buildFixture = async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'harness-housekeep-'));
    fixtures.push(dir);
    await mkdir(path.join(dir, '.scratch'), { recursive: true });
    await mkdir(path.join(dir, 'scripts', 'deep'), { recursive: true });
    await writeText(path.join(dir, '.scratch', 'old-note.md'), '# Old note\n');
    await writeText(path.join(dir, 'scripts', 'deep', 'tool.mjs'), 'export const v = 1;\n');
    await writeText(path.join(dir, 'feature_list.json'), JSON.stringify({
      features: [
        { id: 'f1', name: 'shipped', status: 'done', evidence: 'npm test passes' },
        { id: 'f2', name: 'noproof', status: 'done' },
        { id: 'f3', name: 'pending', status: 'in_progress' }
      ]
    }, null, 2));
    // The instruction file is a routing doc, not a landing point, so nothing else in this scan
    // would ever look at it. This fixture gives it one dangling exemption row, one live row and an
    // unfilled placeholder, so the report has to tell the two rows apart instead of counting them —
    // a count would also pass on a scanner that flagged every row. The document-entry list gets the
    // same treatment: a compliant entry that exists, one missing its owner annotation, and one whose
    // path is gone — flagging every entry and flagging none must both fail.
    await mkdir(path.join(dir, 'teach-notes'), { recursive: true });
    await mkdir(path.join(dir, 'docs', 'agents'), { recursive: true });
    await writeText(path.join(dir, 'docs', 'live-doc.md'), '# Live doc\n');
    // The exemption table is written where the generator actually puts it: the root file keeps a
    // routing line and the table itself lives in the split-out doc under docs/agents/. This fixture
    // used to inline it as `### 放行豁免清单` in AGENTS.md — a layout create-harness.mjs never
    // produces — so the check stayed green while reading a shape no real harness has, and every
    // generated repo went unscanned. The inline table is kept too, because that is what a
    // hand-merged repo looks like; both rows must be found or the check silently lost a path again.
    await writeText(path.join(dir, 'docs', 'agents', 'tracking-policy.md'), [
      '# 产物追踪策略（分册）',
      '',
      '## 放行豁免清单（由产出 skill 自治理）',
      '',
      '| 路径 | 产出 skill | owner | 性质 / 生命周期 | 用户裁决 | 追踪状态 | 复审触发 |',
      '|---|---|---|---|---|---|---|',
      '| `teach-notes/` | teach | 使用方 | 教学状态 | 原样保留 | ignored | 用户改主意时 |',
      '| `gone-workspace/` | teach | 使用方 | 教学状态 | 原样保留 | ignored | 用户改主意时 |',
      ''
    ].join('\n'));
    await writeText(path.join(dir, 'AGENTS.md'), [
      '# AGENTS.md',
      '',
      '## 启动工作流',
      '',
      '1. **确认工作目录**：运行 `pwd`',
      '',
      '5. **阅读项目文档（如存在）**——长期维护的活文档逐条列出并标出 owner：',
      '   - `docs/live-doc.md`（owner: 架构组）',
      '   - `docs/orphan-doc.md`',
      '   - `docs/gone-doc.md`（owner: 架构组）',
      '',
      '## 工作规则',
      '',
      '- **一次一个功能**：从 `feature_list.json` 挑一个未完成项',
      '- **必须验证**：未运行验证命令前不得声称完成',
      '',
      '## 验证命令',
      '',
      '- `npm test`',
      '',
      '## 产物追踪策略',
      '',
      '- 当前结论：待对齐',
      '',
      '裁决规则、豁免清单与只读探测命令见 `docs/agents/tracking-policy.md`——只在遇到产物落点归属或追踪裁决问题时读。',
      '',
      '### 放行豁免清单（由产出 skill 自治理）',
      '',
      '| 路径 | 产出 skill | owner | 性质 / 生命周期 | 用户裁决 | 追踪状态 | 复审触发 |',
      '|---|---|---|---|---|---|---|',
      '| `inline-gone/` | teach | 使用方 | 教学状态 | 原样保留 | ignored | 用户改主意时 |',
      ''
    ].join('\n'));
    const git = (rest) => execFileAsync('git', rest, { cwd: dir });
    const who = ['-c', 'user.email=bench@local', '-c', 'user.name=bench'];
    await git(['init', '-q']);
    await git([...who, 'add', '-A']);
    await git([...who, 'commit', '-q', '-m', 'fixture']);
    // An uncommitted edit below the repo root. `git status --porcelain` renders it ` M scripts/...`,
    // so the scanner must drop the two status columns AND their separating space. Trimming first
    // eats the separator and shaves the path's leading character, which then reads as "not in this
    // session" — live work marked for deletion because of a whitespace bug.
    await writeText(path.join(dir, 'scripts', 'deep', 'tool.mjs'), 'export const v = 2;\n');
    return dir;
  };

  // .git/ is skipped deliberately: `git status` may rewrite the index, which is git bookkeeping
  // rather than the scanner touching the user's files.
  const snapshot = async (root) => {
    const files = {};
    const walk = async (relative) => {
      for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
        if (entry.name === '.git') continue;
        const child = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory()) await walk(child);
        else files[child] = await readText(path.join(root, child));
      }
    };
    await walk('');
    return files;
  };
  const unchanged = (before, after) => {
    const keys = Object.keys(before);
    return keys.length === Object.keys(after).length && keys.every((key) => after[key] === before[key]);
  };

  const scan = async (dir, extra) => {
    const { stdout } = await execFileAsync('node', [
      path.join(scriptDir, 'scan-housekeeping.mjs'), '--target', dir, '--json', ...extra
    ]);
    return JSON.parse(stdout.slice(stdout.indexOf('{')));
  };

  const scratchState = (report) => report.scratch.find((entry) => entry.path === '.scratch/old-note.md')?.state;
  const DONE_WITH_EVIDENCE = 'f1 shipped';
  const DONE_WITHOUT_EVIDENCE = 'f2 noproof';

  try {
    const arms = [];
    const arm = async (extra) => {
      const dir = await buildFixture();
      const before = await snapshot(dir);
      const report = await scan(dir, extra);
      arms.push({ report, readOnly: unchanged(before, await snapshot(dir)) });
      return report;
    };

    const plain = await arm([]);
    const withRef = await arm(['--session-ref', 'HEAD']);
    const wrapupNoRef = await arm(['--session-only']);
    const wrapupWithRef = await arm(['--session-ref', 'HEAD', '--session-only']);

    const readOnly = arms.every(({ readOnly: ok }) => ok);
    // Without a ref nothing outside uncommitted work is verifiable, and "unverified" must not be
    // rounded up to "stale" — that is the whole distance between reporting and marking for deletion.
    const noRefMeansUnverified = scratchState(plain) === 'unverified' && scratchState(wrapupNoRef) === 'unverified';
    // A ref lifts it, and wrap-up refuses to judge history at all (out-of-scope) — a deliberately
    // different verdict from stale.
    const refMarksHistory = scratchState(withRef) === 'stale' && scratchState(wrapupWithRef) === 'out-of-scope';
    const pruneActive = plain.featureList.prune.includes(DONE_WITH_EVIDENCE)
      && withRef.featureList.prune.includes(DONE_WITH_EVIDENCE);
    const pruneSuppressed = wrapupNoRef.featureList.pruneSuppressed === true
      && wrapupWithRef.featureList.pruneSuppressed === true
      && wrapupNoRef.featureList.prune.length === 0
      && wrapupWithRef.featureList.prune.length === 0;
    // done-without-evidence is never deletable in any mode: the missing evidence is the defect, and
    // deleting the entry would erase the only record of it.
    const noEvidenceNeverPruned = arms.every(({ report }) => !report.featureList.prune.includes(DONE_WITHOUT_EVIDENCE)
      && report.featureList.doneWithoutEvidence.includes(DONE_WITHOUT_EVIDENCE));
    const porcelainPathIntact = [plain, wrapupNoRef].every(
      (report) => report.session.uncommitted.includes('scripts/deep/tool.mjs')
    );
    // The instruction-file health report. Sections must be produced and ranked (a scanner that
    // lists them unordered is not doing the one job this branch exists for), the dangling row must
    // be named while the live one is left alone, and an unfilled placeholder must surface.
    const instruction = plain.instructionFile || {};
    const sections = instruction.sections || [];
    const instructionReported = instruction.name === 'AGENTS.md'
      && sections.length === 4
      && sections.every((item, index) => index === 0 || sections[index - 1].bytes >= item.bytes)
      && instruction.ruleCount === 2;
    // The rows are reported as written (path cell minus its backticks), so the assertion uses the
    // verbatim form rather than a normalised one. Both layouts must be read — the split-out doc the
    // generator actually writes, and an inline table a hand-merged repo has — while the live row in
    // the split-out doc is left alone. Reading only one of the two is the regression that kept this
    // green for as long as it was.
    const danglingExemptions = instruction.danglingExemptions || [];
    const danglingExemptionReported = ['gone-workspace/', 'inline-gone/'].every((row) => danglingExemptions.includes(row))
      && !danglingExemptions.includes('teach-notes/');
    const placeholderReported = (instruction.placeholders || []).includes('待对齐');
    // The document-entry list under 启动工作流: an existing entry must carry an owner annotation, an
    // annotated entry must really exist, and the compliant entry must escape both lists. Naming the
    // wrong file — or every file — fails here.
    const docEntries = instruction.docEntries || {};
    const missingOwner = docEntries.missingOwner || [];
    const danglingDocs = docEntries.dangling || [];
    const docEntryReported = missingOwner.includes('docs/orphan-doc.md')
      && !missingOwner.includes('docs/live-doc.md')
      && !missingOwner.includes('docs/gone-doc.md')
      && danglingDocs.includes('docs/gone-doc.md')
      && !danglingDocs.includes('docs/live-doc.md');

    return {
      pass: readOnly && noRefMeansUnverified && refMarksHistory && pruneActive
        && pruneSuppressed && noEvidenceNeverPruned && porcelainPathIntact
        && instructionReported && danglingExemptionReported && placeholderReported
        && docEntryReported,
      readOnly,
      noRefMeansUnverified,
      refMarksHistory,
      pruneActive,
      pruneSuppressed,
      noEvidenceNeverPruned,
      porcelainPathIntact,
      instructionReported,
      danglingExemptionReported,
      placeholderReported,
      docEntryReported
    };
  } catch (error) {
    return {
      pass: false,
      readOnly: false,
      noRefMeansUnverified: false,
      refMarksHistory: false,
      pruneActive: false,
      pruneSuppressed: false,
      noEvidenceNeverPruned: false,
      porcelainPathIntact: false,
      instructionReported: false,
      danglingExemptionReported: false,
      placeholderReported: false,
      docEntryReported: false,
      error: error.message
    };
  } finally {
    for (const dir of fixtures) await rm(dir, { recursive: true, force: true });
  }
}

// scan-housekeeping.mjs 自己实现了一套模式信号探测，而 harness-utils.mjs 的 trackerMode 是权威版
// （create-harness、validate 与这里的 scoreHarness 都用它）。两套一旦分叉，同一个仓库会收到两份
// 互相矛盾的模式结论，且危害是单向的：registry 仓被报成 tracker 时，扫描器会连带打印「仓内可清
// 的只有 .scratch/」，把用户从 feature_list.json 的 prune 候选上引开——恰是 D4 打掉的那类 wrong-mode。
// 四臂各隔离一条性质，两个方向都断言：只断言「registry 不被误判成 tracker」的话，一个永远只报
// registry 的探测器也能通过（会拦下一切的闸门是最没用的闸门）。
async function checkHousekeepingMode() {
  const fixtures = [];
  const build = async (files) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'harness-mode-'));
    fixtures.push(dir);
    for (const [relative, content] of Object.entries(files)) {
      const full = path.join(dir, relative);
      await mkdir(path.dirname(full), { recursive: true });
      await writeText(full, content);
    }
    return dir;
  };
  const modeOf = async (dir) => {
    const { stdout } = await execFileAsync('node', [
      path.join(scriptDir, 'scan-housekeeping.mjs'), '--target', dir, '--json'
    ]);
    return JSON.parse(stdout.slice(stdout.indexOf('{'))).mode;
  };
  const RULES = '# AGENTS.md\n\n## 工作规则\n\n- **一次一个功能**\n';
  try {
    // ① `.scratch/` 不是信号：一个刚放过草稿、此外什么都没有的仓仍是 registry。
    const scratchIsNotSignal = await modeOf(await build({
      '.scratch/spec.md': '# draft\n',
      'AGENTS.md': RULES
    })) === 'registry';
    // ② 反向：tracker 信号存在且仓内没有注册表时，必须判 tracker。
    const trackerDetected = await modeOf(await build({
      'CONTEXT.md': '# Language\n',
      'AGENTS.md': RULES
    })) === 'tracker';
    // ③ 仓内已有注册表时信号不得推翻它（harness-utils 的 `!featureList` 前置）。
    const registryWins = await modeOf(await build({
      'CONTEXT.md': '# Language\n',
      'feature_list.json': '{"features":[]}\n',
      'AGENTS.md': RULES
    })) === 'registry';
    // ④ 窗口期：骨架刚生成，matt 名下产物尚未延迟创建，唯一证据是 AGENTS.md 里的工单词汇。
    const windowCaseDetected = await modeOf(await build({
      'AGENTS.md': `${RULES}\n状态与依赖由工单系统承接。\n`
    })) === 'tracker';
    return {
      pass: scratchIsNotSignal && trackerDetected && registryWins && windowCaseDetected,
      scratchIsNotSignal,
      trackerDetected,
      registryWins,
      windowCaseDetected
    };
  } catch (error) {
    return {
      pass: false,
      scratchIsNotSignal: false,
      trackerDetected: false,
      registryWins: false,
      windowCaseDetected: false,
      error: error.message
    };
  } finally {
    for (const dir of fixtures) await rm(dir, { recursive: true, force: true });
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
  // Built from SELF_CHECK_REPORT_LINES rather than one hand-written line per gate. Nine of the
  // sixteen groups had drifted out of this report while the comment below kept promising they were
  // here — extraction, tracker, the mode gate, --dry-run, the two generated-file budgets and the
  // scanner's mode reading were console-only, so the artifact a round is reviewed from said nothing
  // about them. Generating the lines from the same list the pass conjunction uses means a new gate
  // cannot be half-carried again.
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
      <p>Scaffolded a throwaway harness and scored it ${report.selfCheck.score}/100, plus an English tracker-mode fixture at ${report.selfCheck.englishScore ?? 0}/100 — confirms the bundled scripts run end-to-end and scoring is bilingual.${coverageLine}${selfCheckLines}${report.selfCheck.error ? ` Error: ${escapeHtml(report.selfCheck.error)}` : ''}</p>
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
