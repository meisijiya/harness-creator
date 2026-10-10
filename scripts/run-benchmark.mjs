#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFileSync, writeSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  FALLBACK_INIT_TEMPLATE,
  NEXT_STEPS,
  bottleneckLabel,
  collectCommandReferences,
  exists,
  formatScoreReport,
  htmlReport,
  initScriptFromCommands,
  loadHarnessFiles,
  NO_VERIFICATION_MARKER,
  normalizeEntryPath,
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
// Rather than trading content for bytes forever, the baseline is the previous stable SKILL.md and the
// allowance runs 15% over it — the same multiplier the generated AGENTS.md gets. The multiplier has
// its own constant because it is the number a user decision moves; the baseline is not. Lowering a
// cap is enforcement of a reduction already agreed; RAISING either number is a scope decision for
// the user, and so is widening this multiplier.
//
// The external comparison, for the record: upstream's SKILL.md is 5188 bytes, and a Chinese rendering
// costs roughly 1.3x more bytes at an equal token count, so this baseline is about 1.4x the
// upstream-equivalent — the difference is the boundary section, the counterexample blacklist and the
// edge-case table, none of which upstream carries.
//
// No spare-byte figure is stated here on purpose: the file moves every session, so any such number is
// stale within a day — and a figure that reads as authoritative enough to mislead a later reader about
// how much room was really left is worse than none. Same reason the README does not restate the gate
// count. Print the live figure from the budget group instead.
const SKILL_MD_BASELINE_BYTES = 10290;
// Raised 1.5 → 1.6 on 2026-10-10, by decision, to pay for seven defects the paired review found and
// this round fixed: the deletion step had lost its 🔴 marker, the no-anchor rule contradicted
// --no-verification, the detail section became unreportable once it moved behind a placeholder, and
// three gate arms could not fail. Each was a real defect; none was padding, and none was recoverable
// by deleting prose — the file had no redundancy left (a逐处 audit cleared 329 B, all of it spent).
// A ceiling that only ever moves down stops being a constraint and starts being an obstacle to
// saying true things, so it is raised deliberately and the reason is recorded here rather than
// inferred from the number moving.
const SKILL_MD_GROWTH = 1.6;
const SKILL_MD_MAX_BYTES = Math.floor(SKILL_MD_BASELINE_BYTES * SKILL_MD_GROWTH);
// The sanity bound travels with the constant instead of repeating it: a check that hardcodes the old
// ceiling would have failed this edit for the wrong reason, or passed it for no reason at all.
const SKILL_MD_GROWTH_CEILING = 1.6;

// The generated instruction file gets the same treatment, for the same reason and with more at
// stake: it is the largest artifact this skill ships into every target repo, and it is read in
// full at every session start. Measured on a default render (no --blueprint, no --commands)
// because the cap must not depend on what a project happens to fill in.
//
// The anchor is EXTERNAL, not a ratchet around whatever this template currently renders at. A cap
// whose floor is the status quo can only ever ratify; this one anchors on the upstream reference
// template (2438 B, 68 lines, ~423 tokens) plus an allowance for CJK encoding — the same file costs
// roughly 1.3x more bytes in Chinese at an equal token count — and lines are capped on the lecture's
// own 50–200 guidance, which is language-neutral where bytes are not. Raising either number is a
// scope decision for the user, not a side effect of the template growing.
const AGENTS_MD_BASELINE_BYTES = 3510;
const AGENTS_MD_MAX_BYTES = Math.floor(AGENTS_MD_BASELINE_BYTES * 1.15);
const AGENTS_MD_MAX_LINES = 90;
// The template states this limit in its own self-restraint rule; the check keeps the statement
// honest, so a 9th rule has to displace something instead of just accumulating. Eight is the point
// where every remaining rule is a brake on the agent (stay in scope, verify before claiming done,
// do not invent entries, do not start work unasked) rather than an assignment of new work — which
// is what this skill is allowed to ship into someone else's repo.
const WORKING_RULES_MAX = 8;
// The detail layer's own ceilings. Separate from the instruction file's because the two answer
// different questions: that file is read in full every session, these are opened only when their
// subject comes up, so a longer document here costs far less than the same bytes there. The caps
// still exist because a detail document that grows without bound stops being the place you open to
// settle a question — it becomes the thing you avoid opening.
const AGENTS_LAYER_MAX_BYTES = 8192;
const AGENTS_LAYER_MAX_LINES = 200;

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
// 'entries' left with the state artifacts. Its whole subject was the shape of feature_list.json —
// that a fresh scaffold ships no project-shaped entries and states the alignment rule first. With
// no registry to inspect, the assertion had nothing left to read, and a group kept alive to inspect
// a file the skill no longer writes is the same "check and template on the same side" defect one
// level up: the gate would be asserting the existence of the thing that was removed.
const SELF_CHECK_GROUPS = [
  'budget', 'agentsBudget', 'agentsDiscover', 'artifactPurity', 'maintenance', 'skillDesign',
  'wrapupOutput', 'dryRun', 'selfRefs', 'references', 'bottleneckTies', 'foreignAudit', 'blankGate',
  'blueprint', 'agentFile', 'initGrowth', 'specLayer', 'agentsLayer', 'nextSteps', 'reportContract', 'taskContract', 'maintContract', 'noDeadDecls', 'gateArgs'
];

// One sentence builder per group, keyed by the same names. The self-check asserts the two sets are
// equal in both directions, so a group without a line (console-only) and a line without a group
// (prose nothing backs) both fail instead of shipping. Each builder gets the group object and must
// return '' for a missing group.
const SELF_CHECK_REPORT_LINES = new Map([
  ['budget', (group) => ` SKILL.md sits at ${group.size}/${group.max} bytes (${group.pass ? 'within' : 'OVER'} budget).`],
  ['agentsBudget', (group) => ` The generated AGENTS.md stays inside its external byte, line and working-rule budgets (${group.pass ? 'verified' : 'FAILED'}).`],
  ['agentsDiscover', (group) => ` The instruction file does not restate what the agent can read for itself, and the detector is proven to have teeth by a seeded violation (${group.pass ? 'verified' : 'FAILED'}).`],
  ['artifactPurity', (group) => ` The generated artifacts carry none of this skill's retired machinery (${group.total} forbidden patterns, ${group.seeded} caught by the seeded violation) and name no external system at all (${group.named.length ? `NAMED ${group.named.join(', ')}` : 'none'}); both detectors are proven per-entry rather than by one blob (${group.pass ? 'verified' : `leaked ${(group.leaked || []).join(', ') || 'none'}; per-entry teeth ${group.perEntryTeeth ? 'ok' : 'BLIND'}; external teeth ${group.externalTeeth ? 'ok' : 'BLIND'}; named in this skill's own --help ${(group.namedInHelp || []).join(', ') || 'none'}; every --help body located ${group.helpBodiesLocated ? 'yes' : 'NO'}`}).`],
  ['maintenance', (group) => ` Harness maintenance has a moment to happen: the generated instruction file tells the agent to optimise the harness at wrap-up when the session's own output leaves it stale or thin, rather than when the harness files happen to have been touched, and the detector is proven to have teeth per term, against the retired diff-keyed sentence, against that sentence wearing the new vocabulary, and against a shortened forbidden list (${group.pass ? 'verified' : `stated ${group.stated ? 'yes' : 'MISSING'}; missing terms ${(group.missing || []).join(', ') || 'none'}; retired phrasing ${(group.leaked || []).length ? `LEAKED (${group.leaked.join(', ')})` : 'absent'}; per-term detector ${group.teeth ? 'has teeth' : 'BLIND'}; old-form rejection ${group.oldFormRejected ? 'honoured' : 'ACCEPTED'}; hybrid form ${group.hybridRejected ? 'rejected' : 'ACCEPTED'}; forbidden-list shrink witness ${group.forbiddenWitness ? 'has teeth' : 'BLIND'}`}).`],
  ['skillDesign', (group) => ` The skill's own design rules are machine-checked rather than trusted to prose: SKILL.md's design section states the wrap-up criterion on the session's own output, and the detector is proven to have teeth per term, against the pre-09-25 rule line, against the old condition wearing the new vocabulary, and against a shortened requirement list (${group.pass ? 'verified' : `stated ${group.stated ? 'yes' : 'MISSING'}; missing terms ${(group.missing || []).join(', ') || 'none'}; diff key ${(group.leaked || []).length ? `LEAKED (${group.leaked.join(', ')})` : 'absent'}; per-term detector ${group.teeth ? 'has teeth' : 'BLIND'}; old rule line ${group.oldFormRejected ? 'rejected' : 'ACCEPTED'}; hybrid form ${group.hybridRejected ? 'rejected' : 'ACCEPTED'}; list-shrink witness ${group.witness ? 'has teeth' : 'BLIND'}`}).`],
  ['wrapupOutput', (group) => ` The wrap-up procedure a maintainer actually reads carries both of its outputs: the candidate changes, and the judgment items that are handed to the user instead of being decided — the part that stops a fresh session from treating already-dead rules as live — plus a net-change report, which is what keeps blind increment from hiding in wording, and SKILL.md's task table promises that net-change report on its own so the promise survives an agent that never opens the reference (${group.pass ? 'verified' : `stated ${group.stated ? 'yes' : 'MISSING'}; missing terms ${(group.missing || []).join(', ') || 'none'}; own section ${group.heading ? 'present' : 'ABSENT'}; per-term detector ${group.teeth ? 'has teeth' : 'BLIND'}; heading requirement ${group.headingArm ? 'has teeth' : 'BLIND'}; witness coverage ${group.witnessCovers ? 'complete' : 'HOLE'}; list-shrink witness ${group.witness ? 'has teeth' : 'BLIND'}; task row ${group.entry && group.entry.row ? (group.entry.stated ? 'stated' : `MISSING (${(group.entry.missing || []).join(', ')})`) : 'NOT FOUND'}; task-row per-term detector ${group.entryTeeth ? 'has teeth' : 'BLIND'}; task-row witness ${group.entryWitness ? 'has teeth' : 'BLIND'}`}).`],
  ['dryRun', (group) => ` --dry-run writes nothing, reports the target's real state, and its plan matches the live run entry for entry (${group.pass ? 'verified' : 'FAILED'}).`],
  ['selfRefs', (group) => ` ${group.checked} shipped file(s) checked for command reachability from a target repo (${group.pass ? 'all runnable' : `relative self-reference in ${(group.offenders || []).join(', ')}`}).`],
  ['references', (group) => ` A documented command that no longer resolves is caught rather than silently trusted, and a check the project defines but the harness never runs is named rather than left green: the audit resolves manifest scripts and runnable files, reports by name what it cannot resolve, and is proven in both directions (${group.pass ? 'verified' : `dangling fixture ${group.danglingCaught ? 'caught' : 'MISSED'}; guarded fixture ${group.guardedExcused ? 'excused' : 'FALSELY FLAGGED'}; unchecked bucket ${group.uncheckedListed ? 'populated' : 'SILENT'}; unwired named ${group.unwiredNamed ? 'ok' : 'MISSED'}; guard retires it ${group.unwiredRetired ? 'ok' : 'NOT RETIRED'}; non-fatal ${group.unwiredNonFatal ? 'ok' : 'FALSELY FATAL'}; uncollected scan ${group.uncollectedRefused ? 'refused' : 'PASSED'}`}).`],
  ['bottleneckTies', (group) => ` The bottleneck line names ${group.tieCount} tied subsystem(s) as a tie instead of picking one (${group.pass ? 'verified' : 'FAILED'}).`],
  ['foreignAudit', (group) => ` A repository the audit did not generate — no init.sh, no gate — cannot collect the static-check or evidence points from the word "TypeScript" or the letters inside "concise", so it no longer ranks its empty verification subsystem above instructions and scope; and a repository that does have a gate still passes both (${group.pass ? 'verified' : `gate-less ${group.bareVerification}/5 vs gated ${group.gatedVerification}/5; static ${group.staticCheckFailed ? 'ok' : 'LEAKED'}; evidence ${group.evidenceFailed ? 'ok' : 'LEAKED'}; entrypoint ${group.entrypointFailed ? 'ok' : 'LEAKED'}; gated static ${group.gatedStaticPasses ? 'ok' : 'BROKEN'}; gated evidence ${group.gatedEvidencePasses ? 'ok' : 'BROKEN'}; not overranked ${group.notOverranked ? 'ok' : 'INVERTED'}; teeth ${group.teeth ? 'ok' : 'BLIND'}`}).`],
  ['blankGate', (group) => ` A project with nothing to verify — no manifest, a manifest with no runnable script, or an explicit --commands list whose scripts the manifest does not define — gets a refusal that exits non-zero instead of reporting a pass it did not earn, the counter reopens the moment a real check runs, a comma inside a quoted command stays one command while a genuine comma-separated list still splits, an unterminated quote is refused leaving nothing behind, and the manual fallback template refuses on the same shapes (${group.pass ? 'verified' : 'FAILED'}).`],
  ['blueprint', (group) => ` The project-description slot stays a visible pending marker when the user has not stated one, while a blueprint change rewrites that slot only — the rest of the file survives byte for byte, and a shape this skill did not render is refused rather than guessed at (${group.pass ? 'verified' : `pending ${group.pendingMarked ? 'ok' : 'NO'}; no stack fill ${group.noInventedFill ? 'ok' : 'NO'}; verbatim ${group.verbatim ? 'ok' : 'NO'}; slot-only ${group.slotRewritten && group.restIntact ? 'ok' : 'NO'}; detector ${group.detectorHasTeeth ? 'has teeth' : 'BLIND'}; refusal ${group.refusalHonoured && group.refusedUntouched ? 'ok' : 'NO'}`}).`],
  ['agentFile', (group) => ` An existing CLAUDE.md is reused instead of having AGENTS.md created beside it, an existing instruction file is left byte-identical while its missing sections are still reported, and --force refuses to render over sections it does not define — the one rule protecting another owner's block, which was prose until it destroyed a fixture — while still overwriting this skill's own render (${group.pass ? 'verified' : `FAILED (foreign block refused: ${group.forceRefused ? 'ok' : 'NO'}; own render rewritten: ${group.forceStillWritesOwn ? 'ok' : 'NO'})`}).`],
  ['initGrowth', (group) => ` The gate only grows: a new check joins an existing init.sh without removing or reordering any step, a repeat is a no-op that leaves the file byte-identical, a check the gate would never actually run — or one that does not parse as shell — is refused and rolled back rather than reported as added, and such a refusal names the command it refused instead of printing a placeholder where the command belongs, a one-line entry reference to a script this repository owns is appended unguarded so a missing entry turns the gate red instead of skipping it, a declared check that did not run turns the gate red instead of printing a notice beside the success tail while a script this manifest does define still gets a real step, every toolchain branch of the hand-copy fallback raises its counter only on the tool's own verdict — so a project whose test suite is empty is refused by name rather than reported as verified — while the same branch stays green on a toolchain that has a test to run, and a gate that went red this session leaves a check behind so the lesson reaches the specification instead of only the fix (${group.pass ? 'verified' : `grew ${group.grew ? 'ok' : 'NO'}; existing steps intact ${group.preserved ? 'ok' : 'NO'}; repeat ${group.idempotent ? 'ok' : 'NO'}; dead-branch check ${group.deadBranchRefused && group.rolledBack ? 'refused and rolled back' : 'ACCEPTED'}; refusal names its command ${group.refusalNamesCommand ? 'ok' : '     '}; name detector ${group.refusalNameHasTeeth ? 'has teeth' : 'BLIND'}; unparseable check ${group.unparseableRefused ? 'refused' : 'ACCEPTED'}; entry appended ${group.entryAppended ? 'ok' : 'NO'}; entry unguarded ${group.entryUnguarded ? 'ok' : 'GUARDED'}; entry repeat ${group.entryIdempotent ? 'ok' : 'NO'}; missing entry ${group.entryMissingRefused ? 'refused' : 'ACCEPTED'}; path rules ${group.entryRulesHaveTeeth ? 'ok' : 'BLIND'}; entry removed turns it red ${group.entryGateFailsWhenUnresolvable ? 'yes' : 'NO'}; skipped declared check ${group.declaredSkipTurnsGateRed ? 'turns it red' : 'NOTICE ONLY'}; its detector ${group.declaredSkipDetectorHasTeeth ? 'has teeth' : 'BLIND'}; declared script ${group.declaredScriptStillRuns ? 'still checked' : 'DROPPED'}; run-it ${group.declaredSkipGateIsRed && group.declaredGateIsGreen ? 'red and green' : 'NOT OBSERVED'}; toolchain branches earn RAN ${group.emptyToolBranchesGuarded ? 'ok' : 'UNGUARDED'}; branch detector ${group.emptyToolBranchesHaveTeeth ? 'has teeth' : 'BLIND'}; empty tool run ${group.emptyToolRunsRed ? 'red' : 'NOT OBSERVED'}; populated tool run ${group.emptyToolRunsGreen ? 'green' : 'NOT OBSERVED'}; that detector ${group.emptyToolGateTeeth ? 'has teeth' : 'BLIND'}; red-gate lesson ${group.loopStated && group.loopIsLoadBearing ? 'recorded' : 'LOST'}; detector teeth ${group.detectorHasTeeth ? 'ok' : 'BLIND'}; no init.sh ${group.missingRefused ? 'refused' : 'ACCEPTED'}`}).`],
  ['specLayer', (group) => ` The spec layer is opt-in and says nothing when it is off: a run without --spec-layer still produces the two artifacts and byte-identical content, the two documents exist only when the flag is given, the detected stack never becomes an answer to "what is this project", they are pointed at as read-on-demand rather than as files every session must open, and the same byte/line/working-rule ceilings still hold with the extra pointer (${group.pass ? 'verified' : `default unchanged ${group.offByDefault ? 'ok' : 'CHANGED'}; flag creates the layer ${group.onCreatesLayer ? 'ok' : 'NO'}; stack kept out of the mission ${group.noStackLeak ? 'ok' : 'LEAKED'}; read on demand ${group.onDemandNotResident ? 'ok' : 'RESIDENT'}; budget ${group.budgetHeld ? 'ok' : 'BUSTED'}; re-run skips ${group.reRunSkips ? 'ok' : 'OVERWROTE'}; flag value ${group.flagValueRefused ? 'refused' : 'ACCEPTED'}; zero coupling ${group.purityHeld ? 'ok' : 'NAMED OR BLIND'}`}).`],
  ['agentsLayer', (group) => ` The instruction file is a router and the detail lives beside it: a default run ships both detail documents with no switch, the instruction file names each of them under its own H3 with a one-line summary, the artifact contract lists them, all three are pointed at as read-on-demand rather than resident, and appending the section to an instruction file another owner wrote leaves that file's existing bytes untouched, survives a third party's block, and is idempotent (${group.pass ? 'verified' : `default ships ${group.defaultShipsLayer ? 'ok' : 'NO'}; navigation ${group.navigationComplete ? 'ok' : 'MISSING'}; artifact contract ${group.artifactsDeclareLayer ? 'ok' : 'MISSING'}; read on demand ${group.onDemandNotResident ? 'ok' : 'RESIDENT'}; append preserves ${group.appendPreserves ? 'ok' : 'REWRITES'}; third party survives ${group.thirdPartySurvives ? 'ok' : 'CLOBBERED'}; idempotent ${group.appendIdempotent ? 'ok' : 'DUPLICATED'}; anchors intact ${group.anchorsIntact ? 'ok' : 'BROKEN'}; budget ${group.layerBudgetHeld ? 'ok' : 'BUSTED'}`}).`],
  ['nextSteps', (group) => ` The gate's closing instructions are one literal with two producers: the generated init.sh, the hand-copy fallback and this repository's own gate all carry the same next-steps block, and it tells the agent to work only on what was explicitly authorized rather than to pick its own next task — a contradiction that was shipping, because the generated gate selected work in the same breath as the instruction file that forbids it (${group.pass ? 'verified' : `generated ${group.generatorAgrees ? 'agrees' : 'DRIFTED'}; fallback ${group.fallbackAgrees ? 'agrees' : 'DRIFTED'}; own gate ${group.ownGateAgrees ? 'agrees' : 'DRIFTED'}; authorizes rather than selects ${group.authorizesRatherThanSelects ? 'ok' : 'SELECTS'}; detector teeth ${group.detectorHasTeeth ? 'ok' : 'BLIND'}`}).`],
  ['reportContract', (group) => ` The report a human reads names the subsystem count the model actually has, and the renderer honours the output path it is given instead of exiting 0 at the default one (${group.pass ? 'verified' : `flag ${group.honouredFlag ? 'honoured' : 'DROPPED'}; contradicting claim ${(group.reported || []).join(', ') || 'none'}; detector ${group.seededCaught ? 'has teeth' : 'BLIND'}`}).`],
  ['taskContract', (group) => ` The instruction file scopes work to what the user authorized: explicit authorization to advance, picking and status updates only while an authorized deliverable is being executed, a baseline failure split into pre-existing versus introduced, a commit gated on the definition of done rather than on a passing check, existing modifications and untracked files protected from any cleanup, and a read-only task that only reports harness drift (${group.pass ? 'verified' : `missing ${(group.missing || []).join(', ') || 'none'}; per-requirement teeth ${group.teeth ? 'ok' : 'BLIND'}; forbidden-list witness ${group.forbidWitness ? 'ok' : 'BLIND'}; old forms ${group.oldFormsRejected ? 'refused' : 'ACCEPTED'}`}).`],
  ['maintContract', (group) => ` A full audit score is not an exit condition in the maintenance reference: the score row still routes to the actual misalignment check, keeps the anti-gaming clause, and the shared content-review table states the read-only, baseline-scope, commit-authorization, existing-work and full-score rules — proven per guard, with the whole table deleted, and by the retired short-circuit row (${group.pass ? 'verified' : `missing ${(group.missing || []).join(', ') || 'none'}; per-guard teeth ${group.teeth ? 'ok' : 'BLIND'}; whole table removed ${group.tableRemovedRefused ? 'refused' : 'ACCEPTED'}; retired row ${group.oldRowRejected ? 'refused' : 'ACCEPTED'}`}).`],
  ['noDeadDecls', (group) => ` This suite carries no orphan: ${group.declaredCount} top-level declarations under scripts/ are all read somewhere in the tree, the ${group.helpEntries} numbered --help entries annotate exactly the ${SELF_CHECK_GROUPS.length} live group keys in both directions, and every flag the generator documents is a flag it reads (${group.pass ? 'verified' : `unread ${(group.dead || []).join(', ') || 'none'}; ghost keys ${(group.ghostKeys || []).join(', ') || 'none'}; groups with no help entry ${(group.missingKeys || []).join(', ') || 'none'}; keys documented twice ${(group.duplicateKeys || []).join(', ') || 'none'}; documented-but-unread flags ${(group.unreadFlags || []).join(', ') || 'none'}; artifact-adding flags missing from SKILL.md ${(group.undocumentedFlags || []).join(', ') || 'none'} (baseline ${group.artifactFlagBaseline} files); lying fixtures ${(group.lyingFlags || []).join(', ') || 'none'}; detector teeth decls ${group.teethDeclarations ? 'ok' : 'BLIND'}, help ${group.teethHelp ? 'ok' : 'BLIND'}, flags ${group.teethFlags ? 'ok' : 'BLIND'}`}).`],
  ['gateArgs', (group) => ` This script's own switches cannot switch it off: a non-numeric --min-score, --min-eval-score or --min-self-check-score is refused before the run starts rather than becoming NaN and turning the comparison permanently false, and --no-self-check is refused rather than skipping the only check that proves the bundled scripts still run — proven by deleting the refusal from a copy of this file in turn, while an explicit --min-score=0 still runs as the deliberate relaxation it is (${group.pass ? 'verified' : `refusal ${group.refusalsCaught}/${group.refusalsTotal}; exit ${group.refusalExits ? 'ok' : 'NO'}; teeth ${group.teethThresholds ? 'ok' : 'BLIND'}/${group.teethSelfCheck ? 'ok' : 'BLIND'}; zero still runs ${group.zeroStillRuns ? 'ok' : 'REFUSED'}; accepted ${(group.accepted || []).join(', ') || 'none'}; misreported ${(group.misreported || []).join(', ') || 'none'}`}).`]
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
// Re-scoped the moment state was delegated, and the re-scoping matters more than the list.
//
// The old patterns forbade `.scratch/`, `docs/agents/`, `ADR` and `CONTEXT.md`, because those were
// the landing points this skill used to hand out. They are now legitimate: they are the upstream
// skills' own artifacts, and naming them IS what the delegation sentence is for. Keeping them
// forbidden would make the detector fire on the correct render — a gate that rejects the outcome
// it was written to produce.
//
// What must never come back is this skill's own removed machinery: its in-repo state files, its
// landing-point doctrine, its controlled-release escape hatch, its mode gate, its extracted
// agent-doc booklets. Those are the parts that assigned work; the neighbours' file names never
// were. Same two-sided shape otherwise: a required statement AND a forbidden one, plus a seed that
// trips every pattern, because "found nothing" is worth nothing from a blind scanner.
//
// Nothing here names a product or a vendor. An earlier list carried a forbidden skill name and an
// "is the owner installed" pattern, both inherited from a version where the render had to name an
// owner; with no owner named there is nothing to forbid by name, and the remaining entries are
// about this skill's own removed machinery rather than about anyone else's.
const FORBIDDEN_IN_AGENTS_MD = [
  { name: 'in-repo state registry', pattern: /feature[-_]list\.json/ },
  { name: 'in-repo progress log', pattern: /progress\.md/ },
  { name: 'landing-point doctrine', pattern: /落点/ },
  { name: 'tracking-policy section', pattern: /产物追踪策略/ },
  { name: 'controlled release', pattern: /受控放行/ },
  { name: 'governance modes', pattern: /两种模式|--mode\b/ },
  { name: 'extracted agent-doc layer', pattern: /tracking-policy\.md|escalation\.md/ },
  // Telling the agent to check whether some other skill is installed, or pointing the user at
  // installing one, is the shape this gate has always refused: availability is the user's and the
  // environment's business, and a generated instruction file that raises it costs a question on
  // every single session to answer a question nobody asked.
  { name: 'installation check', pattern: /未安装时提示安装|提示安装|检查.{0,4}是否已安装/ }
];
const SEEDED_VIOLATION = '\n状态写入 feature_list.json 与 progress.md；产物追踪策略；'
  + '五落点；受控放行；两种模式；分册 tracking-policy.md 与 escalation.md；'
  + '未安装时提示安装。';

// The maintenance trigger's semantics — and why the first version of this gate was not enough.
//
// The wrap-up step used to fire on a DIFF: "this session touched the instruction file, init.sh or the
// working rules". That makes the trigger self-referential. Re-assessment can only happen where a
// change already happened, so a session that exposes staleness without opening the file — a command
// that no longer works, a convention agreed in passing, a gotcha worth a working rule — never reaches
// the pass that would fix it. Harness rot is silent by construction ("harness 不会腐化出声"), which
// is exactly why a trigger keyed on "was it touched" cannot see it. The trigger now keys on the
// session's OUTPUT: did this session produce something that leaves the instruction file, init.sh or
// the working rules stale or thin? "Nothing to change" is a legitimate outcome, so this does not
// license churn; it removes the circularity.
//
// The old gate asserted only that the skill NAME appeared in the wrap-up section. The diff-keyed
// sentence named harness-creator too, so that gate had ZERO coverage of the semantics it appeared to
// guard — it stayed green across the very rewrite it should have demanded. Terms are all-of, never
// any-of: `structuredHas` is `.some()` and cannot express a conjunction, so the predicate is written
// out. Each term is load-bearing and proven individually (per-term arm in checkMaintenanceTrigger),
// and the negative arm requires the OLD diff-keyed sentence to be REJECTED, so a render cannot satisfy
// the gate on vocabulary alone.
//
// Declared here, ahead of the runSelfCheck() call site (line 343), for the temporal-dead-zone reason
// this file has already paid for three times.
const MAINTENANCE_TERMS = ['会话产出', '按需优化', 'harness-creator'];
// Verbatim from `templates/agents.md` as it stood before 09-25. It is the negative arm's fixture now;
// nothing renders it any more, so it must not be kept in sync with the template.
const MAINTENANCE_OLD_FORM = '3. **长任务收口后复盘 harness**：本次会话改过本文件、`init.sh` 或工作规则时，'
  + '用 **harness-creator** 重新评估';
// The negative half, mirroring SKILL_DESIGN_FORBIDDEN. Without it the predicate is a pure all-of, so
// the diff-keyed sentence this gate replaced can be re-landed with the new vocabulary bolted on and
// the gate stays green — measured on such a hybrid render, which reported PASS. MAINTENANCE_OLD_FORM
// is a separate literal fixture, so `oldFormRejected` proves the old SENTENCE ALONE is refused; it
// says nothing about a render carrying both. Neither phrase occurs in the current render, so this
// axis costs no false positives.
const MAINTENANCE_FORBIDDEN = ['本次会话改过本文件', '长任务收口后复盘'];
// Hand-written witnesses for MAINTENANCE_FORBIDDEN, and the reason they are written out rather than
// derived from it: a loop over that list cannot notice a phrase being DROPPED from it — it simply
// stops testing that phrase, and every arm stays green. Each form carries all three required terms
// (so it satisfies the positive side on its own) plus exactly one forbidden phrase, and is refused
// only if that phrase is genuinely still listed.
const MAINTENANCE_FORBIDDEN_FORMS = [
  ['本次会话改过本文件',
    '## 会话结束\n\n3. **按会话产出按需优化**：本次会话改过本文件时用 **harness-creator** 重新评估\n'],
  ['长任务收口后复盘',
    '## 会话结束\n\n3. **长任务收口后复盘**：按会话产出用 **harness-creator** 按需优化\n']
];
// Section-scoped rather than whole-file on purpose — the skill name appears in the delegation
// section too, so a file-wide match would stay green after the wrap-up step was deleted, and a
// file-wide strip would remove the copy that does not matter. Declared HERE, not next to the
// functions that use it: those run from inside runSelfCheck(), which is invoked at line 343, so a
// const sitting beside them is still in its temporal dead zone when first read. This file has paid
// for that mistake four times now, always with the same symptom — a FAIL that looks like a missing
// feature rather than an uninitialised binding.
const maintenanceSection = (text) =>
  text.split(/^##\s+/m).slice(1).find((part) => part.startsWith('会话结束')) || '';

function maintenanceTriggerStated(text) {
  const section = maintenanceSection(text);
  const missing = MAINTENANCE_TERMS.filter((term) => !section.includes(term));
  const leaked = MAINTENANCE_FORBIDDEN.filter((phrase) => section.includes(phrase));
  return { stated: missing.length === 0 && leaked.length === 0, missing, leaked };
}

// The suite mostly reads the artifact a target repo receives, but SKILL.md itself is read in five
// places: a byte count (checkSkillBudget), the `--spec-layer` literal (ARTIFACT_ADDING_FLAGS), the
// 设计规则 term set (SKILL_DESIGN_TERMS), the 更新 row of the task table (WRAPUP_SKILL_ENTRY_TERMS),
// and a path-shape scan (checkSelfReferencePaths). Three of those assert words, so prose edits are
// not free.
// Measured 09-25: deleting the wrap-up rule outright still yielded Self-check PASS and eval 100/100,
// and the bytes freed by the deletion made the budget line GREENER — the cap has only a ceiling, no
// floor, so dropping a rule is rewarded. A rule that decides whether the skill is ever invoked
// again cannot rest on that: the same failure mode as "a rule with no mechanical carrier loses to
// one successful wrong action", one level up — here it is the skill's own body that had no carrier.
//
// Scoped to the 设计规则 section, and to the one rule in it that nothing else covers. The neighbours
// already have carriers — "keep the instruction file short" is enforced against the render by
// checkAgentFileBudget and checkAgentFileDiscoverability, "verification commands must be runnable"
// by checkBlankProjectGate and checkSelfReferencePaths — so asserting them here would put a second
// gate on the same invariant. The wrap-up rule is the one with nothing underneath it.
//
// Two-sided on purpose, because either side alone is satisfied by a degenerate file: the criterion
// must be PRESENT and the diff key it replaced must be ABSENT. The old rule (94af583) shared its
// scope wording with the new one verbatim — both say 本技能所管的文件 — and differed only in what
// triggered it, so the discriminating term is the criterion, not the scope. The absent-arm closes
// the hole that an all-of check otherwise leaves open: new vocabulary bolted onto the old condition
// satisfies a terms-only predicate, which is exactly what the maintenance gate's comment promises to
// prevent and its arms do not. Declared here, ahead of the runSelfCheck() call site, for the
// temporal-dead-zone reason this file has now paid for four times.
const SKILL_DESIGN_TERMS = ['收尾', '按会话产出', '本技能所管的文件', '不是命令队列'];
// Verbatim from SKILL.md at 94af583, the last release before the 09-25 ruling. Fixture for the
// negative arm only; nothing renders it any more, so it must not be kept in sync with SKILL.md.
const SKILL_DESIGN_OLD_FORM = '- 收尾只作用于**本技能所管的文件**中本会话改动的部分，不做全仓审计；'
  + '跨会话交接由用户调用 `handoff` 产生——本技能不创建、也不管其文档。';
// One phrase, not a list: a prohibition no fixture witnesses is a prohibition that can be narrowed
// silently. This is the diff key as it actually stood in the design section before 09-25.
const SKILL_DESIGN_FORBIDDEN = ['本会话改动的部分'];
// Independent witness for SKILL_DESIGN_TERMS, and the reason it is written out by hand rather than
// derived from the list above: a loop over SKILL_DESIGN_TERMS cannot notice a term being DROPPED from
// that list — it simply stops testing that term, and every arm stays green. Measured, not imagined:
// probe arm 8 removed 按会话产出 from the list with SKILL.md untouched and the gate came back PASS.
// (The old-form fixture cannot cover this either: it is refused by the forbidden phrase as well, so
// its verdict is indifferent to which terms are required. That claim was in this comment until the
// arm disproved it.) Each entry below is the shipped rule with exactly one term deleted, so it is
// refused if and only if that term is genuinely required — the names appear twice, on purpose.
const SKILL_DESIGN_INCOMPLETE_FORMS = [
  ['收尾', '- ＝按会话产出按需优化**本技能所管的文件**（指令文件、`init.sh`、工作规则）。'],
  ['按会话产出', '- 收尾＝按需优化**本技能所管的文件**（指令文件、`init.sh`、工作规则）。'],
  ['本技能所管的文件', '- 收尾＝按会话产出按需优化（指令文件、`init.sh`、工作规则）。'],
  // The command-queue rule. It is here for the same reason as the three above: without a hand-written
  // witness, deleting `不是命令队列` from SKILL_DESIGN_TERMS would silently stop testing it while every
  // arm stayed green. The witness is the shipped line with that one phrase removed, so it is refused if
  // and only if the phrase is genuinely required.
  ['不是命令队列', '- 已记录的清单是上下文：本技能与生成物都不自行选活，推进哪一条需本次显式授权。']
];
// Section-scoped rather than whole-file: the old wording is still quoted on purpose in the
// maintenance reference and the README as a counter-example, and a file-wide arm would flag that
// deliberate prose. Declared HERE, not beside the functions that use it — those run from inside
// runSelfCheck(), so a const sitting next to them is still in its temporal dead zone when read.
const skillDesignSection = (text) =>
  text.split(/^##\s+/m).slice(1).find((part) => part.startsWith('设计规则')) || '';

// The wrap-up procedure lives in references/harness-maintenance-pattern.md, and until 09-25 nothing
// asserted a word of it — the reference is read only while the skill is doing maintenance, so a step
// going missing there degrades behaviour with no symptom anywhere. Two things were added to it by
// user ruling, and both are the difference between maintaining a harness and merely growing one:
//
//   * the wrap-up produces TWO lists — candidate changes, and the items that only the user can judge
//     (a rule that is no longer necessary, a passage superseded upstream, duplicated wording). The
//     judgment list is what stops a new session from treating already-dead rules as live; it is also
//     the part no tool can settle, so it is handed over rather than decided.
//   * the re-check reports the NET change, not only what was edited — otherwise blind increment is
//     hidden in wording, and nobody can tell whether the harness is being refined or just accrued.
//
// Scoped to the whole file rather than to the 步骤 section: the procedure is stated in more than one
// place on purpose (the requirement in 步骤, the boundary in its own section, the empty case in the
// exception table), and a reader arriving at any of them should find it. The heading is asserted
// separately, because "one more sentence somewhere" and "a place for it" are different guarantees.
const WRAPUP_REFERENCE = path.join('references', 'harness-maintenance-pattern.md');
const WRAPUP_JUDGMENT_TERM = '需你判断';
const WRAPUP_TERMS = ['需你判断', '净增', '净减'];
// Independent witnesses for WRAPUP_TERMS, hand-written rather than derived, for the reason measured
// on the skillDesign gate: a loop over the term list cannot notice a term being DROPPED from the
// list, because it simply stops testing it. Each entry is a plausible shortened version of the
// reference that is missing exactly one term, so it is refused by that term and no other.
const WRAPUP_INCOMPLETE_FORMS = [
  ['需你判断', '## 候选改动\n\n本次收尾只产出候选改动，复验时报出净增与净减的行数。\n'],
  ['净增', `## ${WRAPUP_JUDGMENT_TERM}\n\n工具判不了的交回用户。复验时报出净减的行数。\n`],
  ['净减', `## ${WRAPUP_JUDGMENT_TERM}\n\n工具判不了的交回用户。复验时报出净增的行数。\n`]
];
// Holds every term and still fails, because the place to put judgment items is gone: the vocabulary
// survived a revert that removed the section it belonged to. Written as an independent literal so the
// heading requirement is proven to bite rather than assumed from a regex that may match nothing.
const WRAPUP_HEADING_LESS_FORM = `## 候选改动\n\n需你判断的项交回用户，复验时报出净增与净减的行数。\n`;

// SKILL.md's own task table is the one version of the wrap-up every reader is guaranteed to meet — the
// reference is opened by an agent that has already decided to go maintain. Until 10-08 the 更新 row
// promised the candidate list and the judgment list and said nothing about the net-change report, so an
// agent working straight from the table inherited every habit except the one that makes blind increment
// visible. Keyed on the task name rather than the row number: reordering the table does not break the
// promise, so a renumbering must not read as a regression.
const WRAPUP_SKILL_ENTRY_TERMS = ['净增', '净减'];
const WRAPUP_SKILL_ENTRY_ROW = /^\|[^|\n]*\|[^|\n]*更新[^|\n]*\|([^|\n]*)\|/m;
// Hand-written, for the reason WRAPUP_INCOMPLETE_FORMS carries: a loop over the term list cannot notice a
// term being dropped FROM the list, because it simply stops testing it. Each form keeps the row's shape
// and every other promise the row makes, and is missing exactly one term.
const WRAPUP_SKILL_ENTRY_INCOMPLETE = [
  ['净增', '| 4 | 更新 | 目标仓路径 → 候选改动清单 + 需你判断清单，🔴 获批后落地候选改动，复验并报净减 |'],
  ['净减', '| 4 | 更新 | 目标仓路径 → 候选改动清单 + 需你判断清单，🔴 获批后落地候选改动，复验并报净增 |']
];

// Set equality between a required-term list and the keys of a hand-written witness table. BOTH
// directions matter and one-way containment is the trap: it passes on a table that has quietly lost its
// weakest member, and that member is exactly the one nobody notices is gone. Found the hard way on
// 10-08 — the task-row witness was guarded this way while the older reference-side one was not, and
// deleting a row from that older table left every gate green. Declared up here with the other wrap-up
// constants, ahead of the runSelfCheck() call site, for the temporal-dead-zone reason at line 347.
const sameTermSet = (terms, witnessRows) =>
  witnessRows.map(([term]) => term).sort().join('|') === [...terms].sort().join('|');

// Declared at module scope, ahead of the runSelfCheck() call: a const sitting next to the function
// that reads it would still be in its temporal dead zone at that call site.
// Two exemptions, each for a file whose relative `node scripts/…` invocation is the correct one
// rather than a stray one: README.md carries the contributor's "run it from the repo root" command,
// and check-links.mjs prints its own invocation in its --help usage line — the string the gate it
// belongs to is told to run. Removing either string to satisfy the detector would delete the only
// place a reader learns how to start the script. Both are still scanned by everything else.
const SELFTEXT_EXEMPT = new Set(['README.md', 'scripts/check-links.mjs']);
const RELATIVE_SELF_REFERENCE = /(?:node\s+scripts\/[a-z0-9-]+\.mjs|skills\/harness-creator\/scripts\/)/;

// A path relative to the SKILL repository (e.g. a bare `skills/<skill-name>/...` prefix) is
// dead on arrival in a target repo: the generated AGENTS.md is read by an agent whose cwd is
// that repo, and the skill lives in the runtime's skills directory instead. A concrete path
// would be worse still — the runtime path varies, so the emitted form is a by-name reference
// the agent can resolve. Excludes `~/.agents/skills/...`, where `skills/` is not path-initial.
// Declared up here, not next to its user below: a const accessed from a function invoked by the
// top-level flow would still be in the TDZ.
const SKILL_RELATIVE_PATH = /(^|[^/\w.~])skills\/[a-z0-9][a-z0-9-]*\//im;

// The report is the artifact a human reads, so a subsystem count inside it is a claim about the
// model, not a turn of phrase. This skill shrank the harness to three subsystems and the rendered
// report went on announcing five, which is the one contradiction a reader can grep for directly.
// Matched as a word before the hyphen so the only pass is "three"; a claim of any other count fails.
// Declared up here, ahead of the runSelfCheck() call site, for the temporal-dead-zone reason above.
const SUBSYSTEM_COUNT = 'three';
const SUBSYSTEM_CLAIM = /\b(one|two|three|four|five|six|seven|eight|nine|ten)-subsystem\b/gi;

// The console is a fourth place a group has to appear, and it was the one place nothing checked.
// A group could be computed, join the pass conjunction and reach the shareable report while being
// absent from the console a human actually reads — the same half-carrier defect the report-coverage
// check closes, from the other side. It was not hypothetical: a group shipped with a report line and
// no console line, and every existing guard stayed green, because the console block is hand-written
// and its lines carry per-group detail. The block is now rendered by consoleSelfCheckLines() and the
// labels in this map are asserted against SELF_CHECK_GROUPS, so a new group has to declare its
// console label or the coverage check names it. Declared ahead of the runSelfCheck() call site, for
// the temporal-dead-zone reason recorded above: this map is read from a function that the top-level
// flow already invoked by then.
const CONSOLE_GROUP_LABELS = new Map([
  ['budget', 'SKILL.md budget'],
  ['agentsBudget', 'AGENTS.md budget'],
  ['agentsDiscover', 'AGENTS.md discoverability'],
  ['artifactPurity', 'Artifact purity'],
  ['maintenance', 'Maintenance trigger'],
  ['skillDesign', 'SKILL.md design rule'],
  ['wrapupOutput', 'Wrap-up outputs'],
  ['dryRun', 'Dry run'],
  ['selfRefs', 'Self-reference paths'],
  ['references', 'Command references'],
  ['bottleneckTies', 'Bottleneck ties'],
  ['foreignAudit', 'Foreign-repo audit'],
  ['blankGate', 'Blank-project gate'],
  ['blueprint', 'Blueprint slot'],
  ['agentFile', 'Agent-file invariant'],
  ['initGrowth', 'init.sh growth'],
  ['specLayer', 'Spec layer'],
  ['agentsLayer', 'Detail layer'],
  ['nextSteps', 'Next-steps agreement'],
  ['reportContract', 'Report contract'],
  ['taskContract', 'Task authorization'],
  ['maintContract', 'Maintenance contract'],
  ['noDeadDecls', 'Orphan declarations'],
  ['gateArgs', 'Gate switches']
]);





// ── Task-authorization contract, read off both rendered instruction files ──────────────────
// Both tiers state the same task conditions, and none of them had a carrier before 09-29: "fix the
// baseline first", "pick exactly one ticket", "commit when it is safe" and "leave a clean state" each
// read as a standing instruction to widen the repair, pick work, commit unasked, or clear someone
// else's changes. Requirements name the SHAPE of a claim, never a whole sentence: these files are
// prose that keeps getting reworded, and a gate keyed to one sentence fails on a harmless rewrite
// while passing on a render that dropped the clause it protects. Units are per LINE (a rule is one
// bullet) and, for a condition on one instruction, per CLAUSE — the only reading in which "仅在…时，
// 更新其状态" passes while an unconditional "更新其状态" beside it fails.
const AUTHORIZATION_RULE = ['显式授权', '明确要求', '显式要求', '明确授权', '只推进'];
const PICK_AUTHORIZATION = ['授权', '明确要求', '显式要求', '用户要求', '经用户'];
// How these two tiers word a condition, and nothing wider. The bare 不 / 未 this list used to carry
// were an F1 hole: in "不新建分支，直接提交所有改动" the negation governs the branch, not the commit,
// so a negation about something else exempted an unconditional commit. Condition-introducers scope
// the clause they appear in; the negation group is bound to the very actions this contract checks, so
// it cannot be borrowed by a neighbouring object.
//
// What this buys, stated plainly: the `some` side of a requirement only proves the rule is PRESENT — a
// render can satisfy "advancing needs explicit authorization" with one sentence that governs nothing.
// The forbid rows freeze the retired sentences this suite has actually observed. Neither is a proof
// that arbitrary prose is semantically safe, and these regexes accept the limited phrasings these
// templates use rather than parsing Chinese; a reworded contract outside this vocabulary has to fail
// and be re-registered, which is the intended direction to fail in.
const CONDITION_INTRODUCERS = ['若', '只有', '仅在', '仅当', '除非', '经用户'];
const COMMIT_CONDITION = [...CONDITION_INTRODUCERS, '不提交'];
const STATUS_CONDITION = [...CONDITION_INTRODUCERS, '不更新', '不改状态', '不标记'];
const QA = /问答|只读|解释|咨询|审计|评审/;
const WORK_NOUN = ['工单', '交付物', '任务', '状态', '记录'];
const PICK_VERB = ['挑', '领', '选', '取'];
const NEGATION = ['不', '非', '勿', '不得', '无需'];
const PROTECTED = ['已有修改', '既有修改', '未跟踪', '他人的', '别人的'];
const DESTRUCTIVE = ['覆盖', '回退', '删除', '丢弃', '清理'];
// Docs describing the present, in whatever phrasing the templates use. Each group holds
// interchangeable alternatives on purpose: withoutTerms deletes all of them, so a requirement stays
// honest while a render is free to say 只写现状 instead of 只描述当前状态.
const DOC_PRESENT = ['只描述当前状态', '只写当前状态', '只描述现状', '按当前状态写'];
const DOC_NO_HISTORY = ['不追加变更历史', '不记录变更历史', '不留变更历史', '不写变更历史'];

// One row per rule the entry-path validator claims to enforce, each naming the rule it stands for.
// Held as a literal rather than derived from the source on purpose: a fixture list built by asking
// the validator what it refuses would agree with the validator by construction, and deleting a rule
// would delete the row that would have noticed. Rows come in both directions because "refuses
// everything" and "refuses nothing" each satisfy half the table on their own.
const ENTRY_PATH_FIXTURES = [
  { input: '', why: 'empty', refuse: true },
  { input: '   ', why: 'whitespace only', refuse: true },
  { input: '/etc/verify.sh', why: 'absolute posix', refuse: true },
  { input: 'C:/tmp/verify.sh', why: 'absolute drive', refuse: true },
  { input: '../verify.sh', why: 'leaves the repository', refuse: true },
  { input: './a/../../verify.sh', why: 'escapes by a later segment', refuse: true },
  { input: './my verify.sh', why: 'shell would split it', refuse: true },
  { input: './a;b.sh', why: 'command separator', refuse: true },
  { input: './a$b.sh', why: 'variable expansion', refuse: true },
  { input: './a*.sh', why: 'glob', refuse: true },
  { input: './a`b`.sh', why: 'command substitution', refuse: true },
  { input: './verify.sh', why: 'the ordinary case', refuse: false },
  { input: 'verify.sh', why: 'bare name normalises', refuse: false },
  { input: './scripts/verify.sh', why: 'nested inside the repo', refuse: false },
  { input: 'tools/check-all.sh', why: 'no ./ prefix needed', refuse: false }
];
// The commit precondition is the PROJECT'S OWN definition of done, never a passing check: a plain
// project may legitimately declare that it has nothing to run, and demanding a pass there either
// blocks committing forever or invites claiming one that never happened — treating a declaration as a
// test result. 完成定义 stays satisfiable either way, because under the waiver it resolves to the
// disclosure the definition of done itself states.
const COMMIT_DONE = ['完成定义已满足', '完成定义'];
const COMMIT_SCOPE = ['本次相关', '本次改动', '本次变更', '本次涉及'];
// "查看最近提交：运行 git log" reads commits; it does not instruct making one.
const COMMIT_READER = /查看最近提交|最近提交|git log/;
// Verbatim from both templates before 09-29. If a run reports one as present, the render regressed.
const BASELINE_FIX_OLD = '如果基线验证失败，先修复它，再添加新的工作范围。';
const CLEAN_STATE_OLD = '留下干净状态';
const WRAPUP_OLD_STEP = '候选改动列出后落地；不做全仓审计';

const TASK_CONTRACT = [
  { name: 'advancing needs explicit authorization', kind: 'line', anchor: /推进|授权/, groups: [AUTHORIZATION_RULE] },
  { name: 'records are context, not a queue', kind: 'line', anchor: /待办/, groups: [['不是待办队列', '不是自动待办队列', '不是待办']] },
  { name: 'picking the next item needs authorization', kind: 'line', anchor: /工单|交付物/, groups: [PICK_AUTHORIZATION] },
  { name: 'questions and read-only reviews pick nothing', kind: 'line', anchor: QA, groups: [PICK_VERB, NEGATION, WORK_NOUN] },
  { name: 'questions and read-only reviews update no status', kind: 'line', anchor: QA, groups: [['更新', '状态', '标为', '关闭'], NEGATION] },
  // Anchored on the update VERB, not on 状态: "状态与依赖" and "状态与交接" are headings and noun
  // phrases in both tiers, and a clause-wide test on 状态 refuses a correct file.
  { name: 'a status update is conditional', kind: 'everyClause', anchor: /更新|标为|标记为|关闭/, groups: [STATUS_CONDITION] },
  { name: 'baseline failures are triaged', kind: 'line', anchor: /基线/, groups: [['原有', '既有', '先前', '之前就', '已存在'], ['本次引入', '本次新增', '本次改动', '本次修改', '本次会话'], ['授权范围', '不扩大', '不擅自', '不接管', '只修', '仅修', '阻塞', '交回用户', '问用户']] },
  { name: 'no unconditional baseline fix', kind: 'forbid', literals: [BASELINE_FIX_OLD] },
  { name: 'a commit is gated on the definition of done', kind: 'clause', anchor: /提交/, exclude: COMMIT_READER, groups: [AUTHORIZATION_RULE, COMMIT_DONE, COMMIT_SCOPE] },
  { name: 'no unconditional commit instruction', kind: 'everyClause', anchor: /提交/, exclude: COMMIT_READER, groups: [COMMIT_CONDITION] },
  { name: 'existing work is protected', kind: 'line', anchor: /保护|已有修改|未跟踪|他人的/, groups: [PROTECTED, DESTRUCTIVE] },
  { name: 'docs state the present, not the change log', kind: 'line', anchor: /文档|说明|注释/, groups: [DOC_PRESENT, DOC_NO_HISTORY] },
  { name: 'harness drift lands inside the authorized scope', kind: 'line', anchor: /候选改动/, groups: [['授权范围', '授权', '本次范围']] },
  // The wrap-up trigger fires on what the session EXPOSED, and a review session exposes plenty
  // without being authorized to change anything: "列出后落地" turned a question into an edit.
  { name: 'a read-only task only reports', kind: 'clause', anchor: /只读/, groups: [['只报告', '仅报告', '只如实报告', '只报']] },
  // Evidence that names a command and its output answers "what ran"; it cannot answer "which
  // version did it run against", which is the question a reader of a record from last week has.
  // Section-scoped so the completion checklist cannot stand in for the rule, and ONE group rather
  // than two: everyClause would demand the anchor from the rule's own title clause ("必须验证、证据
  // 先行"), which names evidence without ever asserting anything about it. A single group fails
  // when EITHER half is gone, which is the defect being guarded — a line carrying "Evidence anchor:"
  // but no commit, or a commit with no anchor, is the same record that cannot say what it verified.
  { name: 'evidence names the commit it ran against', kind: 'line', anchor: /证据|Evidence/, section: '工作规则', groups: [['Evidence anchor:', 'commit 锚', 'commit 锚点', '锚点']] },
  { name: 'no clean-state framing', kind: 'forbid', literals: [CLEAN_STATE_OLD] }
];
// The sentence each requirement replaced, and the requirement that sentence must FAIL. A fixture that
// stops tripping its requirement is a gate that has stopped biting.
const TASK_OLD_FORMS = [
  ['picking the next item needs authorization', '从 tracker 中恰好挑一个未完成、且阻塞边已全部清空的工单；不修改与它无关的文件'],
  ['questions and read-only reviews pick nothing', '问答与只读审查也按 tracker 挑一个未完成工单'],
  ['questions and read-only reviews update no status', '问答与只读审查同样在 tracker 更新工单状态'],
  ['a status update is conditional', '在 tracker 中更新本会话推进的工单状态与证据'],
  // Same-line pair: a correctly conditioned clause excusing an unconditional one beside it. This is
  // the shape the line-scoped 'every*' kinds used to accept, and it is why those kinds split clauses.
  ['a status update is conditional', '仅在用户要求时更新工单状态；无工单也更新工单状态'],
  ['baseline failures are triaged', BASELINE_FIX_OLD],
  ['no unconditional baseline fix', BASELINE_FIX_OLD],
  ['a commit is gated on the definition of done', '仅在用户明确要求提交且验证通过时，用描述性消息提交本次相关改动'],
  ['no unconditional commit instruction', '工作处于安全状态后，用描述性消息提交'],
  ['no unconditional commit instruction', '仅在用户明确要求提交且完成定义已满足时提交本次相关改动；否则也用描述性消息提交'],
  // F1: an unrelated negation must not exempt the checked action. Both clauses instruct an
  // unconditional commit; the negation in each governs something else entirely — a branch, a ticket.
  ['no unconditional commit instruction', '- 不新建分支，直接提交所有改动'],
  ['no unconditional commit instruction', '- 未完成工单，直接提交所有改动'],
  ['no unconditional commit instruction', '- 不更新状态，直接提交所有改动'],
  ['no unconditional commit instruction', '- 不写入记录，直接提交所有改动'],
  ['a status update is conditional', '- 不提交改动，直接更新工单状态'],
  ['existing work is protected', `- **${CLEAN_STATE_OLD}**：下次会话必须能立即运行 \`./init.sh\``],
  ['docs state the present, not the change log', '更新文档时记录本次修改，并保留旧方案作为对照'],
  ['harness drift lands inside the authorized scope', WRAPUP_OLD_STEP],
  ['a read-only task only reports', WRAPUP_OLD_STEP],
  // The sentence this requirement replaced: it asked for a record and stopped there. Verbatim from
  // the template before the anchor existed, so a render that regressed to it is caught by the arm
  // that has to FAIL rather than by the one that must pass.
  ['evidence names the commit it ran against', '命令与结果摘要或 CI 链接记入本项目已有的记录位置'],
  ['no clean-state framing', `- **${CLEAN_STATE_OLD}**：下次会话必须能立即运行 \`./init.sh\``]
];

// The maintenance reference's exception table used to read "审计已满分 | 报「无候选瓶颈」，不改",
// making a structural score an exit condition — harness rot is invisible to scoring (the file's own
// line 3 says so), so a full score is exactly when the content still has to be read. The row now
// routes to the actual misalignment check and keeps the anti-gaming clause, and the shared
// content-review table carries the same task conditions the templates do.
const MAINT_MISALIGNMENT = ['失准'];
const MAINT_ANTI_GAMING = ['堆关键词', '刷分'];
const MAINT_SCORE_ROW = 'a full score still reviews actual misalignment';
const MAINT_GUARDS = [
  { name: 'a read-only request picks nothing', anchor: /问答|只读/, terms: ['不挑', '不更新', '不选', '不领'] },
  { name: 'baseline scope outside the run is reported', anchor: /基线/, terms: ['区分', '原有', '本次'] },
  { name: 'commit needs authorization', anchor: /提交/, terms: ['授权', '用户'] },
  { name: 'existing work survives a commit decision', anchor: /已有修改|未跟踪|既有工作|保留修改/, terms: ['保留', '保护', '不覆盖', '不回退', '不删'] },
  { name: 'a full score still reviews content', anchor: /满分/, terms: ['内容复核'] },
  { name: 'misalignment exposed but unedited still yields candidates', anchor: /失准/, terms: ['维护候选', '有证据'] },
  // A deletion is the one maintenance edit that removes a brake, and "I deleted 3 lines and net is
  // -3" is not evidence that nothing depended on them. The three terms are what makes the claim
  // falsifiable: the same task run before and after, and the difference reported.
  //
  // The anchor is the ACTION column's own phrasing, not the word 删除: anyOf reads the whole table
  // row, so a mention in the right-hand "what to check" column would satisfy the guard on its own —
  // which is how this guard passed with its instruction rewritten to nothing. Anchoring on 先跑 A/B
  // means only the action column can carry the requirement.
  { name: 'deletions carry A/B evidence', anchor: /先跑 A\/B/, terms: ['前后', '对照', '删前删后'] },
  // The spec layer carries project facts that rot silently: the audit reads neither document, so a
  // stale mission cannot make a FAIL line appear. It has to be reachable from the wrap-up candidate
  // list, and the action is a hand edit — regenerating is what --spec-layer's skip-if-exists exists
  // to prevent, and --force would overwrite the project's own wording. Same shape as the row above:
  // the anchor is the ACTION column's phrasing, not the word 规范层, so a mention in the "检查对象"
  // column cannot satisfy the guard while the action stayed empty.
  { name: 'stale spec-layer facts reach the candidate list', anchor: /列入维护候选/, terms: ['不重跑生成器'] }
];
const MAINT_OLD_ROW = '| 审计已满分 | 报「无候选瓶颈」，不改；为刷分堆关键词是反模式 |';

// Headings are dropped: "## 状态与交接" is a title, not an instruction. A missing section reads as
// empty, so a requirement scoped to it fails rather than passing on a file that deleted the heading.
const linesOf = (text) => String(text).split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
const clausesOf = (text) => linesOf(text).flatMap((line) => line.split(/[；;。]/)).map((clause) => clause.trim()).filter(Boolean);
const sectionText = (text, heading) => (heading ? (text.split(/^##\s+/m).slice(1).find((part) => part.startsWith(heading)) || '') : text);
const anyOf = (unit, terms) => terms.some((term) => unit.includes(term));
const allGroups = (unit, groups) => groups.every((group) => anyOf(unit, group));

// Every clause-scoped kind splits on the clause boundary. It used to be `kind === 'clause'` alone,
// so the two 'every*' kinds silently read whole LINES: a bullet whose first clause was correctly
// conditioned ("仅在…时，更新其状态") excused an unconditional one beside it in the same line
// ("；无工单也更新工单状态"). One kind list, one rule — a check whose quantifier silently changes
// with its name is a check nobody can reason about.
const CLAUSE_KINDS = new Set(['clause', 'everyClause', 'everyClauseAny']);

function requirementHolds(text, req) {
  if (req.kind === 'forbid') return !req.literals.some((literal) => text.includes(literal));
  const units = (CLAUSE_KINDS.has(req.kind) ? clausesOf(sectionText(text, req.section)) : linesOf(sectionText(text, req.section)))
    .filter((unit) => req.anchor.test(unit))
    .filter((unit) => !req.exclude?.test(unit));
  // An 'every*' requirement conditions the instructions that DO exist, so an anchor nothing matches
  // would satisfy it vacuously — the failure mode of "checked nothing, passed".
  if (req.kind === 'everyClause') return units.length > 0 && units.every((unit) => allGroups(unit, req.groups));
  // All-of across clauses, any-of across groups: EVERY clause must carry one acceptable shape. The
  // other reading — `.some` over clauses — lets a single compliant clause excuse an unconditional
  // one, which is the same hole as reading the line instead of the clause.
  if (req.kind === 'everyClauseAny') return units.length > 0 && units.every((unit) => req.groups.some((group) => anyOf(unit, group)));
  return units.some((unit) => allGroups(unit, req.groups));
}

const contractMissing = (text, contract) => contract.filter((req) => !requirementHolds(text, req)).map((req) => req.name);
// Teeth, one requirement at a time: delete every alternative that requirement reads and require the
// predicate to name it. A loop over the contract list cannot notice a requirement being DROPPED from it
// — it stops testing it and every arm stays green. All alternatives go, not one: the groups are
// interchangeable by design, so "still passed with this removed" holds for any non-last alternative.
const withoutTerms = (text, req) => (req.groups || []).flat().reduce((acc, term) => acc.split(term).join(''), text);

// The one runner every contract goes through, so the four arms are identical everywhere and a new
// contract costs a table plus one line: stated on the live artifact, per-requirement teeth, a witness
// per forbidden literal, and the pre-09-29 sentence each requirement replaced.
function runContract(text, contract, oldForms) {
  const missing = contractMissing(text, contract);
  const teeth = contract.filter((req) => req.kind !== 'forbid')
    .every((req) => contractMissing(withoutTerms(text, req), contract).includes(req.name));
  const forbidWitness = contract.filter((req) => req.kind === 'forbid')
    .every((req) => req.literals.every((literal) => contractMissing(`${text}\n${literal}`, contract).includes(req.name)));
  const oldFormsRejected = oldForms.every(([name, form]) => contractMissing(form, contract).includes(name));
  return { pass: missing.length === 0 && teeth && forbidWitness && oldFormsRejected, missing, teeth, forbidWitness, oldFormsRejected };
}

// One scaffold, rendered once per self-check, with the contract group evaluated from it. Cached,
// because runSelfCheck() binds it alongside groups that read a reference file instead, and spawning
// the generator once per group would cost a temp directory per read of the same artifact.
let contractCache = null;
async function evaluateContracts() {
  if (contractCache) return contractCache;
  const dirs = [];
  try {
    const create = path.join(scriptDir, 'create-harness.mjs');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'harness-contract-'));
    dirs.push(dir);
    await execFileAsync('node', [create, '--target', dir]);
    const result = runContract(await readText(path.join(dir, 'AGENTS.md')), TASK_CONTRACT, TASK_OLD_FORMS);
    contractCache = {
      taskContract: {
        pass: result.pass,
        missing: result.missing,
        teeth: result.teeth,
        forbidWitness: result.forbidWitness,
        oldFormsRejected: result.oldFormsRejected
      }
    };
  } catch (error) {
    // Reported per group rather than thrown, so one broken scaffold does not hide the other groups.
    contractCache = { taskContract: { pass: false, missing: {}, teeth: false, forbidWitness: false, oldFormsRejected: false, error: error.message } };
  } finally {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  }
  return contractCache;
}

// Read from the shipped reference, like every other reference check: the file IS the artifact under
// test, and a hand-written copy would only prove the probe's own string is right. The score row is read
// across every 满分 line, because the reference states the point twice and only one has to carry the
// whole rule.
const maintScoreRowHeld = (text) => linesOf(text).filter((line) => line.includes('满分'))
  .some((line) => anyOf(line, MAINT_MISALIGNMENT) && anyOf(line, MAINT_ANTI_GAMING));

function maintContractMissing(text) {
  const table = linesOf(sectionText(text, '内容复核'));
  return [...(maintScoreRowHeld(text) ? [] : [MAINT_SCORE_ROW]), ...MAINT_GUARDS
    .filter((guard) => !table.some((line) => guard.anchor.test(line) && anyOf(line, guard.terms)))
    .map((guard) => guard.name)];
}

async function checkMaintContract() {
  try {
    const reference = await readText(path.join(skillRoot, WRAPUP_REFERENCE));
    const missing = maintContractMissing(reference);
    // Teeth per guard, then the whole table deleted: a section removed outright satisfies any single
    // row-level predicate, so the per-guard arms cannot see that case on their own.
    const teeth = MAINT_GUARDS
      .every((guard) => maintContractMissing(guard.terms.reduce((acc, term) => acc.split(term).join(''), reference)).includes(guard.name))
      && maintContractMissing(MAINT_MISALIGNMENT.reduce((acc, term) => acc.split(term).join(''), reference)).includes(MAINT_SCORE_ROW);
    const tableRemovedRefused = MAINT_GUARDS
      .every((guard) => maintContractMissing(reference.replace(/^##\s*内容复核[\s\S]*?(?=^##\s)/m, '')).includes(guard.name));
    const oldRowRejected = maintContractMissing(`## 异常\n\n${MAINT_OLD_ROW}\n`).includes(MAINT_SCORE_ROW);
    return { pass: missing.length === 0 && teeth && tableRemovedRefused && oldRowRejected, missing, teeth, tableRemovedRefused, oldRowRejected };
  } catch (error) {
    return { pass: false, missing: [], teeth: false, tableRemovedRefused: false, oldRowRejected: false, error: error.message };
  }
}
// The three threshold switches, one table so the refusal below, the resolved numbers and the
// self-check that audits them cannot drift into three separate readings of the same default.
const GATE_THRESHOLD_ARGS = [
  { flag: '--min-score', key: 'minScore', fallback: 70 },
  { flag: '--min-eval-score', key: 'minEvalScore', fallback: 80 },
  { flag: '--min-self-check-score', key: 'minSelfCheckScore', fallback: 90 }
];

// Two ways this gate could be turned off without anyone touching the code, and both were measured
// before they were closed: `Number(args.minScore || 70)` turns --min-score=abc into NaN, every
// `score < NaN` is false, and the run exits 0 having verified nothing; --no-self-check skipped the
// one source of truth this repository has and still reported a clean run. A threshold that can be
// written as a word, and a gate that can be switched off, are the same defect: a value that reaches
// the comparison without ever being validated, so the comparison itself goes quiet. Both are
// refused here, before anything is scored, scaffolded or written.
//
// The refusal is a pure function over the parsed args so the self-check can feed it malformed input
// directly; nothing here touches the filesystem, and the caller is what exits.
function gateArgRefusals(args) {
  const refusals = [];
  for (const { flag, key } of GATE_THRESHOLD_ARGS) {
    const raw = args[key];
    if (raw === undefined) continue;
    // parseArgs hands back `true` for a bare --flag and '' for `--flag=`. Neither is a threshold:
    // Number(true) is 1, which passes everything, and Number('') is 0, which also passes
    // everything. Both would be a silent widening rather than a refusal, so both are named.
    const usable = (typeof raw === 'number' || typeof raw === 'string')
      && String(raw).trim() !== '' && Number.isFinite(Number(raw));
    if (usable) continue;
    // The consequence is spelled out rather than asserted, because it is not the same failure every
    // time: NaN makes the comparison permanently false and the run passes having checked nothing,
    // while a value that happens to parse as a number too small (Number(true) is 1, Number('') is 0)
    // makes the comparison permanently true and the run fails on a threshold nobody wrote down. Both
    // are the gate deciding something the caller never said.
    const parsed = Number(raw);
    const consequence = Number.isNaN(parsed)
      ? `${parsed}, and every comparison against NaN is false, so the threshold would stop existing and the run would exit 0 having checked nothing`
      : `${parsed}, which is not the threshold you meant and would decide every comparison in the run`;
    refusals.push(
      `Refusing to run: ${flag} was given ${JSON.stringify(raw)}, which is not a finite number.\n`
      + `  A threshold that was never written down is worse than no threshold: Number(${JSON.stringify(raw)}) is `
      + `${consequence}.\n`
      + `  Write it as a plain number, e.g. ${flag}=70 (or "${flag} 70"). An explicit 0 is accepted — it is a deliberate`
      + ' relaxation, which is not the same thing as a threshold that never fires.'
    );
  }
  // The self-check is this repository's only verdict on its own tooling: it scaffolds a throwaway
  // harness and runs the shipped scripts end to end. A flag that skips it does not grade the target
  // more cheaply, it removes the only statement the exit code was ever about.
  if (args.noSelfCheck !== undefined) {
    refusals.push(
      'Refusing to run: --no-self-check is not a supported switch.\n'
      + '  The self-check is the only check here that proves the bundled scripts still work end to end\n'
      + '  rather than merely being present, so a run that skips it has verified nothing about anything.\n'
      + '  A gate that can be switched off is not a gate. Use --self-check-only to grade the tooling and\n'
      + '  nothing else, which is the question that flag actually answers.'
    );
  }
  return refusals;
}

// Resolved only after gateArgRefusals() has cleared the run, so every value reaching the comparisons
// is a number that was actually written down. A legal override such as --min-score=0 survives here
// untouched: the refusal is about unreadable thresholds, not about strict ones.
function gateThresholds(args) {
  const resolved = {};
  for (const { key, fallback } of GATE_THRESHOLD_ARGS) {
    resolved[key] = args[key] === undefined ? fallback : Number(args[key]);
  }
  return resolved;
}

const args = parseArgs(process.argv.slice(2));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(scriptDir, '..');

// Before --help, and before the first line that reads a file or spawns a process. A refusal that
// ran afterwards would leave a window in which a malformed invocation had already scaffolded a
// harness and written a report — the run would be "refused" only after it had done its work.
// Exit code 2, distinct from 1: 1 means a gate went red, 2 means this run never judged anything.
const gateRefusals = gateArgRefusals(args);
if (gateRefusals.length > 0) {
  // writeSync rather than console.error: process.exit() below can drop buffered stderr on a pipe,
  // and a refusal whose text is lost is a refusal the caller cannot act on.
  writeSync(2, `${gateRefusals.join('\n\n')}\n\n${scriptCommand('run-benchmark.mjs')} --help lists every switch.\n`);
  process.exit(2);
}
const thresholds = gateThresholds(args);

if (args.help) {
  console.log(`Usage: ${scriptCommand('run-benchmark.mjs')} [--target DIR] [--output FILE] [--html FILE] [--min-score N] [--min-eval-score N] [--min-self-check-score N] [--self-check-only] [--no-self-check (refused)]

Runs a lightweight harness benchmark:
  1. Self-check: scaffold a throwaway harness into a temp directory and confirm it validates. This
     is the only check that proves the bundled scripts work end-to-end rather than being present.
  2. Scores the current target harness.
  3. Checks eval coverage in evals/evals.json.
  0a. --self-check-only skips steps 2 and 3, and the audit they gate, so ONLY the self-check decides
     the exit code. This repository is the one target the audit must never grade: it ships the skill
     rather than a harness built by the skill, so the audit reports 20/100 on a tree that is working
     as intended. That is what made it impossible for this repo to carry its own ./init.sh - a gate
     that can never pass is a gate that cannot fail. Use it to ask "are the tools intact?" without
     inheriting an answer about the target.
 0b. --no-self-check is REFUSED, not honoured: the run prints why and exits 2 before scoring
     anything. It used to skip the self-check and still exit 0, so a caller could turn the only
     verification this script performs off without the exit code changing. --self-check-only is the
     switch that answers the narrower question; --no-self-check is the one that removes the answer.
 0c. --min-score / --min-eval-score / --min-self-check-score must be finite numbers (defaults 70 / 80
     / 90). A non-numeric value such as --min-score=abc used to become NaN, and every comparison against
     NaN is false, so the threshold stopped existing while the run still exited 0. A non-numeric value
     is now refused before the run starts; an explicit numeric 0 is still accepted as a deliberate
     relaxation, because a threshold somebody wrote down is not the same thing as one that vanished.
 4. Checks the SKILL.md size budget (${SKILL_MD_MAX_BYTES} bytes = ${SKILL_MD_GROWTH}x the ${SKILL_MD_BASELINE_BYTES}-byte baseline). [budget]
  5. Checks the generated AGENTS.md budget against an EXTERNAL anchor: the default render must stay
     inside byte, line and working-rule caps derived from the upstream reference template, not from
     whatever this template happens to render at. A cap whose baseline is the status quo can only
     ratify the status quo. [agentsBudget]
  6. Checks the generated AGENTS.md for restated, discoverable content — directory trees, stack
     descriptions — and proves the detector has teeth against a seeded violation. [agentsDiscover]
  7. Checks that the generated artifacts carry none of this skill's retired machinery: the forbidden
     list is asserted term by term, each proven load-bearing by dropping it in turn, because a term
     table that no gate reads is a claim with no carrier. The same group proves the rendered file
     names NO external system at all, which is checked by seeding a representative name and
     requiring the predicate to catch it — not by keeping a list of names, because a list of
     external names is exactly what rots when the ecosystem renames. [artifactPurity]
  8. Checks --dry-run: it must change nothing, plan real artifacts rather than recite a template
     list, and agree with the write that follows it. [dryRun]
  9. Checks the skill's own shipped files: no command it prints may use a script path that only
     resolves from the skill directory, and no shipped text may point at a bare skills/<name>/
     prefix. The first names an invocation the agent cannot run, the second a file it cannot open,
     both because its cwd is the target repo rather than the skills directory. [selfRefs]
 10. Checks command references: a documented command that no longer resolves — a script renamed in
     package.json, a helper deleted — is caught rather than trusted forever. Seeded in both
     directions: a dangling reference must fail the audit, while the generator's own has_script
     guard must NOT, because flagging it would fail the output this skill itself renders. What has no
     static resolver (pytest, cargo test) is listed by name, since a check that silently skips what
     it cannot verify reads as full coverage while delivering less. [references]
 11. Checks the bottleneck headline: a tie must name every tied subsystem, a unique minimum must
     name one, and a complete harness must report none. [bottleneckTies]
 12. Checks the scorer against a harness it did not write: a foreign repository with no gate must
     fail the two gate checks, and that same repository with a gate must pass them, so the case
     cannot be closed by scoring every harness lower. The fixture is written out literally, because
     one derived from the needles would move with them and prove nothing about which check fired. [foreignAudit]
 13. Checks the blank-project gate: the placeholder verification step must exit non-zero, a real
     command must still run, and — asserted through the real generator, not a hand-written string —
     a manifest that defines no check/typecheck/lint/test/build also refuses instead of exiting 0
     having verified nothing. A third shape is armed beside them, because the first two both route
     through verificationCommands and the explicit --commands path bypasses it entirely: an
     assembled script whose guarded steps could all skip must fail closed, and must reopen the
     moment a check really runs. The same invariant has a second producer, the hand-copy fallback
     templates/init.sh, which the generator probes cannot reach: every refusal it prints must be
     armed with a non-zero exit, both refusals must still be present, and a success tail must
     remain. A gate that cannot fail is not a gate. [blankGate]
 14. Checks the blueprint slot: omitting --blueprint must leave a visible pending marker
     rather than stack-derived text, and a supplied description must reach AGENTS.md verbatim. [blueprint]
 15. Checks the instruction-file invariant: an existing CLAUDE.md must not get a second AGENTS.md
     beside it, and an existing instruction file must stay byte-identical while its missing
     harness sections are still reported. [agentFile]
 16. Checks the self-check's own coverage: every group in SELF_CHECK_GROUPS must have a bound check,
     a place in the pass conjunction, a line in the shareable HTML report, a line on the console a
     human actually reads, and a bracketed key in THIS help — five registration points asserted as
     one set equality. This is the one numbered check that is not a group: it IS the coverage arm,
     which is why it carries no key.
 17. Checks the report contract: the renderer must honour the output path it is handed rather than
     reporting success at the default one, and the report a human reads must name the subsystem
     count the model actually has — seeded on both sides, since a detector that finds nothing is
     indistinguishable from one that looks for nothing. [reportContract]
 18. Checks the maintenance trigger: the generated instruction file must tell the agent to optimise
     the harness at wrap-up when the session's own output leaves it stale or thin — NOT when the
     harness files happen to have been touched, which is self-referential and can only see rot it
     already fixed. Seeded on four sides: each term is dropped in turn to prove it is load-bearing,
     the old diff-keyed sentence must be rejected, that sentence wearing the new vocabulary must be
     rejected too, and a shortened forbidden list must be caught — without the last two, a render
     that reintroduced the old condition while keeping the new words passed this gate. [maintenance]
 19. Checks the skill's OWN design rules, which no other gate can see: every other group reads the
     artifact a target repo receives, and the only two mentions of SKILL.md in this file are a byte
     count and a path-shape scan. SKILL.md must still state the wrap-up criterion on the session's
     own output, must not key it on files having been touched, and may not carry the old condition
     wearing the new vocabulary. Seeded on four sides — each term dropped in turn, the pre-09-25 rule
     line rejected, the hybrid form rejected, and an incomplete rule refused by the very term it is
     missing — because deleting that rule outright used to leave every other gate green and make the
     byte budget line greener still. [skillDesign]
 20. Checks the wrap-up procedure a maintainer actually reads: it must produce both of its outputs —
     the candidate changes, and the judgment items handed to the user rather than decided by the
     agent (a rule that is no longer necessary is not wrong, so no command fails and no audit catches
     it) — and it must report the NET change rather than only what was edited. The same net-change promise
     must also appear in SKILL.md's own task table, the one version of this procedure every reader is
     guaranteed to meet, keyed on the task name so renumbering the table cannot read as a regression.
     Seeded on nine sides:
     each term dropped in turn, a version refused by its own missing term, and a fixture that keeps
     every term while losing the place to put them, each of the three repeated against the task row —
     and, for both witness tables, a row deleted from the witness itself, which a one-way containment
     check waves through and only set equality catches.
     The judgment half is the part no tool can settle,
     so the gate proves the handover is stated instead of pretending the tool can make the call. [wrapupOutput]
 21. Checks the task conditions the instruction file carries — advance only what the user authorized,
     pick a ticket or deliverable only inside an authorized delivery, questions and read-only reviews
     pick nothing and update no status, a baseline failure split into pre-existing versus introduced, a
     commit gated on the definition of done rather than on a check a project may legitimately have
     declared it cannot run, existing modifications and untracked files surviving any cleanup, a
     read-only task only reporting harness drift. Seeded in every direction the failure can hide in:
     terms deleted requirement by requirement, forbidden phrases seeded back, every retired sentence
     refused. [taskContract]
 22. Checks that a full audit score is not an exit condition in the maintenance reference: the score
     row still routes to the actual misalignment check, and the retired row is refused — per guard,
     and with the whole content-review table deleted too. [maintContract]
 23. Checks that this suite has left no orphan behind: every top-level declaration under scripts/
     must be read somewhere in the tree, the flags the generator's own --help documents must be
     flags it reads, and the bracketed keys in this help must equal SELF_CHECK_GROUPS in BOTH
     directions. Deleting three groups left a forbidden-term table with zero call sites while the
     README still called it "proven not blind"; nothing failed, and the only symptom was a judge
     seeding the retired phrases and every gate staying green. [noDeadDecls]
 24. Checks that the verification gate only grows: a new check joins an existing init.sh with every
     prior step preserved, naming one that is already there is a byte-identical no-op, a check the
     gate would never actually run is refused and rolled back rather than reported as added, and that
     refusal has to name the command it refused rather than a placeholder where the command belongs —
     the shared boilerplate alone cannot tell the two apart. A missing init.sh is refused instead of
     quietly created. A one-line entry reference to a script the
     repository owns is appended unguarded, and removing that entry turns the gate red rather than
     skipping it. A declared check that did not run turns the gate red instead of printing a notice
     beside the success tail, while a script the manifest does define still gets a real step. Every
     toolchain branch of the hand-copy fallback raises its counter only on the tool's own verdict, so
     a project with an empty test suite is refused by name rather than reported as verified, and the
     same branch stays green on a toolchain that has a test to run. The arms that need a POSIX shell to
     run the gate are reported as unconfirmed, not passed, when no shell is available. [initGrowth]
25. Checks that the spec layer is opt-in and honest: a run without --spec-layer produces the same
     two artifacts with byte-identical content, the two documents exist only when the flag is given, a
     repository whose stack IS detected still yields a mission containing no stack word at all, both
     documents are pointed at as read-on-demand rather than as files every session must open, and the
     same byte, line and working-rule ceilings still hold with the extra pointer. [specLayer]
26. Checks that the detail layer ships by default and stays reachable: a plain run — no switch —
     writes both documents, the instruction file routes to each under its own H3, the artifact
     contract names them, all three are pointed at as read-on-demand rather than resident, each stays
     inside its own byte and line ceiling, and the append into an instruction file another owner
     wrote leaves that file's existing bytes untouched, keeps the third party's block, and does not
     run twice. Also proves the RAN=0 anchors --add-check inserts between are still in place: the
     layer rewrites the closing instructions of the very file they live in. [agentsLayer]
27. Checks that the gate's closing instructions are ONE literal with two producers: the generated
     init.sh, the hand-copy fallback template and this repository's own ./init.sh must carry the same
     next-steps block, and it must tell the agent to work only on what was explicitly authorized
     rather than to pick its own next task. The two had drifted apart, and the drift shipped: the
     generated gate selected work in the same breath as the instruction file that forbids selecting
     it. [nextSteps]
28. Checks that this script's own switches cannot be used to switch it off. The self-check is
     asserted by running the real script with a bad invocation and requiring a refusal and a
     non-zero exit, three thresholds and the off switch separately, with the whole refusal logic
     deleted from a copy in turn so a check that would pass without it is caught. --min-score=0 is
     asserted to still run, because a refusal that also ate deliberate relaxations would be its own
     kind of wrong. [gateArgs]
29. Produces a JSON report and optional HTML report.

This is a structural benchmark, not an LLM judge. Use it before/after real agent sessions.`);
  process.exit(0);
}

const target = path.resolve(args.target || args._[0] || process.cwd());
const output = path.resolve(args.output || path.join(target, 'harness-benchmark.json'));
const evalPath = path.resolve(args.evals || path.join(skillRoot, 'evals', 'evals.json'));

// Declared HERE, not beside the group that reads them: `runSelfCheck()` is invoked further down this
// file, so a const below that point is still in its temporal dead zone when the artifact-purity
// group reads it. This file has paid for that mistake four times; the fifth arrived the same way,
// with a ReferenceError whose message names a helper rather than a line number, so it reads like a
// missing feature instead of a declaration that is simply too late.
const EXTERNAL_SYSTEM_SEEDS = ['to-tickets', 'mattpocock', 'superpowers', 'setup-matt-pocock-skills'];
const externalSystemsIn = (text) => EXTERNAL_SYSTEM_SEEDS.filter((name) => text.includes(name));

// Declared HERE, not beside the spec-layer group that reads them: `runSelfCheck()` is invoked at the
// top level below this point, so a const sitting next to the check is still in its temporal dead zone
// when the group reads it. This file has paid for that mistake four times; the fifth arrived the same
// way, with a ReferenceError naming the const rather than a line — so it reads like a missing feature,
// and it silently turns every arm after the throw into a false FAIL. An early "ok" printed above a
// TDZ error is therefore not reassurance, which is exactly how the second attempt looked.
//
// ARM 3 of the spec-layer group is the one worth stating out loud: its fixture has a real manifest, so
// a stack IS detected and `tech-stack.md` genuinely says `typescript`. It then requires `mission.md`
// to contain no stack word at all. That is the check the whole feature could fail silently on,
// because a filled-in-looking mission reads like an aligned answer and scores 100/100 everywhere else.

// What makes a spec-layer document resident rather than optional.
//
// Scoped to the pointer in AGENTS.md ON PURPOSE, and the scoping is the point: AGENTS.md is where
// residency is decided — it is the file every session reads — so an imperative there is the defect.
// The documents themselves are allowed to DISCUSS when not to read them, and a predicate that
// banned the vocabulary everywhere would fail on "启动工作流里没有要求每次会话都读它". That is a
// false positive with a real cost: it teaches the author to avoid a word instead of fixing the
// document, which is the keyword-stuffing anti-pattern wearing a gate's clothes. So residency is
// judged by the required positive ("按需读") in all three files, plus an absence in the one file
// whose job is to decide.
const ARTIFACT_ADDING_FLAGS = ['--spec-layer'];

const RESIDENT_READING = /每次(会话|启动)|必读|先读|首先阅读|启动时读取/;
const SPEC_LAYER_ON_DEMAND = /按需读/;
const STACK_LEAK_PATTERN = /typescript|TypeScript|package\.json|\bnode\b|\bpnpm\b|\byarn\b|pyproject|go\.mod|Cargo\.toml|pom\.xml/;

// One phrase per forbidden entry, so the per-entry arm seeds each pattern through text that belongs
// to that pattern rather than through a shared blob that several patterns would also match. Also
// hoisted for the same reason.
function seedPhraseFor(name) {
  const seeds = {
    'in-repo state registry': 'feature_list.json',
    'in-repo progress log': 'progress.md',
    'landing-point doctrine': '产物落点由本技能指定',
    'tracking-policy section': '产物追踪策略',
    'controlled release': '受控放行',
    'governance modes': '两种模式',
    'extracted agent-doc layer': 'tracking-policy.md',
    'installation check': '未安装时提示安装'
  };
  return seeds[name] ?? name;
}

const targetFiles = await loadHarnessFiles(target);
// --self-check-only grades the SKILL and nothing else. This repository is the one target the
// benchmark must never grade as a harness: it ships the skill, not a harness built by it, so the
// audit reports 20/100 on a tree that is working exactly as intended. Grading it here is not a
// finding — it is the script measuring itself with the wrong instrument, and the exit code it forces
// is what made it impossible for this repository to carry its own ./init.sh: a gate that can never
// pass is a gate that cannot fail, which is the one thing this skill exists to forbid.
//
// So the two questions are separated rather than ranked against each other. "Are the tools broken?"
// is answered by the self-check and by nothing else; "is this target's harness sound?" is answered by
// the audit and by nothing else. A caller that wants the first must be able to ask for it alone,
// otherwise the only way to hear whether the skill is intact is to ignore a failure about itself.
const selfCheckOnly = Boolean(args.selfCheckOnly);
const harnessResult = selfCheckOnly ? null : scoreHarness(targetFiles, { references: await collectCommandReferences(target, targetFiles) });
const evals = await readJson(evalPath);
const evalResult = scoreEvals(evals);
const selfCheck = await runSelfCheck();
const report = {
  generatedAt: new Date().toISOString(),
  target,
  selfCheckOnly,
  selfCheck,
  harness: harnessResult,
  evals: evalResult,
  recommendation: selfCheckOnly
    ? `Toolchain self-check only: the audit of ${path.basename(target)} was not run and says nothing about it.`
    : recommend(harnessResult, evalResult)
};

await writeText(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(`Benchmark report written to ${output}`);
console.log('');
for (const line of consoleSelfCheckLines(selfCheck)) console.log(line);
// The audit block is omitted rather than printed as a zero, so a report from this mode cannot be
// mistaken for a harness that scored nothing — it is a report that did not score one.
if (!selfCheckOnly) {
  console.log(formatScoreReport(harnessResult, target));
  console.log(`Eval coverage: ${evalResult.score}/100 (${evalResult.passed}/${evalResult.total})`);
}
console.log(`Recommendation: ${report.recommendation}`);

if (args.html) {
  const htmlPath = path.resolve(args.html);
  await writeText(htmlPath, renderBenchmarkHtml(report));
  console.log(`HTML benchmark report written to ${htmlPath}`);
}

// Three sources, and under --self-check-only only one of them is in play. Keeping the others in the
// conjunction would defeat the flag: an audit that was never run cannot fail the run that skipped it.
const failed =
  selfCheck.pass === false ||
  (!selfCheckOnly && harnessResult.overall < thresholds.minScore) ||
  (!selfCheckOnly && evalResult.score < thresholds.minEvalScore);
if (failed) {
  process.exitCode = 1;
}

// Prove the bundled scripts actually work end-to-end: scaffold a harness into a throwaway
// directory, then score it. A structural eval-coverage check can't catch a broken
// create-harness.mjs — this can. Failure here means the skill ships broken, not just thin.
// The remaining groups keep the skill's own instruction file inside its size budget, keep every
// command the skill prints runnable from the target repo, keep the generated instruction file
// inside its external budgets and free of restated content — and keep it free of any instruction
// that would send the agent off to run the project's engineering workflow.
// Renders the console block the human reads. Extracted from the top-level flow so the coverage
// check reads the very lines that will be printed — a declared console label that the block never
// emits is the "prose nothing backs" failure this suite refuses everywhere else. It takes the report
// object rather than the individual groups so the check can call it on a preview before the real
// print, and each arm stays guarded so a group that failed to compute prints nothing rather than
// throwing while reporting a failure.
function consoleSelfCheckLines(selfCheck) {
  const lines = [];
  if (!selfCheck) return lines;
  lines.push(`Self-check: ${selfCheck.pass ? 'PASS' : 'FAIL'} — scaffolded harness scored ${selfCheck.score}/100`);
  if (selfCheck.budget) {
    const { size, max, pass, rawSize, crlfCount, lineEndingInvariant, multiplierSane } = selfCheck.budget;
    lines.push(`  SKILL.md budget: ${pass ? 'PASS' : 'FAIL'} — ${size}/${max} bytes LF-normalized (${max - size >= 0 ? `${max - size} left` : `${size - max} over`})${crlfCount ? `; checkout is CRLF (${crlfCount} lines → raw ${rawSize})` : ''}; line-ending invariant: ${lineEndingInvariant ? 'ok' : 'NO'}; growth ${SKILL_MD_GROWTH}x: ${multiplierSane ? 'ok' : 'UNSANE'}`);
  }
  if (selfCheck.agentsBudget) {
    const { pass, size, max, lines: agentLines, maxLines, ruleCount, maxRules, rawSize, crlfCount, lineEndingInvariant, error } = selfCheck.agentsBudget;
    lines.push(`  AGENTS.md budget: ${pass ? 'PASS' : 'FAIL'} — ${size}/${max} bytes LF-normalized (${max - size >= 0 ? `${max - size} left` : `${size - max} over`}); ${agentLines}/${maxLines} lines; working rules ${ruleCount}/${maxRules}${crlfCount ? `; rendered CRLF (raw ${rawSize})` : ''}; line-ending invariant: ${lineEndingInvariant ? 'ok' : 'NO'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.agentsDiscover) {
    const { pass, offenders = [], selfRestraintStated, selfRestraintTeeth, seededCaught, error } = selfCheck.agentsDiscover;
    lines.push(`  AGENTS.md discoverability: ${pass ? 'PASS' : 'FAIL'} — default render free of restated content: ${offenders.length === 0 ? 'ok' : `NO (${offenders.join(', ')})`}; self-restraint rule stated: ${selfRestraintStated ? 'ok' : 'NO'}; proven load-bearing: ${selfRestraintTeeth ? 'ok' : 'BLIND'}; seeded violation caught: ${seededCaught ? 'ok' : 'NO'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.artifactPurity) {
    const { pass, leaked = [], named = [], perEntryTeeth, seeded = 0, total = 0, externalTeeth, namedInHelp = [], helpBodiesLocated, error } = selfCheck.artifactPurity;
    lines.push(`  Artifact purity: ${pass ? 'PASS' : 'FAIL'} — generated artifacts carry no retired machinery: ${leaked.length === 0 ? 'ok' : `LEAKED (${leaked.join(', ')})`}; forbidden patterns caught by the seeded violation: ${seeded}/${total}; per-entry teeth: ${perEntryTeeth ? 'ok' : 'BLIND'}; no external system named: ${named.length === 0 ? 'ok' : `NAMED (${named.join(', ')})`}; external teeth: ${externalTeeth ? 'ok' : 'BLIND'}; this skill's own --help names none: ${namedInHelp.length === 0 ? 'ok' : `NAMED (${namedInHelp.join(', ')})`}; every --help body located: ${helpBodiesLocated ? 'yes' : 'NO'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.maintenance) {
    const { pass, stated, missing = [], leaked = [], teeth, oldFormRejected, hybridRejected, forbiddenWitness, error } = selfCheck.maintenance;
    lines.push(`  Maintenance trigger: ${pass ? 'PASS' : 'FAIL'} — wrap-up step keys on the session's own output leaving the harness stale, not on the harness files having been touched: ${stated ? 'ok' : `MISSING (${missing.join(', ') || 'section not found'})`}; retired diff-keyed phrasing: ${leaked.length === 0 ? 'absent' : `LEAKED (${leaked.join(', ')})`}; per-term detector: ${teeth ? 'ok' : 'BLIND'}; diff-keyed sentence rejected: ${oldFormRejected ? 'ok' : 'ACCEPTED'}; hybrid form rejected: ${hybridRejected ? 'ok' : 'ACCEPTED'}; forbidden-list shrink caught: ${forbiddenWitness ? 'ok' : 'BLIND'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.skillDesign) {
    const { pass, stated, missing = [], leaked = [], teeth, oldFormRejected, hybridRejected, witness, error } = selfCheck.skillDesign;
    lines.push(`  SKILL.md design rule: ${pass ? 'PASS' : 'FAIL'} — the skill's own design section states the wrap-up criterion on the session's output: ${stated ? 'ok' : `MISSING (${missing.join(', ') || 'section not found'})`}; the diff key it replaced: ${leaked.length === 0 ? 'absent' : `LEAKED (${leaked.join(', ')})`}; per-term detector: ${teeth ? 'ok' : 'BLIND'}; pre-09-25 rule line rejected: ${oldFormRejected ? 'ok' : 'ACCEPTED'}; hybrid form rejected: ${hybridRejected ? 'ok' : 'ACCEPTED'}; requirement-list shrink caught: ${witness ? 'ok' : 'BLIND'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.wrapupOutput) {
    const { pass, stated, heading, missing = [], teeth, headingArm, witnessCovers, witness, entry, entryTeeth, entryWitness, error } = selfCheck.wrapupOutput;
    const entryLine = entry && entry.stated
      ? 'ok'
      : `NO (${entry && entry.row ? `MISSING (${(entry.missing || []).join(', ')})` : '更新 row not found'})`;
    lines.push(`  Wrap-up outputs: ${pass ? 'PASS' : 'FAIL'} — the maintenance reference produces both lists (candidate changes and the items the user must judge) and reports the net change: ${stated ? 'ok' : `MISSING (${missing.join(', ') || 'terms'})`}; its own section: ${heading ? 'ok' : 'ABSENT'}; per-term detector: ${teeth ? 'ok' : 'BLIND'}; heading requirement: ${headingArm ? 'ok' : 'BLIND'}; witness covers every term: ${witnessCovers ? 'ok' : 'BLIND'}; list-shrink witness: ${witness ? 'ok' : 'BLIND'}; SKILL.md task row promises the same: ${entryLine}; per-term detector: ${entryTeeth ? 'ok' : 'BLIND'}; list-shrink witness: ${entryWitness ? 'ok' : 'BLIND'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.dryRun) {
    const { pass, changesNothing, previewedFiles, reflectsState, planMatchesRun, wrote = [], error } = selfCheck.dryRun;
    lines.push(`  Dry run: ${pass ? 'PASS' : 'FAIL'} — writes nothing: ${changesNothing ? 'ok' : `NO (still wrote ${wrote.join(', ') || 'files'})`}; plans artifacts: ${previewedFiles ? 'ok' : 'NO'}; reflects existing state: ${reflectsState ? 'ok' : 'NO'}; plan matches the real run: ${planMatchesRun ? 'ok' : 'NO'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.selfRefs) {
    const { pass, offenders = [], checked, error } = selfCheck.selfRefs;
    lines.push(`  Self-reference paths: ${pass ? 'PASS' : 'FAIL'} — ${checked} shipped file(s) checked${offenders.length ? `; unreachable relative path in ${offenders.join(', ')}` : ''}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.references) {
    const { pass, danglingCaught, guardedExcused, uncheckedListed, uncollectedRefused, unwiredNamed, unwiredRetired, unwiredNonFatal, dangling = [], error } = selfCheck.references;
    lines.push(`  Command references: ${pass ? 'PASS' : 'FAIL'} — a documented command that stops resolving is caught, while a guarded one and an unresolvable one are not mistaken for it: dangling fixture ${danglingCaught ? `caught (${dangling.join(', ')})` : 'MISSED'}; guarded fixture ${guardedExcused ? 'excused' : 'FALSELY FLAGGED'}; what cannot be resolved is listed: ${uncheckedListed ? 'ok' : 'SILENT'}; a defined-but-never-run check is named: ${unwiredNamed ? 'ok' : 'MISSED'}; a guard retires it: ${unwiredRetired ? 'ok' : 'NOT RETIRED'}; naming it does not fail the audit: ${unwiredNonFatal ? 'ok' : 'FALSELY FATAL'}; an uncollected scan fails rather than passing: ${uncollectedRefused ? 'ok' : 'NO'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.agentsLayer) {
const { pass, defaultShipsLayer, defaultRouteReadable, navigationComplete, artifactsDeclareLayer, onDemandNotResident, layerBudgetHeld, appendPreserves, thirdPartySurvives, appendIdempotent, anchorsIntact, switchSuppressesFiles, switchClearsRoute, switchValueRefused, error } = selfCheck.agentsLayer;
    lines.push(`  Detail layer: ${pass ? 'PASS' : 'FAIL'} — a plain run ships both detail documents: ${defaultShipsLayer ? 'ok' : 'NO'}; the instruction file routes to each under its own H3: ${navigationComplete ? 'ok' : 'MISSING'}; the artifact contract names them: ${artifactsDeclareLayer ? 'ok' : 'MISSING'}; read on demand, not resident: ${onDemandNotResident ? 'ok' : 'RESIDENT'}; each inside its own ceiling: ${layerBudgetHeld ? 'ok' : 'BUSTED'}; appending to another owner's file leaves its bytes untouched: ${appendPreserves ? 'ok' : 'REWRITES'}; its third-party block survives: ${thirdPartySurvives ? 'ok' : 'CLOBBERED'}; a second run adds nothing: ${appendIdempotent ? 'ok' : 'DUPLICATED'}; the --add-check anchors are still in place: ${anchorsIntact ? 'ok' : 'MOVED'}; the default run still reads 细则 as a route, not a filename: ${defaultRouteReadable ? 'ok' : 'MISREAD'}; --no-agents-layer writes neither document: ${switchSuppressesFiles ? 'ok' : 'WROTE'}; and leaves no route to them: ${switchClearsRoute ? 'ok' : 'DANGLING'}; a value on that switch is refused: ${switchValueRefused ? 'ok' : 'ACCEPTED'}${error ? `; ${error}` : ''}`);
  }
  if (selfCheck.bottleneckTies) {
    const { pass, tieCount, uniqueCount, noneCount, tieLabel } = selfCheck.bottleneckTies;
    lines.push(`  Bottleneck ties: ${pass ? 'PASS' : 'FAIL'} — tie names all 3 subsystems: ${tieCount === 3 ? 'ok' : `NO (${tieCount})`}; unique minimum names one: ${uniqueCount === 1 ? 'ok' : `NO (${uniqueCount})`}; complete harness reports none: ${noneCount === 0 ? 'ok' : `NO (${noneCount})`} — ${tieLabel}`);
  }
  if (selfCheck.foreignAudit) {
    const { pass, bareVerification, gatedVerification, staticCheckFailed, evidenceFailed, entrypointFailed, gatedStaticPasses, gatedEvidencePasses, notOverranked, teeth } = selfCheck.foreignAudit;
    lines.push(`  Foreign-repo audit: ${pass ? 'PASS' : 'FAIL'} — a repo this skill did not generate, with no gate at all: static check ${staticCheckFailed ? 'ok' : 'LEAKED'}; evidence ${evidenceFailed ? 'ok' : 'LEAKED'}; entrypoint ${entrypointFailed ? 'ok' : 'LEAKED'}; does not outrank instructions/scope: ${notOverranked ? 'ok' : 'INVERTED'}; the same repo WITH a gate still passes both: ${gatedStaticPasses && gatedEvidencePasses ? 'ok' : 'BROKEN'}; seeded phrases flip exactly their own check: ${teeth ? 'ok' : 'BLIND'} — ${bareVerification}/5 without a gate vs ${gatedVerification}/5 with one`);
  }
  if (selfCheck.blankGate) {
    const { pass, placeholderFails, realRuns, scriptlessRefuses, withTestRuns, explicitFailsClosed, explicitOpensWhenRun, quotedCommaUnsplit, listStillSplits, unterminatedRefused, templateRefusals, templateRefusalsExitNonZero, templateStillRuns } = selfCheck.blankGate;
    lines.push(`  Blank-project gate: ${pass ? 'PASS' : 'FAIL'} — placeholder verification exits non-zero: ${placeholderFails ? 'ok' : 'NO'}; a real command still runs: ${realRuns ? 'ok' : 'NO'}; a manifest with no runnable script refuses too: ${scriptlessRefuses ? 'ok' : 'NO'}; a manifest with a real script still runs: ${withTestRuns ? 'ok' : 'NO'}; an explicit --commands list the manifest cannot run fails closed: ${explicitFailsClosed ? 'ok' : 'NO'}; and opens again once a check really runs: ${explicitOpensWhenRun ? 'ok' : 'NO'}; a comma inside a quoted command stays one command: ${quotedCommaUnsplit ? 'ok' : 'NO'}; a genuine comma-separated list still splits: ${listStillSplits ? 'ok' : 'NO'}; an unterminated quote is refused and leaves nothing behind: ${unterminatedRefused ? 'ok' : 'NO'}; the manual fallback carries ${templateRefusals} refusal(s) each armed with a non-zero exit: ${templateRefusalsExitNonZero ? 'ok' : 'NO'}; and still reaches a success tail: ${templateStillRuns ? 'ok' : 'NO'}`);
  }
  if (selfCheck.blueprint) {
    const { pass, pendingMarked, noInventedFill, verbatim, slotRewritten, restIntact, detectorHasTeeth, refusalHonoured, refusedUntouched, error } = selfCheck.blueprint;
    lines.push(`  Blueprint slot: ${pass ? 'PASS' : 'FAIL'} — omitted --blueprint stays a pending marker: ${pendingMarked ? 'ok' : 'NO'}; no stack-derived fill: ${noInventedFill ? 'ok' : 'NO'}; supplied blueprint reaches AGENTS.md verbatim: ${verbatim ? 'ok' : 'NO'}; a rewrite touches the slot only: ${slotRewritten && restIntact ? 'ok' : 'NO'}; detector has teeth: ${detectorHasTeeth ? 'ok' : 'BLIND'}; an unrecognised shape is refused: ${refusalHonoured && refusedUntouched ? 'ok' : 'NO'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.agentFile) {
    const { pass, noSecondFile, choseClaude, untouched, missingReported, forceRefused, forceStillWritesOwn, error } = selfCheck.agentFile;
    lines.push(`  Agent-file invariant: ${pass ? 'PASS' : 'FAIL'} — existing CLAUDE.md means no AGENTS.md is created: ${noSecondFile && choseClaude ? 'ok' : 'NO'}; existing instruction file left byte-identical: ${untouched ? 'ok' : 'NO'}; missing sections still reported: ${missingReported ? 'ok' : 'NO'}; --force refuses to delete another owner's sections: ${forceRefused ? 'ok' : 'NO'}; and still overwrites this skill's own render: ${forceStillWritesOwn ? 'ok' : 'NO'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.initGrowth) {
    const { pass, grew, preserved, idempotent, deadBranchRefused, rolledBack, refusalNamesCommand, refusalNameHasTeeth, missingRefused, unparseableRefused, detectorHasTeeth, loopStated, loopIsLoadBearing, entryAppended, entryUnguarded, entryIdempotent, entryMissingRefused, entryRulesHaveTeeth, entryGateFailsWhenUnresolvable, declaredSkipTurnsGateRed, declaredSkipDetectorHasTeeth, declaredScriptStillRuns, declaredSkipGateIsRed, declaredGateIsGreen, emptyToolBranchesGuarded, emptyToolBranchesHaveTeeth, emptyToolRunsRed, emptyToolRunsGreen, emptyToolGateTeeth, skipped, error } = selfCheck.initGrowth;
    lines.push(`  init.sh growth: ${pass ? 'PASS' : 'FAIL'} — a new check joins an existing gate: ${grew ? 'ok' : 'NO'}; existing steps preserved: ${preserved ? 'ok' : 'NO'}; repeat is a byte-identical no-op: ${idempotent ? 'ok' : 'NO'}; a check the gate would never run is refused: ${deadBranchRefused ? 'ok' : 'ACCEPTED'}; and rolled back: ${rolledBack ? 'ok' : 'NO'}; the refusal names the command it refused: ${refusalNamesCommand ? 'ok' : '     '}; that detector has teeth: ${refusalNameHasTeeth ? 'ok' : 'BLIND'}; a check that does not parse is refused: ${unparseableRefused ? 'ok' : 'ACCEPTED'}; no init.sh at all is refused: ${missingRefused ? 'ok' : 'ACCEPTED'}; an entry reference is one call line: ${entryAppended ? 'ok' : 'NO'}; and it is unguarded: ${entryUnguarded ? 'ok' : 'GUARDED'}; repeating it is a no-op: ${entryIdempotent ? 'ok' : 'NO'}; a missing entry is refused: ${entryMissingRefused ? 'ok' : 'ACCEPTED'}; entry path rules have teeth: ${entryRulesHaveTeeth ? 'ok' : 'BLIND'}; removing the entry turns the gate red: ${entryGateFailsWhenUnresolvable ? 'ok' : 'NO'}; a declared check that did not run turns the gate red: ${declaredSkipTurnsGateRed ? 'ok' : 'NOTICE ONLY'}; that detector has teeth: ${declaredSkipDetectorHasTeeth ? 'ok' : 'BLIND'}; a script the manifest defines still gets a real step: ${declaredScriptStillRuns ? 'ok' : 'DROPPED'}; and the two gates come back red and green: ${declaredSkipGateIsRed && declaredGateIsGreen ? 'ok' : 'NOT OBSERVED'}; every toolchain branch earns its counter on the tool's verdict: ${emptyToolBranchesGuarded ? 'ok' : 'UNGUARDED'}; that detector has teeth: ${emptyToolBranchesHaveTeeth ? 'ok' : 'BLIND'}; an empty tool run is red: ${emptyToolRunsRed ? 'ok' : 'PASSED'}; a populated one is green: ${emptyToolRunsGreen ? 'ok' : 'REFUSED'}; removing a branch refusal turns that red green: ${emptyToolGateTeeth ? 'ok' : 'BLIND'}; a red gate leaves a check behind: ${loopStated && loopIsLoadBearing ? 'ok' : 'NO'}; detector teeth: ${detectorHasTeeth ? 'ok' : 'BLIND'}${skipped ? ` — ${skipped}` : ''}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.specLayer) {
    const { pass, offByDefault, onCreatesLayer, noStackLeak, onDemandNotResident, budgetHeld, reRunSkips, flagValueRefused, purityHeld, artifactsDeclareLayer, specSize, specLines, error } = selfCheck.specLayer;
    lines.push(`  Spec layer: ${pass ? 'PASS' : 'FAIL'} — without --spec-layer the run is unchanged: ${offByDefault ? 'ok' : 'CHANGED'}; with it the two documents exist: ${onCreatesLayer ? 'ok' : 'NO'}; the detected stack never fills the mission: ${noStackLeak ? 'ok' : 'LEAKED'}; pointed at as read-on-demand, not resident: ${onDemandNotResident ? 'ok' : 'RESIDENT'}; the artifact contract names them: ${artifactsDeclareLayer ? 'ok' : 'MISSING'}; still inside the same budget (${specSize} bytes, ${specLines} lines): ${budgetHeld ? 'ok' : 'BUSTED'}; a re-run leaves an edited one alone: ${reRunSkips ? 'ok' : 'OVERWROTE'}; a value on the switch is refused: ${flagValueRefused ? 'ok' : 'ACCEPTED'}; no external system named, and the predicate proven on them: ${purityHeld ? 'ok' : 'NAMED OR BLIND'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.nextSteps) {
    const { pass, generatorAgrees, fallbackAgrees, ownGateAgrees, authorizesRatherThanSelects, detectorHasTeeth, error } = selfCheck.nextSteps;
    lines.push(`  Next-steps agreement: ${pass ? 'PASS' : 'FAIL'} — the generated gate carries the shared literal: ${generatorAgrees ? 'ok' : 'DRIFTED'}; the hand-copy fallback agrees: ${fallbackAgrees ? 'ok' : 'DRIFTED'}; this repository's own gate agrees: ${ownGateAgrees ? 'ok' : 'DRIFTED'}; it authorizes rather than telling the agent to pick its own task: ${authorizesRatherThanSelects ? 'ok' : 'SELECTS'}; detector teeth: ${detectorHasTeeth ? 'ok' : 'BLIND'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.reportContract) {
    const { pass, honouredFlag, reported = [], claimsModel, seededCaught, error } = selfCheck.reportContract;
    lines.push(`  Report contract: ${pass ? 'PASS' : 'FAIL'} — --html honoured by the renderer: ${honouredFlag ? 'ok' : 'DROPPED (wrote to the default path)'}; report names the model's subsystem count: ${claimsModel ? 'ok' : 'NO'}; contradicting claim: ${reported.length === 0 ? 'none' : `FOUND (${reported.join(', ')})`}; seeded violation caught: ${seededCaught ? 'ok' : 'NO'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.taskContract) {
    const { pass, missing = {}, teeth, forbidWitness, oldFormsRejected, error } = selfCheck.taskContract;
    lines.push(`  Task authorization: ${pass ? 'PASS' : 'FAIL'} — the generated file scopes work to what the user authorized, missing: ${(missing || []).join(', ') || 'none'}; per-requirement teeth: ${teeth ? 'ok' : 'BLIND'}; forbidden-list witness: ${forbidWitness ? 'ok' : 'BLIND'}; pre-09-29 sentences refused: ${oldFormsRejected ? 'ok' : 'ACCEPTED'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.maintContract) {
    const { pass, missing = [], teeth, tableRemovedRefused, oldRowRejected, error } = selfCheck.maintContract;
    lines.push(`  Maintenance contract: ${pass ? 'PASS' : 'FAIL'} — a full audit score still routes to the actual misalignment check instead of ending the review, missing: ${missing.join(', ') || 'none'}; per-guard teeth: ${teeth ? 'ok' : 'BLIND'}; whole content-review table removed: ${tableRemovedRefused ? 'ok' : 'ACCEPTED'}; retired short-circuit row refused: ${oldRowRejected ? 'ok' : 'ACCEPTED'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.noDeadDecls) {
    const { pass, dead = [], ghostKeys = [], missingKeys = [], duplicateKeys = [], unreadFlags = [], declaredCount, helpEntries, teethDeclarations, teethHelp, teethFlags, undocumentedFlags = [], lyingFlags = [], artifactFlagBaseline, error } = selfCheck.noDeadDecls;
    lines.push(`  Orphan declarations: ${pass ? 'PASS' : 'FAIL'} — ${declaredCount} top-level declarations under scripts/, all read somewhere in the tree: ${dead.length === 0 ? 'ok' : `${dead.length} UNREAD (${dead.join(', ')})`}; ${helpEntries} numbered --help entries vs ${SELF_CHECK_GROUPS.length} group keys, equal in both directions: ${ghostKeys.length === 0 && missingKeys.length === 0 && duplicateKeys.length === 0 ? 'ok' : `NO (ghost: ${ghostKeys.join(', ') || 'none'}; missing entry: ${missingKeys.join(', ') || 'none'}; twice: ${duplicateKeys.join(', ') || 'none'})`}; documented-but-unread generator flags: ${unreadFlags.length === 0 ? 'none' : unreadFlags.join(', ')}; flags missing from the Usage synopsis: ${(selfCheck.noDeadDecls.missingFromSynopsis || []).length === 0 ? 'none' : selfCheck.noDeadDecls.missingFromSynopsis.join(', ')}; a flag that ADDS artifacts and is missing from SKILL.md: ${undocumentedFlags.length === 0 ? `none (baseline ${artifactFlagBaseline} files)` : `UNDOCUMENTED ${undocumentedFlags.join(', ')}`}; artifact-adding fixtures that do not actually add: ${lyingFlags.length === 0 ? 'none' : lyingFlags.join(', ')}; detector teeth: declarations ${teethDeclarations ? 'ok' : 'BLIND'}, help ${teethHelp ? 'ok' : 'BLIND'}, flags ${teethFlags ? 'ok' : 'BLIND'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.gateArgs) {
    const { pass, refusalsCaught = 0, refusalsTotal = 0, refusalExits, teethThresholds, teethSelfCheck, zeroStillRuns, accepted = [], misreported = [], error } = selfCheck.gateArgs;
    lines.push(`  Gate switches: ${pass ? 'PASS' : 'FAIL'} — this script cannot be switched off: ${refusalsCaught}/${refusalsTotal} malformed invocations refused, each exiting 2: ${refusalExits ? 'ok' : 'NO'}; non-numeric thresholds still accepted once the refusal is deleted: ${teethThresholds ? 'ok' : 'BLIND'}; --no-self-check still accepted once its refusal is deleted: ${teethSelfCheck ? 'ok' : 'BLIND'}; --min-score=0 still runs: ${zeroStillRuns ? 'ok' : 'REFUSED'}${accepted.length ? `; wrongly accepted: ${accepted.join(', ')}` : ''}${misreported.length ? `; refusal without a usable message: ${misreported.join(', ')}` : ''}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.reportCoverage) {
    const { pass, unbound = [], missingLines = [], orphanLines = [], missingConsole = [] } = selfCheck.reportCoverage;
    lines.push(`  Report coverage: ${pass ? 'PASS' : 'FAIL'} — every self-check group is bound, gated, reported and shown on the console: ${pass ? 'ok' : `NO (unbound: ${unbound.join(', ') || 'none'}; missing report line: ${missingLines.join(', ') || 'none'}; orphan line: ${orphanLines.join(', ') || 'none'}; missing console line: ${missingConsole.join(', ') || 'none'})`}`);
  }
  if (!selfCheck.pass && selfCheck.error) lines.push(`  ${selfCheck.error}`);
  if (selfCheck.failedGroups?.length) lines.push(`  Failing self-check group(s): ${selfCheck.failedGroups.join(', ')}`);
  return lines;
}

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
    const scaffolded = await loadHarnessFiles(dir);
    const scored = scoreHarness(scaffolded, { references: await collectCommandReferences(dir, scaffolded) });
    const minScore = thresholds.minSelfCheckScore;
    // Driven by SELF_CHECK_GROUPS rather than a hand-written conjunction: the previous version listed
    // each group three times (call, conjunction, return object), so a new group could be computed and
    // printed while never joining the pass — a gate that reports and gates nothing.
    const groupChecks = {
      budget: () => checkSkillBudget(),
      agentsBudget: () => checkAgentFileBudget(),
      agentsDiscover: () => checkAgentFileDiscoverability(),
      artifactPurity: () => checkArtifactPurity(),
      maintenance: () => checkMaintenanceTrigger(),
      skillDesign: () => checkSkillDesignRule(),
      wrapupOutput: () => checkWrapupOutputs(),
      dryRun: () => checkDryRun(),
      selfRefs: () => checkSelfReferencePaths(),
      references: () => checkCommandReferences(),
      bottleneckTies: () => checkBottleneckTies(),
      foreignAudit: () => checkForeignAudit(),
      blankGate: () => checkBlankProjectGate(),
      blueprint: () => checkBlueprintSlot(),
      agentFile: () => checkAgentFileInvariant(),
      initGrowth: () => checkInitGrowth(),
      specLayer: () => checkSpecLayer(),
      agentsLayer: () => checkAgentsLayer(),
      nextSteps: () => checkNextStepsAgreement(),
      reportContract: () => checkReportContract(),
      taskContract: async () => (await evaluateContracts()).taskContract,
      maintContract: () => checkMaintContract(),
      noDeadDecls: () => checkNoDeadDeclarations(),
      gateArgs: () => checkGateArgs()
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
    // The console layer is asserted from the lines that will actually be printed, produced by the
    // same function the flow above prints from: a declared label the block never emits is the
    // "prose nothing backs" failure, and a group whose result never reaches the console is the
    // console-only defect seen from the other side. Both were possible before this arm existed.
    const consolePreview = consoleSelfCheckLines({ ...groups, reportCoverage, score: scored.overall, pass: true });
    reportCoverage.missingConsole = SELF_CHECK_GROUPS.filter((key) => {
      const label = CONSOLE_GROUP_LABELS.get(key);
      return !label || !consolePreview.some((line) => line.startsWith(`  ${label}:`));
    });
    reportCoverage.pass = reportCoverage.pass && reportCoverage.missingConsole.length === 0;
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
  // The multiplier has no other mechanical carrier, so it gets asserted instead of trusted. Darwin —
  // the tool that drove this file's reductions — caps an optimized SKILL.md at 150% of the size it
  // started from, so a multiplier above 1.5 breaks that contract, and one at or below 1.0 would mean
  // the file may only ever shrink. Either is a typo, not a decision: without this arm a 12.5 would
  // yield a 120 KB ceiling and every other check in this suite would still be green.
  const multiplierSane = SKILL_MD_GROWTH > 1 && SKILL_MD_GROWTH <= SKILL_MD_GROWTH_CEILING;
  return {
    pass: size <= SKILL_MD_MAX_BYTES && lineEndingInvariant && multiplierSane,
    multiplierSane,
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

// The spec layer, and the switch that gates it. Six arms, because the flag has three failure modes
// that look alike from the outside: a layer that appears when nobody asked (the default changed),
// a project fact invented from the detected stack, and a "read on demand" file that quietly became
// a resident one. Each gets its own arm, and the default arm is the load-bearing one — a feature
// that only tests itself ON proves nothing about the run that never passed the flag.
//
// ARM 3 is the one worth stating out loud: the fixture has a real manifest, so a stack IS detected
// and `tech-stack.md` genuinely says `typescript`. It then requires `mission.md` to contain no stack
// word at all. That is the check the whole feature could fail silently on, because a filled-in-
// looking mission reads like an aligned answer and would be scored 100/100 by every other group.

// The detail layer is the one feature here with no switch: every render ships it. That makes the
// existence arms the load-bearing ones — an opt-in feature can be proven by its absence, this one
// can only be proven by its presence — while the append arms carry the part a default-only feature
// actually risks, which is landing in an instruction file someone else wrote.
async function checkAgentsLayer() {
  let dir;
  let foreignDir;
  let offDir;
  const result = {
    pass: false, defaultShipsLayer: false, navigationComplete: false, artifactsDeclareLayer: false,
    onDemandNotResident: false, layerBudgetHeld: false, appendPreserves: false,
    thirdPartySurvives: false, appendIdempotent: false, anchorsIntact: false, defaultRouteReadable: false,
    switchSuppressesFiles: false, switchClearsRoute: false, switchValueRefused: false
  };
  const LAYER_FILES = ['harness-creator-verification.md', 'harness-creator-maintenance.md'];
  try {
    const script = path.join(scriptDir, 'create-harness.mjs');

    dir = await mkdtemp(path.join(os.tmpdir(), 'harness-layer-'));
    await execFileAsync('node', [script, '--target', dir]);
    const agents = await readText(path.join(dir, 'AGENTS.md'));

    const layerBodies = await Promise.all(LAYER_FILES.map((name) => readText(path.join(dir, 'docs', 'agents', name))));
    result.defaultShipsLayer = layerBodies.every((body) => body.trim().length > 0);

    // The default path is the one every user takes, so it needs its own reading of the routing
    // sentence, not just the presence of the documents. A regression put 细则 at the end of the
    // document list, where it read as a fourth file to open rather than a route onward — and every
    // file-existence arm still passed, because the file did exist. The name has to sit before the
    // verb for it to mean what it is.
    result.defaultRouteReadable = /按「细则」与「必需产物」指向/.test(agents);

    // Navigation and artifact contract are separate on purpose: a layer that exists but is never
    // named is unreachable, and one that is named in the routing section but missing from the
    // artifact list tells the agent every session that this repo shipped two files.
    const nav = (agents.split(/^##\s+/m).slice(1).find((part) => part.startsWith('细则')) || '');
    result.navigationComplete = LAYER_FILES.every((name) => nav.includes(name)) &&
      (nav.match(/^###\s+\S/gm) || []).length === LAYER_FILES.length;
    const artifacts = (agents.split(/^##\s+/m).slice(1).find((part) => part.startsWith('必需产物')) || '');
    result.artifactsDeclareLayer = LAYER_FILES.every((name) => artifacts.includes(name));

    // Read-on-demand, not resident: the whole reason the detail moved out is that it must NOT cost
    // every session its context. A "必读" on these files would put back what the split removed.
    result.onDemandNotResident = SPEC_LAYER_ON_DEMAND.test(agents) && !RESIDENT_READING.test(agents) &&
      SPEC_LAYER_ON_DEMAND.test(nav) && layerBodies.every((body) => SPEC_LAYER_ON_DEMAND.test(body));

    result.layerBudgetHeld = layerBodies.every((body) => {
      const text = body.replace(/\r\n/g, '\n');
      return Buffer.byteLength(text, 'utf8') <= AGENTS_LAYER_MAX_BYTES && text.split('\n').length <= AGENTS_LAYER_MAX_LINES;
    });

    // The anchors --add-check inserts between. The detail layer rewrites the closing instructions
    // of the very file those anchors live in, so this arm proves the rewrite did not move them — an
    // --add-check that now refuses forever is a silent feature loss.
    const init = await readText(path.join(dir, 'init.sh'));
    const opens = init.split('\n').filter((line) => line.trim() === 'RAN=0').length;
    const closes = init.split('\n').filter((line) => line.trim() === 'if [ "$RAN" -eq 0 ]; then').length;
    result.anchorsIntact = opens === 1 && closes === 1 && init.indexOf('RAN=0') < init.indexOf('if [ "$RAN" -eq 0 ]; then');

    // The append: a repository whose instruction file another setup skill wrote first. Every byte it
    // already had must come back unchanged, its block must survive, and a second run must not
    // append a second copy.
    foreignDir = await mkdtemp(path.join(os.tmpdir(), 'harness-layer-foreign-'));
    const foreignPath = path.join(foreignDir, 'AGENTS.md');
    const existing = '# AGENTS.md\n\n## Agent skills\n\n### Issue tracker\n\nLocal Markdown. See `docs/agents/issue-tracker.md`.\n';
    await writeText(foreignPath, existing);
    await execFileAsync('node', [script, '--target', foreignDir]);
    const appended = await readText(foreignPath);
    result.appendPreserves = appended.startsWith(existing);
    result.thirdPartySurvives = /## Agent skills/.test(appended) && /Local Markdown\./.test(appended);
    await execFileAsync('node', [script, '--target', foreignDir]);
    const twice = await readText(foreignPath);
    result.appendIdempotent = (twice.match(/^## 细则$/gm) || []).length === 1;

    // The off switch. It exists because "on by default" must not mean "the only way out is to
    // overrule the agent" — a user who authorized exactly two files had no way to say so, and the
    // only compliant move left was to build nothing. Two things must hold, and the second is the
    // one that gets forgotten: suppressing the files is easy, but an instruction file still naming
    // docs/agents/*.md routes an agent to a file that was never written, which costs a failed open
    // and leaves it guessing whether the rule or the path is missing. So the route must go too.
    offDir = await mkdtemp(path.join(os.tmpdir(), 'harness-layer-off-'));
    await execFileAsync('node', [script, '--target', offDir, '--no-agents-layer']);
    const offFiles = await readdir(path.join(offDir, 'docs', 'agents')).catch(() => []);
    result.switchSuppressesFiles = offFiles.length === 0;
    const offAgents = await readText(path.join(offDir, 'AGENTS.md'));
    // Every way the route can outlive its section, asserted as one thing. Checking that step 2 still
    // exists proves nothing — it is there either way — so an earlier version of this arm passed
    // while the startup step still pointed at a 细则 section that was never rendered. The word is
    // what an agent acts on, so its absence is the thing worth asserting.
    result.switchClearsRoute = !LAYER_FILES.some((name) => offAgents.includes(name))
      && !/^## 细则$/m.test(offAgents) && !offAgents.includes('细则') && /^\s*2\. \*\*/m.test(offAgents);

    // A bare flag is a switch. Handing it a value would otherwise let "--no-agents-layer=false"
    // read as an instruction to write the layer the caller just asked to omit.
    const valueRun = await execFileAsync('node', [script, '--target', offDir, '--no-agents-layer=false'])
      .then(() => 0)
      .catch((error) => error.code ?? 1);
    result.switchValueRefused = valueRun !== 0;

    result.pass = result.defaultShipsLayer && result.navigationComplete && result.artifactsDeclareLayer
      && result.onDemandNotResident && result.layerBudgetHeld && result.appendPreserves
      && result.thirdPartySurvives && result.appendIdempotent && result.anchorsIntact
      && result.defaultRouteReadable
      && result.switchSuppressesFiles && result.switchClearsRoute && result.switchValueRefused;
    return result;
  } catch (error) {
    return { ...result, pass: false, error: error.message };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
    if (foreignDir) await rm(foreignDir, { recursive: true, force: true });
    if (offDir) await rm(offDir, { recursive: true, force: true });
  }
}

async function checkSpecLayer() {
  let plainDir;
  let specDir;
  let leakDir;
  const result = {
    pass: false, offByDefault: false, onCreatesLayer: false, noStackLeak: false,
    onDemandNotResident: false, budgetHeld: false, reRunSkips: false, flagValueRefused: false,
    artifactsDeclareLayer: false
  };
  try {
    const script = path.join(scriptDir, 'create-harness.mjs');
    const manifest = JSON.stringify({ name: 'spec-fixture', version: '1.0.0', dependencies: { typescript: '^5' } });

    // Arm 1: the default run. Exactly two artifacts, and the instruction file must not so much as
    // mention the layer. The unresolved-placeholder arm is here rather than assumed: a template slot
    // that renders to '' still sits in the source, and the day someone types the name wrong the
    // default render ships a literal `{{SPEC_LAYER_NOTE}}` into every project that never asked.
    // The default run now also carries the detail layer, so the assertion is about the layer's ABSENCE
// where it belongs, not about a fixed file count: what --spec-layer must not do is appear on its
// own. Counting files would have failed here for the right reason at the wrong line, and would have
    // kept passing if a THIRD default artifact appeared for an unrelated reason.
    plainDir = await mkdtemp(path.join(os.tmpdir(), 'harness-speclayer-off-'));
    await execFileAsync('node', [script, '--target', plainDir]);
    const plainFiles = (await readdir(plainDir)).sort();
    const plainAgents = await readText(path.join(plainDir, 'AGENTS.md'));
    result.offByDefault = !/mission\.md|tech-stack\.md|SPEC_LAYER_NOTE|\{\{/.test(plainAgents) &&
      !(await exists(path.join(plainDir, 'mission.md'))) &&
      !(await exists(path.join(plainDir, 'tech-stack.md')));

    // Arm 2: with the flag, both documents exist. Arm 6 rides along here — the spec-layer render of
    // the instruction file is measured against the SAME budget constants as the default one, since a
    // note that fits on the default render's line count but busts the byte ceiling is still over.
    specDir = await mkdtemp(path.join(os.tmpdir(), 'harness-speclayer-on-'));
    await execFileAsync('node', [script, '--target', specDir, '--spec-layer', '--blueprint', '把散落的会议录音转成可检索的逐字稿']);
    const specFiles = (await readdir(specDir)).sort();
    const specAgentsRaw = await readText(path.join(specDir, 'AGENTS.md'));
    const specAgents = specAgentsRaw.replace(/\r\n/g, '\n');
    result.onCreatesLayer = specFiles.includes('mission.md') && specFiles.includes('tech-stack.md') &&
      specFiles.includes('AGENTS.md') && specFiles.includes('init.sh');

    // Arm 2b: the ARTIFACT CONTRACT, not just the files. Arm 2 asks whether the documents landed;
    // this asks whether the instruction file says so. They came apart once: --spec-layer shipped
    // mission.md and tech-stack.md while 必需产物 still listed two files, measured by rendering
    // both ways and finding the section byte-identical. The agent reading that file every session
    // would have been told four things were delivered by the file that delivered them — and the
    // startup-path pointer alone does not repair it, because a pointer says "you may read these",
    // while the artifact contract says "these are what you got".
    const artifactsSection = (text) => (text.split(/^##\s+/m).slice(1).find((p) => p.startsWith('必需产物')) || '');
    result.artifactsDeclareLayer = /mission\.md/.test(artifactsSection(specAgents)) &&
      /tech-stack\.md/.test(artifactsSection(specAgents)) &&
      !/mission\.md|tech-stack\.md/.test(artifactsSection(await readText(path.join(plainDir, 'AGENTS.md'))));

    const specLines = specAgents.split('\n').length;
    const specSize = Buffer.byteLength(specAgents, 'utf8');
    const specSection = specAgents.split(/^##\s+/m).slice(1).find((part) => part.startsWith('工作规则')) || '';
    const specRules = specSection.split('\n').filter((line) => /^- \*\*/.test(line)).length;
    result.budgetHeld = specSize <= AGENTS_MD_MAX_BYTES && specLines <= AGENTS_MD_MAX_LINES && specRules <= WORKING_RULES_MAX;
    result.specSize = specSize;
    result.specLines = specLines;

    // Arm 4: the pointer exists and says "on demand". The positive is required in all three files;
    // the absence is checked only in AGENTS.md, for the reason on the predicate.
    const specMission = await readText(path.join(specDir, 'mission.md'));
    const specStack = await readText(path.join(specDir, 'tech-stack.md'));
    result.onDemandNotResident = SPEC_LAYER_ON_DEMAND.test(specAgents) && /mission\.md/.test(specAgents) &&
      !RESIDENT_READING.test(specAgents) &&
      SPEC_LAYER_ON_DEMAND.test(specMission) && SPEC_LAYER_ON_DEMAND.test(specStack);

    // Arm 7: a re-run must not overwrite documents the project has since written in its own words.
    // The default render's own skip rule covers this, but only for the two artifacts it knows about;
    // a new file class that quietly skipped the check would pass every other arm here.
    const missionPath = path.join(specDir, 'mission.md');
    const missionBefore = await readText(missionPath);
    await execFileAsync('node', [script, '--target', specDir, '--spec-layer']);
    result.reRunSkips = (await readText(missionPath)) === missionBefore;

    // Arm 5: a value on a switch is refused. `--spec-layer=false` reads as a value here, and quietly
    // accepting it would make "off" mean two different things depending on how it was spelled.
    let valueRun = { stdout: '', stderr: '' };
    const valueDir = await mkdtemp(path.join(os.tmpdir(), 'harness-speclayer-value-'));
    try {
      valueRun = await execFileAsync('node', [script, '--target', valueDir, '--spec-layer=yes']);
    } catch (error) {
      valueRun = { stdout: error.stdout || '', stderr: error.stderr || '' };
    }
    result.flagValueRefused = /REFUSED/.test(valueRun.stdout + valueRun.stderr);
    await rm(valueDir, { recursive: true, force: true });

    // Arm 3, with teeth. The fixture has a manifest AND a tsconfig, so the stack is genuinely
    // detected and tech-stack.md genuinely names it — otherwise this arm would pass on a generator
    // that detected nothing at all, which is the same "found nothing because it looked for nothing"
    // shape the seeded arms elsewhere in this suite exist to rule out.
    leakDir = await mkdtemp(path.join(os.tmpdir(), 'harness-speclayer-leak-'));
    await writeText(path.join(leakDir, 'package.json'), manifest);
    await writeText(path.join(leakDir, 'tsconfig.json'), '{}');
    await execFileAsync('node', [script, '--target', leakDir, '--spec-layer']);
    const leakStack = await readText(path.join(leakDir, 'tech-stack.md'));
    const leakMission = await readText(path.join(leakDir, 'mission.md'));
    const stackActuallyDetected = /typescript/.test(leakStack);
    result.noStackLeak = stackActuallyDetected && !STACK_LEAK_PATTERN.test(leakMission) &&
      /待补/.test(leakMission);

    // Same predicate as the zero-coupling group, applied to the new artifacts rather than to a
    // fourth copy of it. A clean result from a predicate nobody seeded is worth nothing, so the
    // seeded half is carried over from the same list the other group uses.
    const specNamed = [...specMission, ...specStack].flatMap((text) => externalSystemsIn(text));
    result.purityHeld = specNamed.length === 0 &&
      EXTERNAL_SYSTEM_SEEDS.every((name) => externalSystemsIn(`${specMission}\n${specStack}\n${name}`).length === 1);

    // purityHeld is in here, and its first absence was mine: the arm was computed, printed nowhere,
    // and left out of this conjunction — a check that is computed but never gates is the exact
    // "report and gate nothing" defect the coverage group exists to catch, written by the same hand
    // that wrote that group. It is now an arm like the rest, and the report line names it so the
    // console shows a field the verdict actually depends on.
    result.pass = result.offByDefault && result.onCreatesLayer && result.noStackLeak &&
      result.onDemandNotResident && result.budgetHeld && result.reRunSkips &&
      result.flagValueRefused && result.purityHeld && result.artifactsDeclareLayer;
    return result;
  } catch (error) {
    return { ...result, error: error.message };
  } finally {
    for (const target of [plainDir, specDir, leakDir]) if (target) await rm(target, { recursive: true, force: true });
  }
}

// One next-steps literal, two producers. The generated init.sh and the hand-copy fallback
// templates/init.sh are separate strings that must agree: they were NOT agreeing, and the drift was
// a contradiction rather than a cosmetic difference. The generator told the agent to "Pick ONE
// unfinished piece of work" in the success banner — i.e. to select its own next task — in the same
// breath as the instruction file it ships beside, whose working rules say the opposite
// ("推进需显式授权 … 已有的记录与清单是上下文，不是待办队列"). Both files passed every other group.
//
// Compared, not grepped. A phrase detector would have been satisfied by BOTH drifting copies at
// once, which is the whole defect; the only assertion that can fail here is set equality between the
// block the generator renders and the block the fallback carries.
//
// The third producer is this repository's own ./init.sh. It is a real instance of the same artifact
// and it had the retired wording too, so it is read as well — a check that only compares the two
// shipped templates would let the local gate drift back while the check stayed green.
async function checkNextStepsAgreement() {
  const result = {
    pass: false,
    generatorAgrees: false,
    fallbackAgrees: false,
    ownGateAgrees: false,
    authorizesRatherThanSelects: false,
    detectorHasTeeth: false
  };
  let dir;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), 'harness-nextsteps-'));
    await execFileAsync('node', [path.join(scriptDir, 'create-harness.mjs'), '--target', dir]);
    const rendered = await readText(path.join(dir, 'init.sh'));

    // The block is everything after the banner, so the comparison cannot be satisfied by a mention
    // of the wording anywhere else in the file.
    //
    // Trailing newline trimmed, and the banner line itself kept in the block on both sides: a
    // generator ends the file with "\n" after the last echo while the templates are read the same
    // way, so comparing raw tails would report drift on all three for a byte that is not content.
    // That is the failure this check exists to catch — a comparison that is wrong in a way that
    // looks like the finding it was built for.
    const blockOf = (text) => text.slice(text.indexOf('echo "Next steps:"')).trimEnd();
    const expected = ['echo "Next steps:"', ...NEXT_STEPS.map((line) => `echo "${line}"`)].join('\n');

    result.generatorAgrees = blockOf(rendered) === expected;
    result.fallbackAgrees = blockOf(await readText(path.join(skillRoot, FALLBACK_INIT_TEMPLATE))) === expected;
    result.ownGateAgrees = blockOf(await readText(path.join(skillRoot, 'init.sh'))) === expected;

    // The property the wording exists to carry, asserted on the rendered artifact rather than on the
    // constant — otherwise a constant that lost the clause would still pass the equality above.
    result.authorizesRatherThanSelects = /explicitly authorized/.test(rendered) &&
      !/Pick ONE unfinished/.test(rendered);

    // Teeth: substitute the retired wording into the rendered copy and require the comparison to
    // fail. Without this, a comparator that compared nothing would report agreement on all three.
    const drifted = rendered.replace(expected, expected.replace(
      /2\. Work only on what the user has explicitly authorized[\s\S]*?looks obvious/,
      '2. Pick ONE unfinished piece of work whose prerequisites are clear'
    ));
    result.detectorHasTeeth = drifted !== rendered && blockOf(drifted) !== expected;

    result.pass = result.generatorAgrees && result.fallbackAgrees && result.ownGateAgrees &&
      result.authorizesRatherThanSelects && result.detectorHasTeeth;
    return result;
  } catch (error) {
    return { ...result, error: error.message };
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

// A pure predicate so the check can strip a term from the live render and require the verdict to
// change. Declared here, ahead of the runSelfCheck() call site, for the temporal-dead-zone reason
// recorded above the SELF_CHECK_GROUPS list.
function selfRestraintRuleStated(text) {
  return /长期不变量/.test(text) && (/本文件自我约束/.test(text) || /不超过\s*8\s*条/.test(text));
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
    const selfRestraintStated = selfRestraintRuleStated(rendered);
    // Teeth: dropping either half of the rule — the invariant the section holds, or the cap that
    // bounds it — must turn it red, so the shorter lead-in cannot make it a constant.
    const selfRestraintTeeth = !selfRestraintRuleStated(rendered.split('长期不变量').join(''))
      && !selfRestraintRuleStated(rendered.split('不超过 8 条').join(''));
    const seeded = `${rendered}\n## 目录结构\n\n\`\`\`\n├── src\n└── dist\n\`\`\`\n\n- 技术栈：React + TypeScript\n`;
    const seededCaught = discoverableOffenders(seeded).length >= 2;
    return { pass: offenders.length === 0 && selfRestraintStated && selfRestraintTeeth && seededCaught, offenders, selfRestraintStated, selfRestraintTeeth, seededCaught };
  } catch (error) {
    return { pass: false, offenders: [], selfRestraintStated: false, selfRestraintTeeth: false, seededCaught: false, error: error.message };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}
// Scoped to the wrap-up section for the same reason the predicate is, and removing EVERY occurrence
// of the term rather than the first: a term that appears in both the step's heading and its body
// (会话产出 does) would otherwise survive the strip, and the arm would report BLIND on a render that
// is in fact correctly keyed. The arm asks "is this term gone?", so it has to make it gone.
function maintenanceWithout(text, term) {
  const section = maintenanceSection(text);
  return section ? text.replace(section, section.split(term).join('')) : text;
}

// The artifact must come out clean, and "clean" has two halves that both need a carrier.
//
// This group exists because the previous owner of these two claims was deleted with the tier it
// belonged to, and deleting a check function without deleting what it read leaves the assertion
// behind with nothing behind IT. Measured: `FORBIDDEN_IN_AGENTS_MD` had zero call sites and
// `SEEDED_VIOLATION` had zero call sites, the README still stated the forbidden list "proves the
// detector is not blind", and seeding `feature_list.json`, 产物追踪策略, 受控放行 and 提示安装 into
// the template still produced Self-check PASS. So both halves are re-attached here, and the seeded
// arm is what tells the two apart: a detector that finds nothing because the artifact is clean is
// indistinguishable from one that looks for nothing.
//
// The vendor half has no pattern to match, by design — there is no list of names any more, because a
// list is exactly what rots when the upstream renames. What is left is checkable: the rendered file
// must not name ANY third-party system, which is asserted by seeding a representative name and
// requiring the predicate to catch it. That way a future name cannot slip in unannounced, while the
// predicate itself needs no maintenance when the ecosystem changes.
// A declaration nobody reads is an assertion with no carrier, and it is the failure mode this file
// produced most recently: deleting three self-check groups left `FORBIDDEN_IN_AGENTS_MD` and
// `SEEDED_VIOLATION` with zero call sites, while the README still stated the forbidden list was
// "proven not blind". Nothing failed, because a claim with no reader cannot fail — and the symptom
// only showed up when a judge seeded the forbidden phrases into the template and the self-check
// stayed green.
//
// So the rule is mechanical, in three halves. Every top-level declaration under scripts/ must be
// read somewhere else in the tree; every flag the generator's --help documents must be a flag it
// reads; and the keys annotated in this file's --help must equal SELF_CHECK_GROUPS in both
// directions. All three are read off the sources themselves rather than a hand-maintained list,
// because a hand-kept list is the same thing that rotted in the first place.

// Line comments are prose, and prose names the thing it describes — so a name that survives only in
// a comment would read as "used" and turn the whole arm blind. `://` is excluded so a URL inside a
// string is not mistaken for the start of a comment.
//
// Declared as hoisted functions, not const arrows, on purpose. `runSelfCheck()` is invoked from the
// top-level flow above this point, so any const below it is still in its temporal dead zone when
// this group runs. That file has paid for that mistake five times; making these declarations
// immune removes the sixth chance instead of relocating it again.
function stripLineComments(source) {
  return source
    .split('\n')
    .map((line) => {
      const at = line.search(/(?<!:)\/\//);
      return at === -1 ? line : line.slice(0, at);
    })
    .join('\n');
}

// Every top-level name the tree declares. `export` counts on purpose: a helper a sibling file calls
// is not dead. That is also why the counts below run over the whole tree rather than one file —
// scoping them to a single file reported all sixteen exported helpers as orphans, which is an arm
// measuring the wrong thing rather than an arm finding anything.
//
// The const pattern used to demand UPPER_SNAKE_CASE, which made this arm blind to every camelCase
// top-level const — including arrow-function helpers, the most common shape at module scope. It read
// "every top-level name the tree declares" while quietly exempting a whole naming style, and the proof
// is that the count sat at 165 through a change that added one: the new one was invisible to its own
// detector. Found 10-08, and widened to every identifier a binding can legally have.
function declaredNamesIn(source) {
  const names = new Set();
  for (const match of source.matchAll(/^(?:export\s+)?const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/gm)) names.add(match[1]);
  for (const match of source.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/gm)) names.add(match[1]);
  return [...names];
}

// How many times a name appears, counted as whole words so `TASK_CONTRACT` does not match
// `TASK_CONTRACT_OLD` and read as used. Fewer than two means: declared once, read nowhere.
function occurrencesOf(source, name) {
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
  return (source.match(re) || []).length;
}

// The --help body, read from the file rather than by running --help: a help entry naming a deleted
// group and a group with no help entry are then the same kind of mismatch seen from two sides.
//
// Each entry is read as the WHOLE numbered block, not its first line: the key closes the last line
// of the paragraph, because that is where the sentence ends, and an earlier version of this parsed
// only the opening line and therefore matched exactly one key out of nineteen.
//
// The bracketed key is what makes the help machine-checkable — the sentence is prose a human reads,
// the trailing `[key]` is the part a set comparison can hold still. An entry with no key is a step
// rather than a group, which is allowed: the equality runs group -> key, not entry -> key.
function helpEntriesIn(source) {
  const start = source.indexOf('if (args.help)');
  if (start === -1) return [];
  const body = source.slice(start, source.indexOf('process.exit(0);', start));
  const heads = [...body.matchAll(/^[ \t]*(\d+)\.[ \t]+[A-Z][^\n]*/gm)];
  return heads.map((m, i) => {
    const block = body.slice(m.index, heads[i + 1] ? heads[i + 1].index : body.length);
    return { number: Number(m[1]), key: block.match(/\[([a-zA-Z][a-zA-Z0-9]*)\]\s*$/)?.[1] ?? null };
  });
}

// Every --flag mentioned anywhere in a script's --help body, as the bare flag name.
function helpFlagsIn(source) {
  const start = source.indexOf('if (args.help)');
  if (start === -1) return [];
  const body = source.slice(start, source.indexOf('process.exit(0);', start));
  return [...new Set([...body.matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1]))];
}

// parseArgs turns --dry-run into args.dryRun, so the reading of a documented flag is a property of
// that one transformation. Checking it here means a flag can stay documented after the code that
// honoured it is deleted, which is the same shape as a check with no call site: a reader is told
// about a switch that no longer does anything.
function readsFlag(code, flag) {
  const camel = flag.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
  return new RegExp(`args\\.${camel}\\b`).test(code);
}

// Half 4 of the orphan hunt: a flag that changes WHAT THE USER ENDS UP HOLDING must be named in
// SKILL.md, the document an agent reads first.
//
// The three halves above all run one direction — a declaration with no reader, a group key with no
// help entry, a documented flag the code stopped reading. What none of them can see is the opposite
// of half 3's failure: a flag that works PERFECTLY. `--spec-layer` was read by the generator,
// advertised in its own `--help`, given two templates and a self-check group — and appeared nowhere
// in SKILL.md, for an entire session, with the suite green throughout. Nothing was broken except the
// document a user is supposed to learn the flag from.
//
// Why "adds files" is the trigger and not "is a flag": SKILL.md ends its options line with 其余见
// `--help`, so most flags legitimately live only there, and demanding all of them would break a
// deliberate design. A flag that adds an artifact CLASS is different — it changes what the user is
// holding afterwards, which is the one thing the entry document exists to tell them.
//
// The list is a literal on purpose. Derived from the generator it would agree with the generator by
// construction, and deleting a row would delete the check with it — the self-shrinking table this
// suite has already been bitten by twice. The behavioural half is what stops it drifting the other
// way: every row must really add a file when run, so a fixture that CLAIMS a flag adds artifacts and
// does not fails on its own lie rather than passing on its own word.

async function checkArtifactAddingFlagsDocumented() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'harness-artifactflags-'));
  const skill = await readText(path.join(skillRoot, 'SKILL.md'));
  const baselineDir = path.join(dir, 'baseline');
  const fileCount = async (target, extra = []) => {
    await mkdir(target, { recursive: true });
    await execFileAsync('node', [path.join(scriptDir, 'create-harness.mjs'), '--target', target, ...extra]);
    return (await readdir(target)).length;
  };
  try {
    const baseline = await fileCount(baselineDir);
    const undocumented = [];
    const dishonest = [];
    for (const flag of ARTIFACT_ADDING_FLAGS) {
      const target = path.join(dir, flag.replace(/-/g, ''));
      const withFlag = await fileCount(target, [flag]);
      // It must really add files, or the fixture is lying and the arm below would be asserting a
      // property of nothing.
      if (withFlag <= baseline) dishonest.push(`${flag} (${baseline} -> ${withFlag} files)`);
      if (!skill.includes(flag)) undocumented.push(flag);
    }
    return { pass: undocumented.length === 0 && dishonest.length === 0, baseline, undocumented, dishonest };
  } catch (error) {
    return { pass: false, undocumented: [], dishonest: [], error: error.message };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function checkNoDeadDeclarations() {
  try {
    const own = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const generator = readFileSync(path.join(scriptDir, 'create-harness.mjs'), 'utf8');
    const utils = readFileSync(path.join(scriptDir, 'lib', 'harness-utils.mjs'), 'utf8');
    const sources = [own, generator, utils];

    // Half 1: a declaration with no reader.
    const corpus = sources.map(stripLineComments).join('\n');
    const declared = [...new Set(sources.flatMap(declaredNamesIn))];
    const dead = declared.filter((name) => occurrencesOf(corpus, name) < 2);

    // Half 2: this --help against the group list, in both directions.
    const groups = new Set(SELF_CHECK_GROUPS);
    const help = helpEntriesIn(own);
    const annotated = help.filter((entry) => entry.key !== null).map((entry) => entry.key);
    const ghostKeys = [...new Set(annotated)].filter((key) => !groups.has(key));
    const missingKeys = [...groups].filter((key) => !annotated.includes(key));
    const duplicateKeys = [...new Set(annotated.filter((key, i) => annotated.indexOf(key) !== i))];

    // Half 3: the generator's documented flags against the flags it reads.
    const generatorCode = stripLineComments(generator);
    const unreadFlags = helpFlagsIn(generator).filter((flag) => !readsFlag(generatorCode, flag));

    // Half 4: the one-line Usage synopsis against the --help body. These are two lists a human
    // maintains by hand and nothing related connected them, so they drifted: --spec-layer was
    // documented in the body and omitted from the synopsis for as long as both existed. The
    // synopsis is the line someone copies when they have not read the body, so a flag missing from
    // it is a flag that looks unsupported.
    const usageLine = generator.match(/Usage:[^\n]*/)?.[0] || '';
    const synopsisFlags = new Set([...usageLine.matchAll(/--([a-z][a-z-]*)/g)].map((m) => m[1]));
    const missingFromSynopsis = helpFlagsIn(generator).filter((flag) => !synopsisFlags.has(flag));

    // Teeth, one planted orphan per half. A detector that finds nothing because the tree is clean
    // is indistinguishable from one that looks for nothing, which is the same reason the other
    // eighteen groups each carry a seeded side. The planted pair has to be shaped so that exactly
    // one of them is unread — an earlier sample read the export side as a second orphan and the
    // arm reported its own fixture back at itself.
    const seedSource = 'const SEEDED_ORPHAN = 1;\nconst SEEDED_KEPT = 1;\nconsole.log(SEEDED_KEPT);\n';
    const seedCorpus = stripLineComments(seedSource);
    const seededDead = declaredNamesIn(seedSource).filter((n) => occurrencesOf(seedCorpus, n) < 2);
    const teethDeclarations = seededDead.length === 1 && seededDead[0] === 'SEEDED_ORPHAN';
    const teethHelp = helpEntriesIn(`if (args.help) {\n  1. Real. [budget]\n  2. Ghost. [retiredGroup]\n  process.exit(0);`)
      .some((entry) => entry.key === 'retiredGroup');
    const teethFlags = readsFlag('const args = {};\n', 'ghost-flag') === false
      && readsFlag('const args = {};\nconsole.log(args.ghostFlag);\n', 'ghost-flag') === true;

    // Half 4 — a flag that adds artifacts must be in SKILL.md. Only its DETAIL fields are folded in
    // here; the verdict is recomputed into this group's own conjunction below, so the printed PASS
    // cannot come from a sub-check nobody counted.
    const { baseline, undocumented, dishonest } = await checkArtifactAddingFlagsDocumented();

    return {
      pass: dead.length === 0 && ghostKeys.length === 0 && missingKeys.length === 0
        && duplicateKeys.length === 0 && unreadFlags.length === 0
        && missingFromSynopsis.length === 0
        && teethDeclarations && teethHelp && teethFlags
        && undocumented.length === 0 && dishonest.length === 0,
      missingFromSynopsis,
      dead,
      ghostKeys,
      missingKeys,
      duplicateKeys,
      unreadFlags,
      declaredCount: declared.length,
      helpEntries: help.length,
      teethDeclarations,
      teethHelp,
      teethFlags,
      undocumentedFlags: undocumented,
      lyingFlags: dishonest,
      artifactFlagBaseline: baseline
    };
  } catch (error) {
    return { pass: false, dead: [], ghostKeys: [], missingKeys: [], duplicateKeys: [], unreadFlags: [], error: error.message };
  }
}

// Two switches that used to turn this gate off from the command line, and the proof that they no
// longer do. Both defects were measured rather than imagined: `--self-check-only --no-self-check`
// exited 0 with the whole self-check skipped, and `--min-score=abc` exited 0 on a target scoring
// 20/100 because Number('abc') is NaN and every `score < NaN` is false.
//
// Every probe here is safe to run from inside the self-check, and that is not luck: the refusal
// sits ahead of --help and ahead of the first file read, so a malformed invocation exits at the
// refusal and the legal ones exit at --help. None of these spawns reaches runSelfCheck(), which is
// what keeps a check about this script's own entry point from recursing into itself.
//
// The teeth are two mutants of this file with the refusal logic removed, not a fixture string: a
// detector seeded with a hand-written sample only proves the detector reads its own fixture. Each
// mutant is the shipped file with one branch neutered, and the arm requires it to accept the very
// invocation the real script refuses — so if the neutering ever stops taking effect, the arm fails
// instead of quietly asserting a refusal that no longer depends on the branch.
async function checkGateArgs() {
  let dir;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), 'harness-gateargs-'));
    const source = await readText(fileURLToPath(import.meta.url));
    // The copy needs lib/harness-utils.mjs beside it or the import at the top of the file fails,
    // and a module that cannot load would satisfy the mutant arms for the wrong reason.
    const utilsSource = await readText(path.join(scriptDir, 'lib', 'harness-utils.mjs'));

    // What a caller actually sees: the exit code and both streams, merged because the refusal is
    // written to stderr with writeSync and a text that never arrives is not a usable refusal.
    const run = async (target, argv) => {
      try {
        const done = await execFileAsync('node', [target, ...argv]);
        return { code: done.code ?? 0, out: `${done.stdout || ''}${done.stderr || ''}` };
      } catch (error) {
        return { code: error.code ?? 1, out: `${error.stdout || ''}${error.stderr || ''}` };
      }
    };

    // --help rides along on every probe so a mutant that stops refusing exits immediately at the
    // help block instead of running the benchmark it was just proven unable to refuse.
    const script = fileURLToPath(import.meta.url);
    const probes = [
      { argv: ['--min-score=abc', '--help'], flag: '--min-score', raw: 'abc' },
      { argv: ['--min-eval-score=abc', '--help'], flag: '--min-eval-score', raw: 'abc' },
      { argv: ['--min-self-check-score=abc', '--help'], flag: '--min-self-check-score', raw: 'abc' },
      // parseArgs hands back `true` for a bare --flag and '' for `--flag=`; both are non-numeric
      // and both used to widen the gate silently rather than fail it.
      { argv: ['--min-score', '--help'], flag: '--min-score', raw: 'true' },
      { argv: ['--min-eval-score=', '--help'], flag: '--min-eval-score', raw: '""' },
      { argv: ['--no-self-check', '--help'], flag: '--no-self-check', raw: null }
    ];

    let refusalsCaught = 0;
    let refusalExits = true;
    const accepted = [];
    const misreported = [];
    for (const probe of probes) {
      const result = await run(script, probe.argv);
      // The refusal has to name the switch, quote back the value it rejected, and point at --help:
      // a message that only says "invalid" leaves the caller guessing which token was wrong, and
      // one that never reaches the caller is not a refusal at all.
      const named = result.out.includes(probe.flag)
        && (probe.raw === null || result.out.includes(probe.raw))
        && result.out.includes('--help lists every switch');
      if (result.code === 0) accepted.push(probe.argv.join(' '));
      else if (result.code !== 2) refusalExits = false;
      if (result.code !== 0 && named) refusalsCaught += 1;
      else if (result.code !== 0) misreported.push(probe.argv.join(' '));
    }

    // The legal override, through the same path. --min-score=0 is a threshold somebody wrote on
    // purpose, and a refusal that ate it would be indistinguishable from the defect it replaced.
    const zero = await run(script, ['--min-score=0', '--help']);
    const zeroStillRuns = zero.code === 0 && zero.out.includes('Usage:');

    // Teeth. Each mutant is this file with one branch neutered; the arm requires it to ACCEPT the
    // invocation the real script refuses, which is the only thing that proves the refusal above is
    // coming from that branch rather than from an unrelated failure.
    const writeMutant = async (name, from, to) => {
      const sub = path.join(dir, name);
      await mkdir(path.join(sub, 'lib'), { recursive: true });
      await writeFile(path.join(sub, 'lib', 'harness-utils.mjs'), utilsSource);
      const mutated = source.replace(from, to);
      // Reported rather than assumed: a replacement that matches nothing leaves a byte-identical
      // copy that still refuses, and the arm below would call that a neutered branch.
      if (mutated === source) return null;
      const mutantPath = path.join(sub, 'run-benchmark.mjs');
      await writeFile(mutantPath, mutated);
      return mutantPath;
    };
    // The anchors carry their indentation so they cannot match the string literals that name them two
    // lines below: without it, `replace` would hit whichever occurrence came first in the file, and
    // a mutation aimed at the wrong copy of the branch is a mutation that proves nothing.
    const thresholdMutant = await writeMutant('no-threshold-refusal', '\n    if (usable) continue;', '\n    if (true) continue;');
    const selfCheckMutant = await writeMutant('no-off-switch', '\n  if (args.noSelfCheck !== undefined) {', '\n  if (false) {');
    const teethThresholds = thresholdMutant !== null && (await run(thresholdMutant, ['--min-score=abc', '--help'])).code === 0;
    const teethSelfCheck = selfCheckMutant !== null && (await run(selfCheckMutant, ['--no-self-check', '--help'])).code === 0;

    return {
      pass: refusalsCaught === probes.length && refusalExits && accepted.length === 0
        && misreported.length === 0 && zeroStillRuns && teethThresholds && teethSelfCheck,
      refusalsCaught,
      refusalsTotal: probes.length,
      refusalExits,
      accepted,
      misreported,
      zeroStillRuns,
      teethThresholds,
      teethSelfCheck
    };
  } catch (error) {
    return {
      pass: false, refusalsCaught: 0, refusalsTotal: 0, refusalExits: false, accepted: [],
      misreported: [], zeroStillRuns: false, teethThresholds: false, teethSelfCheck: false, error: error.message
    };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

async function checkArtifactPurity() {
  let dir;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), 'harness-purity-'));
    await execFileAsync('node', [path.join(scriptDir, 'create-harness.mjs'), '--target', dir]);
    const agents = await readText(path.join(dir, 'AGENTS.md'));
    const init = await readText(path.join(dir, 'init.sh'));
    const rendered = `${agents}\n${init}`;

    // Half one: this skill's own retired machinery. These names are forbidden because they were its
    // own landing points and doctrine, not because they belong to anyone else.
    const leaked = FORBIDDEN_IN_AGENTS_MD.filter(({ pattern }) => pattern.test(rendered)).map(({ name }) => name);
    // Half two: no external system named. The predicate is the same seed list, so a violation and a
    // check that cannot see one are the same code path — which is what makes the seeded arm below a
    // proof of teeth rather than a second copy of the pattern list.
    const named = externalSystemsIn(rendered);

    // Teeth, per forbidden entry: seeding one term must make exactly that term report. A single blob
    // would only prove the predicates read a string; per-entry proves each pattern is load-bearing,
    // so shrinking the list is caught rather than quietly testing fewer things.
    const perEntryTeeth = FORBIDDEN_IN_AGENTS_MD.every(({ name, pattern }) => {
      const [term] = name.split(' ');
      void term;
      return !pattern.test(rendered) && pattern.test(`${rendered} ${seedPhraseFor(name)}`);
    });
    const seeded = FORBIDDEN_IN_AGENTS_MD.filter(({ pattern }) => pattern.test(`${rendered}${SEEDED_VIOLATION}`));
    const seededAll = seeded.length === FORBIDDEN_IN_AGENTS_MD.length;

    // Same two arms for the vendor half: the real render is clean, and a seeded name is caught.
    const externalTeeth = EXTERNAL_SYSTEM_SEEDS.every((name) => externalSystemsIn(rendered).length === 0
      && externalSystemsIn(`${rendered}\n${name}`).length === 1);

    // Half three: this skill's OWN --help bodies. The generated artifacts were the stated
    // requirement, but the refactor's actual failure mode was a help text still telling a reader to
    // go use a named third-party tool. A manual sweep walked straight past it, because it sits in a
    // template literal and reads like a comment — so nothing else here can see it either: this group
    // reads the GENERATED files, and the dead-declaration check reads keys and flags, not prose.
    const helpSources = ['create-harness.mjs', 'run-benchmark.mjs', 'validate-harness.mjs'].map((file) => {
      const source = readFileSync(path.join(scriptDir, file), 'utf8');
      const start = source.indexOf('if (args.help)');
      const end = source.indexOf('process.exit(0);', start);
      return { file, body: start === -1 || end === -1 ? '' : source.slice(start, end) };
    });
    const namedInHelp = helpSources.flatMap(({ file, body }) => externalSystemsIn(body).map((name) => `${file}: ${name}`));
    // An empty body would read as clean for the same reason a skipped check reads as coverage, so
    // every one of the three has to actually have been located.
    const helpBodiesLocated = helpSources.every(({ body }) => body.trim().length > 0);

    return {
      pass: leaked.length === 0 && named.length === 0 && perEntryTeeth && seededAll && externalTeeth
        && namedInHelp.length === 0 && helpBodiesLocated,
      leaked,
      named,
      perEntryTeeth,
      seeded: seeded.length,
      total: FORBIDDEN_IN_AGENTS_MD.length,
      externalTeeth,
      namedInHelp,
      helpBodiesLocated
    };
  } catch (error) {
    return {
      pass: false, leaked: [], named: [], perEntryTeeth: false, seeded: 0, total: 0,
      externalTeeth: false, namedInHelp: [], helpBodiesLocated: false, error: error.message
    };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

// The predicate and its seed list are declared with the group above rather than beside the rest of
// the suite's constants, for the temporal-dead-zone reason this file records four times already:
// `runSelfCheck()` runs before this file finishes evaluating, so a const below its first use is a
// ReferenceError that reads like a missing feature rather than an uninitialised binding.

async function checkMaintenanceTrigger() {
  let dir;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), 'harness-maintenance-'));
    await execFileAsync('node', [path.join(scriptDir, 'create-harness.mjs'), '--target', dir]);
    const rendered = await readText(path.join(dir, 'AGENTS.md'));
    const { stated, missing, leaked } = maintenanceTriggerStated(rendered);
    // Per-term arm: drop exactly one term from the wrap-up section and require the predicate to name
    // exactly that term, so a render that kept the owner name while losing the output criterion
    // cannot pass on the strength of its survivors.
    const teeth = MAINTENANCE_TERMS.every((term) =>
      maintenanceTriggerStated(maintenanceWithout(rendered, term)).missing.includes(term));
    // Negative arm: the diff-keyed sentence this gate replaced must be REJECTED outright.
    //
    // Correction, 09-26. This comment used to continue "Without it the gate would still accept that
    // sentence with the new vocabulary bolted on." That was false when written and stayed false:
    // `oldForm` is a literal fixture, so this arm exercises a string the suite never renders, and it
    // said nothing about the render it was cited to protect. Measured: a hybrid render carrying the
    // old sentence AND all three new terms reported PASS. The hybrid arm below is the assertion that
    // sentence claimed to be.
    const oldForm = `## 会话结束\n\n${MAINTENANCE_OLD_FORM}，候选改动列出后再落地；不做全仓审计\n`;
    const oldFormRejected = !maintenanceTriggerStated(oldForm).stated;
    // The retired sentence with the required vocabulary bolted on. It satisfies the positive half by
    // construction, so it is refused only by the negative half — the assertion the old comment
    // described and the code did not make.
    const hybridForm = `## 会话结束\n\n${MAINTENANCE_OLD_FORM}，按会话产出按需优化\n`;
    const hybridRejected = !maintenanceTriggerStated(hybridForm).stated;
    // Per-phrase witnesses, written out independently of MAINTENANCE_FORBIDDEN. Each form carries
    // every required term plus exactly one forbidden phrase, so it is refused exactly when that
    // phrase is still listed — which is what makes a shortened forbidden list fail instead of
    // quietly testing fewer phrases.
    const forbiddenWitness = MAINTENANCE_FORBIDDEN_FORMS.every(([phrase, form]) =>
      maintenanceTriggerStated(form).leaked.includes(phrase));
    return {
      pass: stated && teeth && oldFormRejected && hybridRejected && forbiddenWitness,
      stated,
      missing,
      leaked,
      teeth,
      oldFormRejected,
      hybridRejected,
      forbiddenWitness
    };
  } catch (error) {
    return {
      pass: false,
      stated: false,
      missing: [],
      leaked: [],
      teeth: false,
      oldFormRejected: false,
      hybridRejected: false,
      forbiddenWitness: false,
      error: error.message
    };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

// The skill's design rules are the only part of this repository no check could see, because every
// other group reads the artifact a target repo receives. This one reads SKILL.md itself, which is
// also why it needs no rendered fixture: the thing under test is the file that ships. Its shape
// mirrors checkMaintenanceTrigger deliberately — same section scoping, same all-of predicate, same
// per-term and old-form arms — plus two arms that gate does not have (the hybrid form, and the
// incomplete form that makes the required vocabulary itself provable).
function skillDesignRuleStated(text) {
  const section = skillDesignSection(text);
  const missing = SKILL_DESIGN_TERMS.filter((term) => !section.includes(term));
  const leaked = SKILL_DESIGN_FORBIDDEN.filter((phrase) => section.includes(phrase));
  return { stated: missing.length === 0 && leaked.length === 0, missing, leaked };
}

// Removes EVERY occurrence of the term rather than the first: a term appearing in both the rule and
// its own explanation would otherwise survive the strip, and the arm would report BLIND on a correct
// file. The arm asks "is this term gone?", so it has to make it gone.
function skillDesignWithout(text, term) {
  const section = skillDesignSection(text);
  return section ? text.replace(section, section.split(term).join('')) : text;
}

async function checkSkillDesignRule() {
  // No temp directory and no scaffolded harness, unlike every other group: the artifact under test
  // is a file this skill ships, not one it renders into a target repo.
  try {
    const body = await readText(path.join(skillRoot, 'SKILL.md'));
    const { stated, missing, leaked } = skillDesignRuleStated(body);
    // Per-term arm: drop exactly one term from the section and require the predicate to name exactly
    // that term, so a section that kept the scope wording while losing the criterion cannot pass on
    // the strength of its survivors. (Meaningful only alongside `stated`: a term already absent from
    // the section strips to nothing, which is why the two are conjoined rather than reported apart.)
    const teeth = SKILL_DESIGN_TERMS.every((term) =>
      skillDesignRuleStated(skillDesignWithout(body, term)).missing.includes(term));
    // Negative arm: the pre-09-25 rule line, set as the section body, must be REJECTED outright.
    const oldForm = `## 设计规则\n\n- 根指令文件保持简短：只做路由与不变量。\n${SKILL_DESIGN_OLD_FORM}\n`;
    const oldFormRejected = !skillDesignRuleStated(oldForm).stated;
    // Contradiction arm, which the maintenance gate does NOT have: the new criterion and the old diff
    // key in one sentence. Every term is present, so a terms-only predicate accepts it — and this is
    // the shape a revert-in-place actually takes. The arm is what makes "cannot pass on vocabulary
    // alone" true here rather than merely asserted in a comment.
    const hybridForm = '## 设计规则\n\n- 收尾＝按会话产出按需优化**本技能所管的文件**，'
      + '当本会话改动的部分涉及时。\n';
    const hybridRejected = !skillDesignRuleStated(hybridForm).stated;
    // List-shrink arm: each incomplete form must be refused, and it is refused by the term it is
    // missing — which is what makes the required vocabulary itself provable rather than assumed. This
    // arm exists because the eighth probe arm proved the other three do not cover it.
    const witness = SKILL_DESIGN_INCOMPLETE_FORMS.every(([term, text]) =>
      skillDesignRuleStated(`## 设计规则\n\n${text}\n`).missing.includes(term));
    return {
      pass: stated && teeth && oldFormRejected && hybridRejected && witness,
      stated,
      missing,
      leaked,
      teeth,
      oldFormRejected,
      hybridRejected,
      witness
    };
  } catch (error) {
    return {
      pass: false,
      stated: false,
      missing: [],
      leaked: [],
      teeth: false,
      oldFormRejected: false,
      hybridRejected: false,
      witness: false,
      error: error.message
    };
  }
}

// See the WRAPUP_* block above for what this asserts and why. Unlike every other group it renders
// nothing and scaffolds nothing: the artifact under test is a reference file this skill ships, so the
// check is one read plus four arms.
function wrapupJudgmentStated(text) {
  const missing = WRAPUP_TERMS.filter((term) => !text.includes(term));
  const heading = new RegExp(`^##\\s+${WRAPUP_JUDGMENT_TERM}`, 'm').test(text);
  return { stated: missing.length === 0 && heading, missing, heading };
}

// Removes EVERY occurrence rather than the first: the term appears in the procedure, in its own
// section and in the exception table, so dropping only the first would leave the arm reporting BLIND
// on a file that is in fact correctly worded.
function wrapupWithout(text, term) {
  return text.split(term).join('');
}

// Scoped to the 更新 row's own cell rather than to the file: the same two words sitting in an unrelated
// section would satisfy an unscoped check while the row that an agent actually reads stayed silent, which
// is the false-pass shape this suite keeps refusing. `row` is reported apart from `stated` so a renamed or
// restructured table says "row not found" instead of blaming the vocabulary for a row it never found.
function wrapupSkillEntryStated(text) {
  const found = text.match(WRAPUP_SKILL_ENTRY_ROW);
  const cell = found ? found[1] : '';
  const missing = WRAPUP_SKILL_ENTRY_TERMS.filter((term) => !cell.includes(term));
  return { stated: Boolean(found) && missing.length === 0, row: Boolean(found), missing };
}

async function checkWrapupOutputs() {
  try {
    const reference = await readText(path.join(skillRoot, WRAPUP_REFERENCE));
    const { stated, missing, heading } = wrapupJudgmentStated(reference);
    // Per-term arm: drop exactly one term and require the predicate to name exactly that term AND to
    // stop passing, so a term that survives only in an unrelated sentence cannot carry the gate.
    const teeth = WRAPUP_TERMS.every((term) => {
      const stripped = wrapupJudgmentStated(wrapupWithout(reference, term));
      return stripped.missing.includes(term) && !stripped.stated;
    });
    // Heading arm, proven by a fixture that keeps every term and loses only the place to put them.
    // Without this the heading requirement would rest on a regex nobody had ever seen fail.
    const headingArm = WRAPUP_HEADING_LESS_FORM.includes(WRAPUP_TERMS[0])
      && !wrapupJudgmentStated(WRAPUP_HEADING_LESS_FORM).heading;
    // List-shrink arm: each incomplete form is refused by the term it is missing, which is what makes
    // the required vocabulary provable rather than assumed (see the WRAPUP_INCOMPLETE_FORMS comment).
    // The coverage guard comes first because the witness is the only thing standing between a dropped
    // term and silence — verified 10-08 to be deletable row by row with the gate still green.
    const witnessCovers = sameTermSet(WRAPUP_TERMS, WRAPUP_INCOMPLETE_FORMS);
    const witness = witnessCovers && WRAPUP_INCOMPLETE_FORMS.every(([term, text]) =>
      wrapupJudgmentStated(text).missing.includes(term));
    // SKILL.md arm: the net-change promise has to live in the task table as well, not only in the
    // reference an agent opens once it is already maintaining — otherwise trimming the row back to its old
    // shape leaves every other gate green, which is how this gap survived until 10-08. Teeth per term,
    // and an independent witness, or the arm would rest on the same two words the row supplies.
    const skillDoc = await readText(path.join(skillRoot, 'SKILL.md'));
    const entry = wrapupSkillEntryStated(skillDoc);
    const entryTeeth = WRAPUP_SKILL_ENTRY_TERMS.every((term) => {
      const stripped = wrapupSkillEntryStated(wrapupWithout(skillDoc, term));
      return stripped.missing.includes(term) && !stripped.stated;
    });
    // The witness table and the term list must cover exactly the same words. Either one can otherwise be
    // shortened in whichever direction goes unnoticed: drop a term from the list and the surviving witnesses
    // quietly stop covering it, drop a witness and that term stops being tested at all. Compared as sets
    // because a per-entry loop passes on a list that has quietly lost its weakest member — which is exactly
    // how the first version of this guard let a witness deletion through while looking like it worked.
    // Same guard as the reference-side witness above, same reason: the first version of it was written
    // as one-way containment and a witness deletion walked straight through.
    const entryWitnessCovers = sameTermSet(WRAPUP_SKILL_ENTRY_TERMS, WRAPUP_SKILL_ENTRY_INCOMPLETE);
    const entryWitness = entryWitnessCovers && WRAPUP_SKILL_ENTRY_INCOMPLETE.every(([term, text]) =>
      wrapupSkillEntryStated(`| # | 任务 | 输入 → 输出 |\n|---|---|---|\n${text}\n`).missing.includes(term));
    return {
      pass: stated && teeth && headingArm && witness && entry.stated && entryTeeth && entryWitness,
      stated,
      heading,
      missing,
      teeth,
      headingArm,
      witnessCovers,
      witness,
      entry,
      entryTeeth,
      entryWitness
    };
  } catch (error) {
    return {
      pass: false, stated: false, heading: false, missing: [], teeth: false,
      headingArm: false, witnessCovers: false, witness: false,
      entry: { stated: false, row: false, missing: [] }, entryTeeth: false, entryWitness: false,
      error: error.message
    };
  }
}

// The skill's own shipped files are checked here too. Every command it prints has to be runnable
// from where the agent actually stands: the scripts live under the runtime's skills directory, but
// the agent's cwd is the target repo — so a printed `node scripts/<name>.mjs` dies with MODULE_NOT_FOUND,
// and the gate the agent was told to run silently never runs. That is how the mode gate got
// bypassed in practice, so the rule gets a machine check instead of another sentence. A bare
// `skills/<name>/` prefix is the same failure in another shape — a pointer the agent cannot resolve
// from a target repo — and is caught by the same arm. README.md is
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
    // Two complementary patterns, not one superseding the other. The first catches a script
    // invocation written relative to the skill repository; the second catches any bare
    // `skills/<name>/` prefix, which is what an emitted pointer looks like when it names some
    // skill's directory. Neither implies the other — `node scripts/<name>.mjs` is invisible to the
    // second, a bare `skills/<name>/` prefix is invisible to the first — and both must
    // exclude `~/.agents/skills/...`, where `skills/` is not path-initial. The second was declared
    // up top and never wired to anything, which is exactly the shape this suite calls a rule with
    // no carrier: it read as dead code while the case it guards went unchecked.
    if (RELATIVE_SELF_REFERENCE.test(text) || SKILL_RELATIVE_PATH.test(text)) offenders.push(file);
  }
  return { pass: offenders.length === 0, offenders, checked };
}

// The audit scores a dangling command reference now, and a scoring check is only worth what the
// evidence that it still detects anything is worth. This group holds that check to account with four
// fixtures, one per way it can be wrong: a reference that no longer resolves must be CAUGHT; a
// guarded one must NOT be flagged, because the generator wraps every script step and flagging it
// would fail our own output; what has no resolver must be LISTED rather than silently skipped; and a
// scan that was never collected must FAIL rather than pass on absence of evidence.
async function checkCommandReferences() {
  const fixtures = [];
  const build = async (name, manifestScripts, initText, agentText) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), `harness-refs-${name}-`));
    fixtures.push(dir);
    if (manifestScripts) {
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, scripts: manifestScripts }));
    }
    await writeFile(path.join(dir, 'init.sh'), initText);
    await writeFile(path.join(dir, 'AGENTS.md'), agentText);
    const files = await loadHarnessFiles(dir);
    return { files, references: await collectCommandReferences(dir, files) };
  };
  try {
    const danglingArm = await build('dangling', { test: 'vitest run' },
      '#!/bin/bash\nset -e\nnpm run lint\n./scripts/ci.sh\nnpm run test\n',
      '# X\n\n## Verification Commands\n\n`./init.sh`\n');
    const guardedArm = await build('guarded', { test: 'vitest run' },
      '#!/bin/bash\nset -e\nif has_script "lint"; then\n  npm run lint\nfi\nnpm run test\n',
      '# X\n\n## Verification Commands\n\n- `npm run lint`\n');
    const uncheckedArm = await build('unchecked', null, '#!/bin/bash\nset -e\npytest -q\n', '# X\n');
    const uncollectedArm = await build('uncollected', null, '#!/bin/bash\nset -e\n', '# X\n');
    // The gap the other four cannot see: a project DEFINES a check this harness never runs. The
    // gate still passes on the subset it does run, so every other bucket here stays clean while a
    // repo whose lint has never executed reports itself green. Two directions: unwired names it,
    // and wrapping the same script in a guard retires the finding.
    const unwiredArm = await build('unwired', { test: 'vitest run', lint: 'eslint .' },
      '#!/bin/bash\nset -e\nnpm run test\n', '# X\n');
    const unwiredGuardedArm = await build('unwired-guarded', { test: 'vitest run', lint: 'eslint .' },
      '#!/bin/bash\nset -e\nif has_script "lint"; then\n  npm run lint\nfi\nnpm run test\n', '# X\n');

    const danglingCaught = danglingArm.references.dangling.includes('npm run lint')
      && danglingArm.references.dangling.includes('./scripts/ci.sh');
    const guardedExcused = guardedArm.references.dangling.length === 0
      && guardedArm.references.guarded.includes('npm run lint');
    const uncheckedListed = uncheckedArm.references.unchecked.includes('pytest');
    const unwiredNamed = unwiredArm.references.unwired.includes('npm run lint');
    const unwiredRetired = unwiredGuardedArm.references.unwired.length === 0;
    // Reported, not fatal: a project choosing not to wire a check it defined is not a defect in the
    // artifacts this skill shipped, so the audit must still pass while naming it.
    const unwiredNonFatal = scoreHarness(unwiredArm.files, { references: unwiredArm.references })
      .subsystems.verification.checks.some((check) => check.pass && /1 defined but not wired: npm run lint/.test(check.message));
    // Absence of evidence must not read as evidence of absence: a scan that was never collected has
    // to fail the check, not skip it.
    const uncollectedRefused = scoreHarness(uncollectedArm.files, {}).subsystems.verification.checks
      .some((check) => !check.pass && /reference scan not collected/.test(check.message));
    return {
      pass: danglingCaught && guardedExcused && uncheckedListed && uncollectedRefused
        && unwiredNamed && unwiredRetired && unwiredNonFatal,
      danglingCaught,
      guardedExcused,
      uncheckedListed,
      uncollectedRefused,
      unwiredNamed,
      unwiredRetired,
      unwiredNonFatal,
      dangling: danglingArm.references.dangling
    };
  } catch (error) {
    return {
      pass: false,
      danglingCaught: false,
      guardedExcused: false,
      uncheckedListed: false,
      uncollectedRefused: false,
      unwiredNamed: false,
      unwiredRetired: false,
      unwiredNonFatal: false,
      dangling: [],
      error: error.message
    };
  } finally {
    for (const dir of fixtures) await rm(dir, { recursive: true, force: true });
  }
}

// Read three ways by the check below, so a detector that looks for nothing cannot pass as one that
// finds nothing: the live report must state the model's count at all, a seeded contradiction must
// be rejected, and every count other than the model's has to come back as an offender.
function subsystemClaims(text) {
  return [...String(text).matchAll(SUBSYSTEM_CLAIM)].map((match) => match[1].toLowerCase());
}

// Two halves of the report contract, which fail differently. Content that contradicts the model is
// wrong on arrival. A flag the renderer never reads is worse: parseArgs stores it, nothing consumes
// it, and the run still prints "HTML report written to ..." and exits 0 — a success line pointing at
// a path it never wrote, which is the silent degradation this skill forbids everywhere else. Both
// halves are asserted through the real renderer in a throwaway directory, not against a fixture, so
// the check covers the path that actually ships.
async function checkReportContract() {
  let dir;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), 'harness-report-'));
    const named = path.join(dir, 'named-by-flag.html');
    await execFileAsync('node', [path.join(scriptDir, 'render-assessment-html.mjs'), '--target', dir, '--html', named]);
    const honouredFlag = await exists(named);
    const fallback = path.join(dir, 'harness-assessment.html');
    const written = honouredFlag ? named : (await exists(fallback) ? fallback : null);
    const html = written ? await readText(written) : '';
    const claims = subsystemClaims(html);
    const reported = claims.filter((word) => word !== SUBSYSTEM_COUNT);
    const claimsModel = claims.length > 0;
    const seededCaught = subsystemClaims(`${html}\n<p>Five-subsystem harness report.</p>`)
      .filter((word) => word !== SUBSYSTEM_COUNT).length === 1;
    return {
      pass: honouredFlag && reported.length === 0 && claimsModel && seededCaught,
      honouredFlag,
      reported,
      claimsModel,
      seededCaught
    };
  } catch (error) {
    return { pass: false, honouredFlag: false, reported: [], claimsModel: false, seededCaught: false, error: error.message };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
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
  // The list is one-for-one with the eval file and covers the scope this skill now claims: the three
  // subsystems, the safety and measurement properties of its own tooling, and — case 15 — the
  // boundary that keeps it from handing the agent work belonging to the engineering skills. Cases
  // for the removed scope (in-repo state files, entry-template restraint, tracker mode, landing
  // points, ADR/CONTEXT routing, housekeeping, the upstream interlock lists) were deleted with that
  // scope; keeping them would have asserted the behaviour this skill no longer wants to have. The
  // delegation case replaces them: it asserts the NAMED owners instead of the artifacts they own.
  const familyEntries = [
    ['Covers minimal harness creation', /最小化/],
    // The state/handoff family used to be covered by a case asserting the NAMED owners and their
    // artifacts. It now asserts the replacement: the render names no external system, and the one
    // thing it does require — evidence going somewhere that exists — is checkable without a vendor.
    ['Covers delegated state and handoff', /证据落点/],
    ['Covers harness assessment', /评估/],
    ['Covers verification workflow', /验证工作流/],
    ['Covers memory taxonomy', /记忆/],
    ['Covers tool safety', /工具/],
    ['Covers context budgeting', /上下文预算/],
    ['Covers multi-agent coordination', /多代理/],
    ['Covers lifecycle bootstrap', /生命周期/],
    ['Covers scripted validation tooling', /脚本化/],
    ['Covers the plain-description slot', /项目说明/],
    ['Covers the instruction-file invariant', /指令文件不变量/],
    ['Covers instruction-file size and discoverability', /不可发现/],
    ['Covers the gate that refuses when nothing can run', /无可跑脚本/],
    ['Covers the scope boundary against doing the engineering workflow', /范围边界/],
    ['Covers the post-handoff boundary', /越界/],
    ['Covers session wrap-up', /收尾/],
    // Added with the update task on the user's ruling: maintenance is a user-invoked entry with a
    // trigger from the generated instruction file, so the family needs a behavioural case as well
    // as the gate — a gate proves a script is right, only a case shows what an agent does.
    ['Covers harness maintenance and update', /更新/],
    // Added with the blueprint rewrite path: the gate proves the script rewrites only the slot, but
    // only a case shows whether an agent aligns with the user beforehand, and refuses rather than
    // guessing when the file's shape is one this skill did not render.
    ['Covers the blueprint rewrite path', /蓝图变更/],
    // Was the two-owner routing condition, then the single-owner rule. With no owner named at all there
// is no routing left to cover, so this family now covers the opposite claim: that a render naming
// zero external systems is correct, and that the replacement requirement (evidence must land
// somewhere that exists) is what takes its place. The doc gate cannot check this — "no vendor named"
// has no mechanical carrier — so the case is the only evidence it exists as a rule.
['Covers the single-owner delegation', /不具名任何外部系统/],
    // Added with the command-reference check in the verification subsystem. The gate proves the
    // SCRIPT flags a dead command; only a case shows whether an agent handed a harness whose own
    // docs name a script that no longer exists reports that, rather than trusting the prose — and
    // whether it keeps the check honest in both directions: no false alarm on a guarded command,
    // and no quiet pass over what it could not resolve.
    ['Covers command reference integrity', /命令引用/],
    // Was the plain tier, which existed because a docs directory could not use a render that named
    // an owner. Removing the naming removed the tier with it, so this family now covers the
    // question it left behind: does a documentation directory get the same harness, with the
    // verification gate still honest and the no-verification waiver still explicit?
    // letting "no owner" quietly become "no gates", and whether it hands back a waiver the user
    // never asked for.
    ['Covers a documentation directory getting the same harness', /文档目录同样有 harness/]
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
  // Three subsystems now, so the tie fixture is three-way. The probe is built from the same names
  // SUBSYSTEMS carries, but as a literal on purpose: a fixture derived from the constant under test
  // would move with it and could never catch the constant shrinking by accident.
  const full = { instructions: { score: 5 }, verification: { score: 5 }, scope: { score: 5 } };
  const tied = { instructions: { score: 1 }, verification: { score: 1 }, scope: { score: 1 } };
  const unique = { instructions: { score: 2 }, verification: { score: 1 }, scope: { score: 3 } };
  const noneList = pickBottlenecks(full);
  const tieList = pickBottlenecks(tied);
  const uniqueList = pickBottlenecks(unique);
  const tieLabel = bottleneckLabel({ bottlenecks: tieList, subsystems: tied });
  const uniqueLabel = bottleneckLabel({ bottlenecks: uniqueList, subsystems: unique });
  const noneLabel = bottleneckLabel({ bottlenecks: noneList, subsystems: full });
  // Three cases, each with a distinct failure: a tie must name every tied subsystem (naming one is
  // the old defect), a unique minimum must still name exactly that one, and a complete harness must
  // report nothing to fix rather than the first subsystem in the list.
  const tieNamesAll = tieList.length === 3 && ['instructions', 'scope'].every((name) => tieLabel.includes(name));
  const uniqueNamesOne = uniqueList.length === 1 && uniqueList[0] === 'verification' && uniqueLabel === 'verification';
  const noneStaysQuiet = noneList.length === 0 && /none/.test(noneLabel);
  return {
    pass: tieNamesAll && uniqueNamesOne && noneStaysQuiet,
    tieCount: tieList.length,
    uniqueCount: uniqueList.length,
    noneCount: noneList.length,
    tieLabel
  };
}

// Stage: the audit must not reward a repository that has no gate. Every other group in this file
// tests something this skill RENDERS; this one tests what it SCORES, and it exists because the two
// used to be the same thing in the reader's mind.
//
// The measured failure, not a hypothetical: the verification needles were `type` and `CI`. A repo
// whose instruction file merely read "A React + TypeScript dashboard. Keep responses concise." —
// with no init.sh, no test command, no gate of any kind — matched both, scored 3/5 on verification,
// and was lifted ABOVE instructions and scope, dropping out of the bottleneck list. So the audit's
// most-quoted output told the user asking "the agent keeps saying done while the tests fail" to
// improve the wrong thing, and the two real gate checks in that subsystem were FAILs the score
// ignored.
//
// Why the suite stayed green through it: every fixture here is a harness THIS skill renders, which
// always carries a gate. Nothing in the suite ever handed the scorer a real foreign repository, so
// the case that mattered was never in the test set. The three arms below close that gap in the two
// directions that matter — a gate-less repo must fail the two gate checks, and a repo WITH a gate
// must still pass them, so the fix cannot be "score everyone lower".
//
// The fixture is written out literally rather than generated. A fixture derived from the needles
// would move with them, and a fixture that merely calls scoreHarness on an empty object proves
// nothing about which check fired.
async function checkForeignAudit() {
  const gateLess = [
    '# My App',
    '',
    'A React + TypeScript dashboard. Keep responses concise.',
    '',
    'Run the tests before saying you are done.'
  ].join('\n');
  // The same repository with a gate, so the arms are two readings of one comparison rather than
  // two unrelated fixtures. npm test / npm run build are the exact phrases the needles now require,
  // which is the point: the fix must admit these and reject the lines above.
  const withGate = `${gateLess}\n\n## 验证命令\n\n- \`npm test\`\n- \`npm run build\`\n\n## 完成定义\n\n- [ ] 证据：命令与结果摘要\n`;

  const scoreOf = (agents, init = '') => scoreHarness(
    [{ path: 'AGENTS.md', content: agents }, ...(init ? [{ path: 'init.sh', content: init }] : [])],
    {}
  );

  const bare = scoreOf(gateLess);
  const gated = scoreOf(withGate, '#!/bin/bash\nset -e\nnpm test\nnpm run build\n');

  const bareVerification = bare.subsystems?.verification;
  const gatedVerification = gated.subsystems?.verification;

  // The regression itself: no gate, so no verification entrypoint and no fail-fast, and neither
  // must be scored as satisfied by the words "TypeScript" and "concise".
  const staticCheckFailed = (bareVerification?.checks ?? []).find((c) => /Static\/build check/.test(c.message))?.pass === false;
  const evidenceFailed = (bareVerification?.checks ?? []).find((c) => /evidence is recorded/.test(c.message))?.pass === false;
  const entrypointFailed = (bareVerification?.checks ?? []).find((c) => /entrypoint exists/.test(c.message))?.pass === false;

  // And the anti-regression: the fix must not have been "fail everything", so a repo with a real
  // gate and a real evidence rule still scores both checks.
  const gatedStaticPasses = (gatedVerification?.checks ?? []).find((c) => /Static\/build check/.test(c.message))?.pass === true;
  const gatedEvidencePasses = (gatedVerification?.checks ?? []).find((c) => /evidence is recorded/.test(c.message))?.pass === true;

  // And the failure must be visible where the user looks: a gate-less repo that outranks
  // instructions/scope on verification is the inverted advice, so assert it does not happen.
  const notOverranked = (() => {
    const names = ['instructions', 'scope'];
    return names.every((n) => (bare.subsystems?.[n]?.score ?? 0) >= (bareVerification?.score ?? 0));
  })();

  const teeth = (() => {
    // Prove the two predicates read the lines rather than passing vacuously: seeding each phrase
    // into the bare fixture must flip exactly that one check back to pass.
    const flips = (needle, pattern) => {
      const seeded = scoreOf(`${gateLess}\n\n- ${needle}`);
      return (seeded.subsystems?.verification?.checks ?? []).find((c) => pattern.test(c.message))?.pass === true;
    };
    return flips('npm run build', /Static\/build check/) && flips('证据：命令与结果摘要', /evidence is recorded/);
  })();

  return {
    pass: staticCheckFailed && evidenceFailed && entrypointFailed && gatedStaticPasses
      && gatedEvidencePasses && notOverranked && teeth,
    bareVerification: bareVerification?.score,
    gatedVerification: gatedVerification?.score,
    staticCheckFailed,
    evidenceFailed,
    entrypointFailed,
    gatedStaticPasses,
    gatedEvidencePasses,
    notOverranked,
    teeth
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

  // The placeholder has to REFUSE. It used to render as a plain echo, so a repository with nothing
  // to verify ran this line, printed "Verification Complete" and exited 0 having verified nothing —
  // and the audit scored it 100/100, because every check it runs is an existence check.
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
  // A third shape, and the one nothing armed. Both arms above route through verificationCommands —
  // one with an empty script set, one with a test script. The explicit --commands path never reaches
  // it at all (create-harness.mjs takes the user's list verbatim and skips verificationCommands
  // entirely), so the refusal branch at the foot of verificationCommands was bypassed wholesale.
  // Measured on a repo with no manifest: `--commands "npm test,npm run lint"` rendered both steps as
  // has_script guards that SKIPPED, the script printed "Verification Complete" and exited 0, and the
  // audit still scored that repo 100/100 with "Verification fails fast" PASS. One axis was armed
  // while the other stayed blind, so the suite reported a pass it had not earned. Asserted through
  // the real assembler rather than a fixture: a hand-written script would only prove this probe's
  // copy of the string is right.
  const explicit = initScriptFromCommands(['npm test']);
  // Fails closed: the counter exists, and a zero count refuses with a non-zero exit. Read the
  // refusal the same way the fallback-template arm below does — split on the sentinel each refusal
  // prints immediately before refusing, then require the first statement of the block to be a
  // non-zero exit. A byte-window regex was the first attempt and it was wrong: it counted the
  // refusal's own explanatory lines against the window, so widening the message would silently
  // unarm this check. The sentinel does not move when the message does.
  const explicitRefusalBlocks = explicit.split('a gate that cannot fail is not a gate').slice(1);
  const explicitFailsClosed = /\bRAN=0\b/.test(explicit)
    && explicitRefusalBlocks.length >= 1
    && explicitRefusalBlocks.every((block) => /^[ \t]*exit[ \t]+[1-9]\d*[ \t]*$/m.test(block.slice(0, 200)));
  // Opens when a check really ran — inside the guard's success branch, not beside the SKIP notice.
  // Without this arm, "refuse unconditionally" would satisfy the assertion above while making the
  // gate useless: the mirror-image failure of a gate that cannot fail.
  const explicitOpensWhenRun = /has_script\s+"test";\s*then[\s\S]*?\bRAN=1\b/.test(explicit);

  // The same invariant has a SECOND producer, and it went uncovered. templates/init.sh is the
  // manual fallback — what the agent copies by hand when the runtime has no Node — so none of the
  // generator probes above reach it. Measured, not assumed: replacing both of its `exit 1`
  // refusals with `exit 0` left this suite green (Self-check: PASS, Overall 20/100), which means
  // the skill could ship a blank repo a gate that structurally cannot fail while the suite
  // reported a pass it had not earned. That is the exact defect the arms above were written to
  // close, still open on the other producer. Read from the shipped file, never a fixture, so this
  // cannot pass by agreeing with a copy of the string it is meant to verify.
  //
  // Structural rather than behavioural, deliberately: this suite is pure Node and executes no
  // shell, and making the self-check require bash would fail wholesale on hosts that lack it — a
  // gate that refuses everything verifies nothing. Normalising CRLF first is load-bearing: the
  // checkout is CRLF, so the `$` anchors below would otherwise never match.
  const template = (await readText(path.join(skillRoot, 'templates', 'init.sh'))).replace(/\r\n/g, '\n');
  // Each refusal prints this sentinel immediately before it refuses, so splitting on the sentinel
  // yields one block per refusal. A deleted branch then shows up as a missing block, and a branch
  // that stopped refusing as a block whose first statement is no longer a non-zero exit. The
  // window is bounded to the start of the block so a neighbouring branch's exit cannot satisfy it.
  const refusalBlocks = template.split('a gate that cannot fail is not a gate').slice(1);
  const refusalArmed = (block) => /^[ \t]*exit[ \t]+[1-9]\d*[ \t]*$/m.test(block.slice(0, 200));
  const templateRefusals = refusalBlocks.length;
  const templateRefusalsExitNonZero = templateRefusals >= 2 && refusalBlocks.every(refusalArmed);
  // The other direction, for the same reason the generator arms carry one: a fallback that
  // refused unconditionally would satisfy the arm above while verifying nothing.
  const templateStillRuns = /=== Verification Complete ===/.test(template);
  // --commands is a comma-separated list, so a comma INSIDE one of the commands used to split it in
  // two: `--commands "bash -c 'echo a,b'"` became the steps `bash -c 'echo a` and `b'`, and the
  // second half is not a check at all. That is the same defect as the arms above, one layer up — a
  // gate silently rewritten into a step that cannot fail — and it was armed on neither axis. The
  // list is now split with quoting respected, and an unterminated quote is refused rather than
  // guessed at. Three directions through the real generator, because each fails differently:
  // quoting must protect the comma, a genuine comma-separated list must still split (or "never
  // split" would satisfy the first arm while breaking every existing caller), and the refusal must
  // leave nothing behind (or "refuse after writing" would satisfy the second).
  const commaDir = await mkdtemp(path.join(os.tmpdir(), 'harness-comma-'));
  const listDir = await mkdtemp(path.join(os.tmpdir(), 'harness-cmdlist-'));
  const badCmdDir = await mkdtemp(path.join(os.tmpdir(), 'harness-badcmd-'));
  try {
    const createScript = path.join(scriptDir, 'create-harness.mjs');
    await execFileAsync('node', [
      createScript, '--target', commaDir, '--commands', "bash -c 'echo a,b'"
    ]);
    await execFileAsync('node', [
      createScript, '--target', listDir, '--commands', 'npm test,npm run lint'
    ]);
    const commaAgents = await readText(path.join(commaDir, 'AGENTS.md'));
    const listAgents = await readText(path.join(listDir, 'AGENTS.md'));
    // One command, comma intact, and no orphaned half of it registered as an entry of its own.
    const quotedCommaUnsplit = commaAgents.includes("- `bash -c 'echo a,b'`")
      && !/^- `b'`$/m.test(commaAgents);
    const listStillSplits = /^- `npm test`$/m.test(listAgents) && /^- `npm run lint`$/m.test(listAgents);
    // The refusal has to be a refusal, not a warning printed on the way to writing the files anyway.
    let refusedCode = null;
    try {
      await execFileAsync('node', [
        createScript, '--target', badCmdDir, '--commands', "bash -c 'echo a,b"
      ]);
      refusedCode = 0;
    } catch (error) {
      refusedCode = error.code;
    }
    const unterminatedRefused = refusedCode !== 0 && refusedCode !== null
      && (await readdir(badCmdDir)).length === 0;
    return {
      pass: placeholderFails && realRuns && scriptlessRefuses && withTestRuns
        && explicitFailsClosed && explicitOpensWhenRun
        && templateRefusalsExitNonZero && templateStillRuns
        && quotedCommaUnsplit && listStillSplits && unterminatedRefused,
      placeholderFails,
      realRuns,
      scriptlessRefuses,
      withTestRuns,
      explicitFailsClosed,
      explicitOpensWhenRun,
      templateRefusals,
      templateRefusalsExitNonZero,
      templateStillRuns,
      quotedCommaUnsplit,
      listStillSplits,
      unterminatedRefused
    };
  } finally {
    for (const dir of [commaDir, listDir, badCmdDir]) await rm(dir, { recursive: true, force: true });
  }
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
//
// The blueprint is also the one slot the user rewrites later, so a third direction joins them: on a
// file that already exists, --blueprint must change the slot and nothing else. The fixture carries
// the two things a careless implementation destroys — a merged section and a block another skill
// owns — because re-rendering the template is the easy wrong answer and it deletes both silently.
// A fourth direction covers the shape this skill did not render: refusing beats guessing, and an
// exit-0 no-op would be indistinguishable from success.
async function checkBlueprintSlot() {
  let dir;
  let supplied;
  let refused;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), 'harness-blueprint-'));
    const script = path.join(scriptDir, 'create-harness.mjs');
    const blueprint = 'Probe project: delivers one thing the probe names itself.';

    await execFileAsync('node', [script, '--target', dir]);
    const omitted = await readText(path.join(dir, 'AGENTS.md'));
    // Pending must be explicit and must not smuggle in stack-derived boilerplate.
    const pendingMarked = omitted.includes('待补');
    const noInventedFill = !/agent-assisted development/i.test(omitted);

    // Second: a supplied blueprint reaches the file verbatim rather than being replaced or dropped.
    supplied = await mkdtemp(path.join(os.tmpdir(), 'harness-blueprint-set-'));
    await execFileAsync('node', [script, '--target', supplied, '--blueprint', blueprint]);
    const agentPath = path.join(supplied, 'AGENTS.md');
    const rendered = await readText(agentPath);
    const verbatim = rendered.includes(blueprint);

    // Third: the blueprint is not fixed. Rewriting it must move the slot and leave the rest alone.
    const MERGED = '## 已合并的章节';
    const THIRD_PARTY = '## Agent skills';
    const merged = `${rendered}\n${MERGED}\n\n由别的技能拥有，必须存活。\n\n${THIRD_PARTY}\n\n第三方块，必须存活。\n`;
    await writeText(agentPath, merged);

    const revised = 'Probe project: revised description the probe names itself.';
    await execFileAsync('node', [script, '--target', supplied, '--blueprint', revised]);
    const after = await readText(agentPath);
    const slotRewritten = after.includes(revised) && !after.includes(blueprint);

    // Keyed on a literal heading rather than on the function under test: a fixture derived from the
    // implementation would move with it and could never catch it. Everything from the first H2 on
    // is carried over untouched, so an equal tail means the rewrite stayed inside its slot.
    const tailOf = (text) => text.slice(text.indexOf('\n## 验证命令'));
    const tailBefore = tailOf(merged);
    const restIntact = tailBefore.length > 0 && tailOf(after) === tailBefore;

    // Teeth: that comparison has to be able to fail. Feeding it a copy whose tail lost the merged
    // block — the exact damage a re-render does — must come back unequal, or `restIntact` is a
    // tautology that passes on any file at all.
    const detectorHasTeeth = tailOf(merged.replace(MERGED, '')) !== tailBefore;

    // Fourth: an instruction file this skill did not render gets a refusal, not a guess. This is the
    // same shape checkAgentFileInvariant uses for a hand-written file: an H1 with nothing between it
    // and the next heading. Refusing loudly beats writing prose nobody asked for.
    refused = await mkdtemp(path.join(os.tmpdir(), 'harness-blueprint-refuse-'));
    const handWritten = '# AGENTS.md\n\n## Agent skills\n\nHand-written, no slot.\n';
    const handWrittenPath = path.join(refused, 'AGENTS.md');
    await writeText(handWrittenPath, handWritten);
    let refusalCode = 0;
    let refusalOut = '';
    try {
      refusalOut = (await execFileAsync('node', [script, '--target', refused, '--blueprint', revised])).stdout;
    } catch (error) {
      refusalCode = error.code ?? 1;
      refusalOut = error.stdout || '';
    }
    const refusalHonoured = /BLUEPRINT REFUSED/.test(refusalOut) && refusalCode !== 0;
    const refusedUntouched = (await readText(handWrittenPath)) === handWritten;

    return {
      pass: pendingMarked && noInventedFill && verbatim && slotRewritten && restIntact
        && detectorHasTeeth && refusalHonoured && refusedUntouched,
      pendingMarked,
      noInventedFill,
      verbatim,
      slotRewritten,
      restIntact,
      detectorHasTeeth,
      refusalHonoured,
      refusedUntouched
    };
  } catch (error) {
    return {
      pass: false,
      pendingMarked: false,
      noInventedFill: false,
      verbatim: false,
      slotRewritten: false,
      restIntact: false,
      detectorHasTeeth: false,
      refusalHonoured: false,
      refusedUntouched: false,
      error: error.message
    };
  } finally {
    for (const target of [dir, supplied, refused]) if (target) await rm(target, { recursive: true, force: true });
  }
}

// Stage twelve: the instruction-file choice invariant and the report-don't-write contract.
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
    // The detail layer is appended, so the file legitimately grows. What must NOT happen is a single
    // existing byte moving: the invariant is that everything already written survives verbatim, which
    // is stronger and more checkable than "the file is unchanged" — which would forbid the append and
    // equally forbid a silent rewrite. Compared as a prefix because the append goes to the end.
    const afterExisting = await readText(agentsPath);
    const untouched = afterExisting.startsWith(existing);
    const thirdPartySurvived = /## Agent skills/.test(afterExisting) && /Third-party block that must survive\./.test(afterExisting);
    // And the append must be idempotent, or a second run duplicates the section it just wrote.
    await execFileAsync('node', [script, '--target', agentsDir]);
    const twice = await readText(agentsPath);
    const appendIdempotent = (twice.match(/^## 细则$/gm) || []).length === 1;
    // At least one missing section heading must be listed; keying on the literal names would break
    // every time a section is renamed, while "lists nothing" is the actual defect.
    const missingReported = /\n\s*-\s*##\s/.test(agentsRun.stdout);


    // The half that had no carrier. SKILL.md has always said a file holding another owner's block
    // must not be --force overwritten, and until now that was prose: the flag overwrote
    // unconditionally, so the one rule protecting another skill's work was the one rule nothing
    // checked. Measured by rendering over a file with a "## Agent skills" section and finding it
    // gone. Asserted in both directions on purpose — a guard that refuses everything would satisfy
    // "it refuses", so the positive arm re-runs --force over a file this skill itself rendered and
    // requires the write to still go through, which is what --force is FOR.
    let forceRefused = false;
    let forceStillWritesOwn = false;
    let forceDir;
    try {
      forceDir = await mkdtemp(path.join(os.tmpdir(), 'harness-force-'));
      const foreignPath = path.join(forceDir, 'AGENTS.md');
      await writeText(foreignPath, '# AGENTS.md\n\n## Agent skills\n\nThird-party block that must survive.\n');
      // try/catch, not `{ reject: false }`: every other arm in this file reads the outcome off a
      // caught error's code/stdout/stderr, and mixing the two shapes means the exit code is read
      // off an object that may not carry it. The guard under test refuses on purpose, so the
      // rejection IS the observation.
      let refusedCode = 0;
      let refusedOutput = '';
      try {
        const done = await execFileAsync('node', [script, '--target', forceDir, '--force']);
        refusedCode = done.code ?? 0;
        refusedOutput = `${done.stdout || ''}${done.stderr || ''}`;
      } catch (error) {
        refusedCode = error.code ?? 1;
        refusedOutput = `${error.stdout || ''}${error.stderr || ''}`;
      }
      const foreignSurvived = (await readText(foreignPath)).includes('Third-party block that must survive.');
      const refusedExited = refusedCode === 1;
      const namedTheSections = /Agent skills/.test(refusedOutput);

      // Positive arm: --force over a file carrying only this skill's own sections must still write.
      const ownDir = await mkdtemp(path.join(os.tmpdir(), 'harness-force-own-'));
      try {
        await execFileAsync('node', [script, '--target', ownDir]);
        const ownPath = path.join(ownDir, 'AGENTS.md');
        const before = await readText(ownPath);
        await writeText(ownPath, `${before}\n\n<!-- hand edit -->\n`);
        const allowed = await execFileAsync('node', [script, '--target', ownDir, '--force']);
        forceStillWritesOwn = !(await readText(ownPath)).includes('hand edit') && (allowed.code ?? 0) === 0;
      } finally {
        await rm(ownDir, { recursive: true, force: true });
      }
      forceRefused = foreignSurvived && refusedExited && namedTheSections;
    } catch {
      forceRefused = false;
      forceStillWritesOwn = false;
    } finally {
      if (forceDir) await rm(forceDir, { recursive: true, force: true });
    }

    return {
      pass: noSecondFile && choseClaude && untouched && thirdPartySurvived && appendIdempotent
        && missingReported && forceRefused && forceStillWritesOwn,
      noSecondFile,
      choseClaude,
      untouched,
      thirdPartySurvived,
      appendIdempotent,
      missingReported,
      forceRefused,
      forceStillWritesOwn
    };
  } catch (error) {
    return { pass: false, noSecondFile: false, choseClaude: false, untouched: false, thirdPartySurvived: false, appendIdempotent: false, missingReported: false, forceRefused: false, forceStillWritesOwn: false, error: error.message };
  } finally {
    for (const target of [claudeDir, agentsDir]) if (target) await rm(target, { recursive: true, force: true });
  }
}

// The gate has to grow, and growing it is the one edit a project can only make once per new
// capability — so the three ways that can go wrong are asserted separately, each with its own bad
// input rather than one happy path:
//
//   grew + preserved — the new check joins the gate and every existing step survives byte for byte.
//     "Only adds" is a claim about the whole file, not about the one block it wrote.
//   idempotent        — naming a check that is already there changes nothing. A second copy of the
//     same check is a gate that looks twice as covered as it is.
//   deadBranchRefused — the check lands in a branch ./init.sh never takes, so it never runs. The
//     generator's own anchors cannot see it. templates/init.sh puts its refusal anchors at column 0,
//     after the elif cascade and outside every branch, so all seven branches reach the same
//     shared verdict and appendVerificationCheck inserts a new check after that cascade — a Python
//     repo enters no branch of its own yet still runs whatever was appended below the cascade.
//     What the anchors cannot express is reachability: uniqueness and ordering hold for a step
//     planted on a path nothing takes, so the arm below has to run the file and read the verdict.
//     The run must refuse AND put the file back, because "ADDED" for a check that cannot run is a
//     regression net reported as coverage — the precise failure this mode exists to prevent.
//
// missingRefused is the fourth: no init.sh at all means there is no gate to grow, and creating one
//   as a side effect of an append would be the create flow smuggled into a flag that claims to touch
//   nothing else. detectorHasTeeth keeps the comparison itself honest: a predicate that cannot fail
//   would report `preserved` on any file at all, including one that lost its steps.
//
// declaredSkipTurnsGateRed is the same class of defect as deadBranchRefused, and it is the one the
//   RAN counter cannot reach. RAN=0 refuses when EVERY check was skipped, which is the honest
//   reading of "at least one ran"; it says nothing about the case where the project names two
//   checks, package.json defines one, the other is skipped with a notice, RAN=1 is set by the check
//   that did run, and the script prints "Verification Complete" and exits 0. The user asked for two
//   and got one plus a notice. Four arms over two fixtures, opposite verdicts: the skip branch has
//   to record which script it was, the refusal that reads that record has to exit non-zero BEFORE
//   the success tail, a manifest that defines both scripts must still get two real steps and record
//   nothing, and where a shell exists the two fixtures must actually come back red and green
//   respectively. The pair matters because each alone is satisfiable by the wrong fix: recording the
//   skip and printing the success tail anyway passes the first two, and refusing unconditionally
//   passes all three.
//
// SKIPPED, not failed, when no POSIX shell is available. This suite is pure Node by design (see
// checkBlankProjectGate) and must not be turned into a gate that refuses everything on a host without
// bash — a check nobody can run verifies nothing, which is the same defect in the other direction.
// The skip is reported rather than hidden, so a suite silently covering one less thing is visible in
// the report instead of being indistinguishable from a pass.
// Runs a gate with a known-good shell. Kept out of checkInitGrowth because arm 5 needs it for a
// directory that is not the one under growth, and passing the shell in keeps the two arms on the same
// interpreter the tool would have picked rather than re-probing and possibly landing elsewhere.
// `env` merges over this process's environment rather than replacing it, so an arm that puts a stub
// toolchain on PATH still gets the PATH's own directories — the interpreter, and on Windows the
// Git-Bash mount table the absolute stub path is meaningless without.
async function runGateWithShell(shell, cwd, env) {
  const options = { cwd, timeout: 300000 };
  if (env) options.env = { ...process.env, ...env };
  try {
    const { stdout } = await execFileAsync(shell, ['./init.sh'], options);
    return { ok: true, stdout };
  } catch (error) {
    if (error.code === 'ENOENT') return { ok: false, unavailable: true, stdout: '' };
    return { ok: false, stdout: `${error.stdout || ''}${error.stderr || ''}` };
  }
}

// Makes a fixture file runnable. Needed because the fallback gate and its stub toolchain are shell
// scripts this suite writes rather than generates, and a host that will not execute a non-executable
// file reports every arm as red for a reason that has nothing to do with the arm. Best effort on
// purpose: on a host where the exec bit is not what gates execution the call succeeds and the run
// still works, and on one where it throws, the run fails and the arm says so.
async function chmodExec(file) {
  try {
    await chmod(file, 0o755);
  } catch { /* the host does not model the exec bit; the run below reports what actually happened */ }
}

// The generated gate anchors its evidence to a commit, so every fixture that must reach the
// success tail needs a repository with one. Skipping this is not a slower arm, it is a red one: the
// gate refuses before any check runs, and an arm that never reached the tail would report on a
// refusal instead of on the behaviour it exists to test. Identity is fixed and writes are scoped to
// the fixture's own directory; nothing here touches the user's repository.
async function commitFixture(dir) {
  const git = process.platform === 'win32' ? 'git' : 'git';
  const opts = { cwd: dir, timeout: 30000 };
  await execFileAsync(git, ['init', '-q'], opts);
  await execFileAsync(git, ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'add', '-A'], opts);
  await execFileAsync(git, ['-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-q', '-m', 'fixture'], opts);
}

async function checkInitGrowth() {
  let growDir;
  let deadDir;
  let missingDir;
  let unparseDir;
  let entryDir;
  let undefDir;
  let declaredDir;
  let emptyToolDir;
  let probeDir = null;
  const result = {
    pass: false, grew: false, preserved: false, idempotent: false,
    deadBranchRefused: false, rolledBack: false, refusalNamesCommand: false,
    refusalNameHasTeeth: false, missingRefused: false, detectorHasTeeth: false,
    unparseableRefused: false, loopStated: false, loopIsLoadBearing: false,
    entryAppended: false, entryUnguarded: false, entryIdempotent: false,
    entryMissingRefused: false, entryRulesHaveTeeth: false, entryGateFailsWhenUnresolvable: false,
    declaredSkipTurnsGateRed: false, declaredSkipDetectorHasTeeth: false, declaredScriptStillRuns: false,
    declaredSkipGateIsRed: false, declaredGateIsGreen: false,
    emptyToolBranchesGuarded: false, emptyToolBranchesHaveTeeth: false,
    emptyToolRunsRed: false, emptyToolRunsGreen: false, emptyToolGateTeeth: false
  };
  try {
    const script = path.join(scriptDir, 'create-harness.mjs');
    const manifest = JSON.stringify({
      name: 'growth-fixture', version: '1.0.0',
      scripts: { test: 'echo TEST_OK', e2e: 'echo E2E_OK' }
    });
    // Whether a shell exists at all decides which arms are exercised, so it is probed up front and
    // reported rather than inferred from a refusal that may have another cause. The candidate is
    // kept because arm 5 needs to run the gate afterwards and re-probing would pick a different one.
    // `--version` alone is not enough to accept one: on Windows `bash` is routinely the WSL bridge,
    // which starts, prints a version and cannot see the Windows drive. The gate's own completion line
    // is the test, so this probes the same way the tool does rather than accepting a shell that would
    // report every arm as green because it never actually ran anything.
    let shellAvailable = false;
    let shellCandidate = null;
    probeDir = await mkdtemp(path.join(os.tmpdir(), 'harness-initgrowth-shell-'));
    try {
      await writeText(path.join(probeDir, 'package.json'), JSON.stringify({
        name: 'shell-probe', version: '1.0.0', scripts: { test: 'echo SHELL_OK' }
      }));
      await execFileAsync('node', [path.join(scriptDir, 'create-harness.mjs'), '--target', probeDir]);
      await commitFixture(probeDir);
      for (const candidate of ['bash', 'C:/Program Files/Git/bin/bash.exe']) {
        const probe = await runGateWithShell(candidate, probeDir);
        if (!probe.unavailable && probe.stdout.includes('=== Verification Complete ===')) {
          shellAvailable = true;
          shellCandidate = candidate;
          break;
        }
      }
    } catch { /* no shell can run this gate; the arms report it rather than guessing */ }
    probeDir = null;

    // 1. Growth preserves everything, and 2. a repeat is a byte-identical no-op.
    growDir = await mkdtemp(path.join(os.tmpdir(), 'harness-initgrowth-'));
    await writeText(path.join(growDir, 'package.json'), manifest);
    await execFileAsync('node', [script, '--target', growDir]);
    await commitFixture(growDir);
    const initPath = path.join(growDir, 'init.sh');
    const before = await readText(initPath);
    const beforeSteps = before.split('\n').filter((line) => /^RAN=1$/.test(line.trim())).length;

    const growRun = await execFileAsync('node', [script, '--target', growDir, '--add-check', 'npm run e2e']);
    const after = await readText(initPath);
    result.grew = /ADDED/.test(growRun.stdout) && after !== before;
    // The load-bearing half: every line of the old file is still present, in order. Comparing the
    // whole file against a "contains" test would pass a run that merely kept the RAN=1 markers while
    // deleting the commands between them, which is the rewrite this mode promises never to do.
    result.preserved = after.includes(before.split('RAN=0')[0]) &&
      (after.split('\n').filter((line) => /^RAN=1$/.test(line.trim())).length === beforeSteps + 1);

    const afterHash = await readText(initPath);
    const repeatRun = await execFileAsync('node', [script, '--target', growDir, '--add-check', 'npm run e2e']);
    result.idempotent = /ALREADY PRESENT/.test(repeatRun.stdout) && (await readText(initPath)) === afterHash;

    // Teeth for the predicate above: break the old file in a way the predicate must notice. Deleting
    // one RAN=1 marker is not enough — the prefix test still passes and only the count changes — so
    // the damage is aimed at the prefix itself: remove a whole command line the old gate contained.
    // Without this, `preserved` is a comparison that holds for every input including a rewritten
    // gate, and it would report "existing steps preserved" on a file that lost them.
    const dropped = after.replace(/^RAN=1$/m, '').replace(/^  echo "=== .*$/m, '');
    const prefix = before.split('RAN=0')[0];
    const damagedSteps = dropped.split('\n').filter((line) => /^RAN=1$/.test(line.trim())).length;
    result.detectorHasTeeth = !dropped.includes(prefix) || damagedSteps !== beforeSteps + 1;

    // 3. A check the gate would never run is refused, and the file is byte-for-byte restored.
    //
    // The fixture must make the gate GREEN first and then add a check that will not pass, because a
    // red gate is refused earlier — at shell detection — before a single byte is written. The first
    // version of this arm left the fixture red, so `rolledBack` compared an untouched file against
    // itself: the assertion held while the rollback path that actually writes had zero coverage. A
    // green gate plus a check the manifest does not define reaches the real refusal: has_script
    // SKIPs it, it never reaches RAN=1, and the run is rolled back.
    deadDir = await mkdtemp(path.join(os.tmpdir(), 'harness-initgrowth-dead-'));
    await writeText(path.join(deadDir, 'package.json'), JSON.stringify({
      name: 'dead-fixture', version: '1.0.0', scripts: { test: 'echo TEST_OK' }
    }));
    const deadPath = path.join(deadDir, 'init.sh');
    await execFileAsync('node', [script, '--target', deadDir]);
    await commitFixture(deadDir);
    const deadHash = await readText(deadPath);
    const deadBefore = deadHash.includes('=== npm test ===');
    let deadRun = { stdout: '', stderr: '' };
    try {
      deadRun = await execFileAsync('node', [script, '--target', deadDir, '--add-check', 'npm run nonexistent-check']);
    } catch (error) {
      deadRun = { stdout: error.stdout || '', stderr: error.stderr || '' };
    }
    const deadOutput = `${deadRun.stdout}${deadRun.stderr}`;
    // Keyed on the refusal that only the written-then-undone path can produce, so a refusal raised
    // before any write cannot satisfy this arm.
    result.deadBranchRefused = deadBefore && /never executed|does not actually pass/.test(deadOutput);
    result.rolledBack = (await readText(deadPath)) === deadHash;

    // 3b. And the refusal has to NAME the command it refused, which the arm above cannot see.
    //
    // `deadBranchRefused` keys on the generator's shared boilerplate, and that boilerplate is one
    // sentence reused by every refusal — a printer that writes a placeholder where the command
    // belongs produces an output indistinguishable from a correct one, so this arm cannot be built
    // out of that sentence. The two collectors on this path are separate objects with different
    // shapes (one holds strings, one holds objects whose command is read off a property), so a
    // mismatch between them prints `undefined` in place of the command and the refusal ends up
    // refusing nothing by name.
    //
    // Asked of the SHAPE of the printed list, not of any phrase: the bullets are the one part of the
    // message that carries data rather than boilerplate, and the requirement is that each of them
    // begins with a command this run actually appended. Both directions are required — every bullet
    // accounted for by an appended command, and every appended command present in some bullet —
    // because either half alone is satisfied by a list of placeholders or by a list that omits the
    // command while printing something else. Rewording the boilerplate cannot move it; printing
    // `undefined` in place of the command does.
    const refusedCommands = ['npm run nonexistent-check'];
    const refusalBullets = (text) => text.split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2).trim());
    const namesRefused = (text, commands) => {
      const bullets = refusalBullets(text);
      return commands.length > 0 &&
        commands.every((command) => bullets.some((bullet) => bullet.startsWith(command))) &&
        bullets.every((bullet) => commands.some((command) => bullet.startsWith(command)));
    };
    // Mutating only the printed bullets, so the mutant differs from the artifact above in exactly
    // the data the arm is about and keeps every word of boilerplate the refusal shares with the
    // healthy case.
    const retargetBullets = (text, rewrite) => text.split('\n')
      .map((line) => (line.trim().startsWith('- ') ? `  - ${rewrite(line.trim().slice(2).trim())}` : line))
      .join('\n');
    result.refusalNamesCommand = namesRefused(deadOutput, refusedCommands);
    const placeholderRefusal = retargetBullets(deadOutput, () => 'undefined');
    const alienRefusal = retargetBullets(deadOutput, () => 'npm run a-check-this-run-never-asked-for');
    result.refusalNameHasTeeth = result.refusalNamesCommand &&
      !namesRefused(placeholderRefusal, refusedCommands) &&
      !namesRefused(alienRefusal, refusedCommands);

    // 4. No init.sh at all: refused rather than silently creating one.
    missingDir = await mkdtemp(path.join(os.tmpdir(), 'harness-initgrowth-missing-'));
    await writeText(path.join(missingDir, 'package.json'), manifest);
    let missingRun = { stdout: '', stderr: '' };
    try {
      missingRun = await execFileAsync('node', [script, '--target', missingDir, '--add-check', 'npm run e2e']);
    } catch (error) {
      missingRun = { stdout: error.stdout || '', stderr: error.stderr || '' };
    }
    result.missingRefused = /REFUSED/.test(`${missingRun.stdout}${missingRun.stderr}`) &&
      !(await exists(path.join(missingDir, 'init.sh')));

    // 5. A command that does not parse as shell must be refused, and the gate left green.
    //
    // This is the arm the other three cannot see. The evidence used to confirm a check ran is the
    // banner the shell prints on ENTERING the step — so a command like `npm test (unit)` renders a
    // line the shell cannot parse, the banner appears, and the shell dies immediately after. Entering
    // and executing are the same observation there, and the tool reported ADDED and exit 0 on a gate
    // that had just gone from exit 0 to exit 2 with the check never run. The arm asserts the refusal
    // AND that the gate is still green afterwards, because "refused" alone is satisfied by a gate that
    // was red to begin with.
    unparseDir = await mkdtemp(path.join(os.tmpdir(), 'harness-initgrowth-syntax-'));
    await writeText(path.join(unparseDir, 'package.json'), manifest);
    await execFileAsync('node', [script, '--target', unparseDir]);
    await commitFixture(unparseDir);
    const syntaxPath = path.join(unparseDir, 'init.sh');
    const syntaxHash = await readText(syntaxPath);
    let syntaxRun = { stdout: '', stderr: '' };
    try {
      syntaxRun = await execFileAsync('node', [script, '--target', unparseDir, '--add-check', 'npm test (unit)']);
    } catch (error) {
      syntaxRun = { stdout: error.stdout || '', stderr: error.stderr || '' };
    }
    const syntaxOutput = `${syntaxRun.stdout}${syntaxRun.stderr}`;
    const afterRefusal = await readText(syntaxPath);
    let stillGreen = false;
    if (shellAvailable) {
      const probe = await runGateWithShell(shellCandidate, unparseDir);
      stillGreen = probe.stdout.includes('=== Verification Complete ===');
    }
    result.unparseableRefused = /REFUSED/.test(syntaxOutput) &&
      !afterRefusal.includes('npm test (unit)') &&
      (shellAvailable ? stillGreen : true);

    // 6. The rendered instruction file closes the control loop: a gate that went red this session
    // must leave a check behind, or the same trap is walked into twice.
    //
    // The wrap-up trigger keyed on "失准" alone, which is what the session's output LOOKS like. A
    // gate that failed, was fixed, and left no check behind changes nothing on disk — no artefact is
    // stale, nothing reads as misaligned — and the lesson goes with it. That is a control loop that
    // never reaches its forward path: the error was corrected in the code and never in the
    // specification that would have caught it. Read from the real render, and proved load-bearing by
    // deleting the sentence, because a prose assertion with no reader cannot fail.
    //
    // ORDER IS LOAD-BEARING and was wrong once: this block sat BELOW the `result.pass` conjunction,
    // which computed pass from the earlier arms and returned before these two were ever assigned. The
    // group reported PASS with `loopStated` undefined — the console printed NO from an assertion that
    // had never run. Every arm is now computed first and the conjunction reads them last.
    const rendered = await loadHarnessFiles(growDir);
    const renderedAgents = rendered.find((file) => file.path.endsWith('AGENTS.md'))?.content || '';
    const loopTerms = ['门禁红过', '--add-check'];
    result.loopStated = loopTerms.every((term) => renderedAgents.includes(term));
    const withoutLoop = renderedAgents
      .split(/\r?\n/)
      .filter((line) => !loopTerms.some((term) => line.includes(term)))
      .join('\n');
    result.loopIsLoadBearing = !loopTerms.every((term) => withoutLoop.includes(term));

    // 7. An entry reference: ONE line that calls a script the repository owns, and the properties
    //    that make it worth having. The line is UNGUARDED on purpose, and that is the load-bearing
    //    part — `if [ -x ./verify.sh ]` would turn a deleted entry into a green gate, so the last
    //    arm below removes the entry and requires the gate to go red.
    entryDir = await mkdtemp(path.join(os.tmpdir(), 'harness-initgrowth-entry-'));
    await writeText(path.join(entryDir, 'package.json'), manifest);
    // The entry script has to exist and be non-empty before the append, because both are refused
    // at write time; a fixture that skipped this would be testing the refusal path by accident.
    await writeText(path.join(entryDir, 'verify.sh'), '#!/bin/bash\necho VERIFY_OK\n', { mode: 0o755 });
    await execFileAsync('node', [script, '--target', entryDir]);
    await commitFixture(entryDir);
    const entryInitPath = path.join(entryDir, 'init.sh');
    const entryBefore = await readText(entryInitPath);
    let entryRun = { stdout: '', stderr: '' };
    try {
      entryRun = await execFileAsync('node', [script, '--target', entryDir, '--add-check-entry', './verify.sh']);
    } catch (error) {
      entryRun = { stdout: error.stdout || '', stderr: error.stderr || '' };
    }
    const entryAfter = entryRun.stdout + entryRun.stderr;
    const entryFile = await readText(entryInitPath);
    result.entryAppended = /ADDED/.test(entryAfter) && entryFile !== entryBefore &&
      /^\.\/verify\.sh$/m.test(entryFile);

    // The guard question, asked of the text rather than of behaviour, because it is the one thing a
    // later refactor is likely to "improve": `-x` or `[ -f` anywhere in the region around the call
    // means the check can be skipped, and a check that can be skipped is not a check.
    const callLine = entryFile.split('\n').findIndex((line) => line.trim() === './verify.sh');
    const around = callLine >= 0 ? entryFile.split('\n').slice(Math.max(0, callLine - 3), callLine + 3) : [];
    result.entryUnguarded = callLine >= 0 && !around.some((line) => /\[ -[fx]|\[\[ -[fx]|command -v/.test(line));

    // Repeat, and the bare-name spelling of the same path. Both must be byte-identical no-ops: the
    // second is what proves the normaliser maps one path to one step rather than two.
    const entryHash = entryFile;
    const entryRepeat = await execFileAsync('node', [script, '--target', entryDir, '--add-check-entry', 'verify.sh']);
    result.entryIdempotent = /ALREADY PRESENT/.test(entryRepeat.stdout) &&
      (await readText(entryInitPath)) === entryHash;

    // A path that is not there is refused before anything is written. A line calling a file that
    // does not exist would leave a gate failing on something nobody can fix, which is how a check
    // stops being read and stays in the file for ever.
    const entryMissingBefore = entryHash;
    let entryMissingRun = { stdout: '', stderr: '' };
    try {
      entryMissingRun = await execFileAsync('node', [script, '--target', entryDir, '--add-check-entry', './absent.sh']);
    } catch (error) {
      entryMissingRun = { stdout: error.stdout || '', stderr: error.stderr || '' };
    }
    result.entryMissingRefused = /REFUSED/.test(entryMissingRun.stdout + entryMissingRun.stderr) &&
      (await readText(entryInitPath)) === entryMissingBefore;

    // Teeth for the path validator, per rule and against a table written out HERE rather than
    // derived from the source. Two directions, and both are needed: a validator that refuses
    // everything passes every refuse-arm, and one that refuses nothing passes every accept-arm.
    // Because each row names the rule it stands for, deleting a rule from the validator leaves its
    // row asserting a refusal that no longer happens — the shrink is caught by the row, not by a
    // list that shrinks with it.
    const entryWrong = ENTRY_PATH_FIXTURES.filter(({ input, refuse }) => {
      const outcome = normalizeEntryPath(input);
      return refuse ? outcome.ok : !outcome.ok;
    }).map(({ input, why }) => `${why}:${input}`);
    result.entryRulesHaveTeeth = entryWrong.length === 0 &&
      normalizeEntryPath('verify.sh').path === './verify.sh';

    // The reverse verification, run by the suite rather than left to a session to remember: take
    // the entry away and the gate must go RED. It is the only arm that can tell an unguarded call
    // from a guarded one, because a guarded call produces exactly the same green output as a
    // working one until the file is missing. Renamed rather than deleted so the fixture needs no
    // unlink; for the gate the two are the same event, an unresolvable path.
    if (shellAvailable) {
      const movedPath = path.join(entryDir, 'verify.sh.moved');
      await rename(path.join(entryDir, 'verify.sh'), movedPath);
      const orphaned = await runGateWithShell(shellCandidate, entryDir);
      await rename(movedPath, path.join(entryDir, 'verify.sh'));
      result.entryGateFailsWhenUnresolvable = !orphaned.stdout.includes('=== Verification Complete ===') &&
        orphaned.stdout.includes('=== Verification FAILED ===');
    }
    // Left UNSET when there is no shell, on purpose. It used to be set to `true` here, which made a
    // host that never ran the gate report "removing the entry turns the gate red: yes" — an unrun arm
    // reading as a passed one, the same "a scan that was never collected must FAIL rather than pass
    // on absence of evidence" rule the command-reference group is built on. Unset is excluded from
    // the no-shell conjunction below, alongside the other arms that need a shell to observe.

    // 8. A declared check that did not run must turn the gate RED, not print a notice beside a
    //    success tail.
    //
    // RAN=0 refuses when EVERY check was skipped, which is the honest reading of "at least one ran".
    // It is blind to the case this arm exists for: a project asked for `npm test` and
    // `npm run lint`, package.json defined only `test`, the lint step skipped, RAN=1 was set by the
    // test that did run, and the script printed "Verification Complete" and exited 0 — a check the
    // user explicitly named reported as covered while never running.
    //
    // Asked of the RENDER, structurally, so it holds on the hosts that have no shell: a skip branch
    // that discards the script's name cannot be refused later, so the name has to be recorded where
    // the foot of the file can read it, and the refusal that reads it must exit non-zero BEFORE the
    // success tail — an `exit 1` after "Verification Complete" is decoration. Two halves, and the
    // second is the load-bearing one: a gate that records the skip and then prints its success tail
    // anyway has satisfied the first.
    undefDir = await mkdtemp(path.join(os.tmpdir(), 'harness-initgrowth-undef-'));
    await writeText(path.join(undefDir, 'package.json'), JSON.stringify({
      name: 'undef-fixture', version: '1.0.0', scripts: { test: 'echo TEST_OK' }
    }));
    let undefRun = { stdout: '', stderr: '' };
    let undefCode = 0;
    try {
      undefRun = await execFileAsync('node', [script, '--target', undefDir, '--commands', 'npm test,npm run lint']);
      await commitFixture(undefDir);
    } catch (error) {
      undefCode = error.code === undefined ? 1 : error.code;
      undefRun = { stdout: error.stdout || '', stderr: error.stderr || '' };
    }
    const undefPath = path.join(undefDir, 'init.sh');
    const undefWritten = await exists(undefPath);
    const undefText = undefWritten ? await readText(undefPath) : '';
    const tailAt = (text) => text.indexOf('=== Verification Complete ===');
    // The lint step is the one the manifest cannot resolve, so it is the step whose skip branch
    // decides this arm. Read out of the rendered file, never out of the renderer's source: a
    // detector derived from the code it audits agrees with that code by construction.
    const lintSkip = (text) => {
      const branch = text.match(/if has_script "lint"; then[\s\S]*?\nfi/);
      return branch ? branch[0] : '';
    };
    // Two clauses, as functions of a FILE rather than of this render, so the teeth arm below can
    // run the same predicate over the render with one piece taken out. Reading the artifact instead
    // of the renderer's source is the point: a detector derived from the code it audits agrees with
    // that code by construction.
    const skipRecorded = (text) => /SKIPPED="\$SKIPPED[^\n]*lint/.test(lintSkip(text));
    // The refusal, and its position. Cut the success tail off first, then look for the refusal in
    // what remains: an `exit 1` printed AFTER "Verification Complete" is decoration, and comparing
    // two offsets measured against different strings is how a check comes to pass on a file whose
    // refusal sat behind the banner. Split on the condition that arms it, so a deleted branch shows
    // up as a missing block and a branch that stopped refusing as one whose first statement is no
    // longer a non-zero exit — the same read the blank-gate group uses on the fallback template.
    const skipRefusedBeforeTail = (text) => {
      const blocks = text.slice(0, tailAt(text)).split('-n "$SKIPPED"').slice(1);
      return blocks.length >= 1 &&
        blocks.every((block) => /^[ \t]*exit[ \t]+[1-9]\d*[ \t]*$/m.test(block.slice(0, 400)));
    };
    result.declaredSkipTurnsGateRed = undefWritten && undefCode === 0 &&
      skipRecorded(undefText) && skipRefusedBeforeTail(undefText);

    // Teeth, one clause at a time, on the artifact the arm above just judged. A hand-written sample
    // would only prove the predicate reads its own fixture; this is the real render minus the one
    // block the mutation removes. The recorder clause must still hold on it — the skip branch is
    // untouched — while the refusal clause must lose, and each is required separately because a
    // single all-of would be satisfied by one predicate standing in for both. Left unset rather
    // than true when the render carries no skip branch at all: there is nothing to take out then,
    // and an arm that reports teeth on an artifact it never damaged is the same unrun-arm-as-passed
    // defect the entry arm above records.
    const undefWithoutRefusal = lintSkip(undefText).length > 0
      ? undefText.replace(/if \[ -n "\$SKIPPED" \]; then[\s\S]*?\nfi\n/, '')
      : '';
    result.declaredSkipDetectorHasTeeth = undefWithoutRefusal.length > 0 &&
      skipRecorded(undefWithoutRefusal) && !skipRefusedBeforeTail(undefWithoutRefusal);

    // 9. The positive control, and the direction that stops the fix collapsing into "refuse
    // everything": a manifest that DOES define both scripts must still get both steps, both
    // reaching RAN=1, and no name in the accumulator that would refuse it. A gate that recorded
    // every step as skipped — or that dropped the checks it could have run — satisfies arm 8 exactly
    // as well, and only this fixture tells the two apart. Structural here so it also holds where no
    // shell exists; the behavioural half of both arms rides the shell probe below.
    declaredDir = await mkdtemp(path.join(os.tmpdir(), 'harness-initgrowth-declared-'));
    await writeText(path.join(declaredDir, 'package.json'), JSON.stringify({
      name: 'declared-fixture', version: '1.0.0',
      scripts: { test: 'echo TEST_OK', lint: 'echo LINT_OK' }
    }));
    await execFileAsync('node', [script, '--target', declaredDir, '--commands', 'npm test,npm run lint']);
    await commitFixture(declaredDir);
    const declaredText = await readText(path.join(declaredDir, 'init.sh'));
    const declaredSteps = [...declaredText.matchAll(/^[ \t]*(npm test|npm run lint)$/gm)].map((match) => match[1]);
    // The counter, not the step list: a step rendered without one would satisfy the first clause
    // while leaving the gate unable to tell it ran. Counted with the indentation the renderer emits,
    // the same way the prefix arms above count the markers in a file they did not write.
    const declaredRan = declaredText.split('\n').filter((line) => line.trim() === 'RAN=1').length;
    // And the accumulator starts empty, with every later write confined to a guard's skip branch.
    // This is the clause that separates "runs what it has" from "records every step then refuses":
    // the refusals above fire off a non-empty accumulator, so a project that defines both scripts
    // must reach the success tail, not the refusal the other fixture earns. It cannot be read as
    // "no SKIPPED line exists" — every guarded step renders one, because whether its branch is taken
    // is a run-time fact and the file is written before the run. Nor as "every SKIPPED line is the
    // empty initializer", which no file containing a guard could satisfy. What separates the two
    // designs is WHERE a write may sit: an initializer at column 0, and every other write indented
    // inside a guard, so a manifest that defines the script reaches the tail.
    const declaredSkippedLines = declaredText.split('\n').filter((line) => /^[ \t]*SKIPPED=/.test(line));
    const declaredRecordsNothing = declaredSkippedLines.length >= 1 &&
      declaredSkippedLines.every((line, index) => (index === 0
        ? /^SKIPPED=""/.test(line)
        : /^[ \t]+SKIPPED=/.test(line)));
    result.declaredScriptStillRuns = declaredSteps.includes('npm test') && declaredSteps.includes('npm run lint') &&
      declaredRan >= 2 && declaredRecordsNothing;

    // 9b. The behavioural half of both arms, where a shell exists. Arm 8's whole claim is about the
    // exit status a caller sees, and a text predicate can only stand in for it. Two runs, opposite
    // verdicts, one fixture each: the gate that cannot resolve lint must not reach the success tail,
    // and the gate that can resolve both must. Unset rather than true when no shell answers, for the
    // reason the entry arm above records — an unrun arm reading as a passed one is the same
    // "absence of evidence is not evidence" defect, in the other direction.
    if (shellAvailable) {
      const undefRunOut = await runGateWithShell(shellCandidate, undefDir);
      const declaredRunOut = await runGateWithShell(shellCandidate, declaredDir);
      const tail = '=== Verification Complete ===';
      // Both halves, and the second is the one a mutant slips through: a gate that records the skip
      // and then `exit 0`s prints no success tail while still reporting success to whatever called
      // it, so absence of the banner alone reads as a red gate. The exit STATUS is the claim this
      // arm is about — the failure banner is not, because the ERR trap only fires on a command that
      // failed, and a deliberate `exit 1` at the foot of the file is the ordinary shape here.
      result.declaredSkipGateIsRed = !undefRunOut.unavailable && !undefRunOut.ok &&
        !undefRunOut.stdout.includes(tail) && /lint/.test(undefRunOut.stdout);
      result.declaredGateIsGreen = !declaredRunOut.unavailable && declaredRunOut.ok &&
        declaredRunOut.stdout.includes(tail);
    }

    // 10. Every toolchain branch of the manual fallback must raise RAN on the tool's own verdict,
    //     never on the mere fact that the tool ran.
    //
    // Python/Go/Rust/Maven/Gradle/.NET all have one check that exits 0 when it has nothing to do:
    // pytest collects zero tests and still reports exit 5 as its own "I ran and found nothing",
    // go test passes a package with no test file, cargo test passes a crate with no test, surefire
    // reports BUILD SUCCESS having run nothing, the Gradle test task is NO-SOURCE, and the .NET test
    // platform says so in its own output. A branch that sets RAN after those and nothing else
    // reports coverage for a project that has none, which is the same defect arms 8 and 9 rule out
    // for the manifest branch. The contract the arms below hold every one of those branches to:
    // RAN is raised only where a check verified real work, and the two ways of not doing so — nothing
    // to check, and a check that failed — are named apart in the output.
    //
    // Two levels, because they fail differently. The structural arm reads the shipped file and asks
    // each branch to reach its own refusal before RAN, so it holds on a host with no toolchain
    // installed; its teeth arm removes one branch's refusal from the real file and requires the
    // predicate to lose. The behavioural arms actually run the fallback twice over one fixture whose
    // toolchain is a stub reporting the tool's own empty and populated verdicts — the empty run must
    // refuse and the populated one must reach the success tail, and the refusal must quote the tool's
    // reason rather than a generic sentence, so a reader can tell "no tests exist yet" from "the
    // tests failed". A stub rather than a real toolchain, because requiring go, cargo, mvn, gradlew
    // and dotnet to be installed would make this arm fail wholesale on hosts that have none of them,
    // and a check nobody can run verifies nothing. Unset rather than true where no shell answers.
    const TOOL_BRANCHES = [
      { name: 'python', banner: 'Running Python verification', manifest: 'pyproject.toml', tool: 'pytest' },
      { name: 'go', banner: 'Running Go verification', manifest: 'go.mod', tool: 'go test -list' },
      { name: 'rust', banner: 'Running Rust verification', manifest: 'Cargo.toml', tool: 'cargo test' },
      { name: 'maven', banner: 'Running Maven verification', manifest: 'pom.xml', tool: 'mvn test' },
      { name: 'gradle', banner: 'Running Gradle verification', manifest: 'build.gradle', tool: 'Gradle test task' },
      { name: 'dotnet', banner: 'Running .NET verification', manifest: 'App.csproj', tool: 'dotnet test' }
    ];
    // The block a branch owns: from its own banner to the next branch's banner, so a branch cannot
    // be satisfied by a refusal sitting in its neighbour, and RAN=1 cannot be satisfied by one
    // sitting in the package.json branch above. Anchored on the banner rather than on the manifest
    // test because the .NET branch selects its project by glob (`ls *.csproj || ls *.sln`) rather
    // than by a `-f` test, and an anchor one branch does not use would read that branch as absent
    // and report the group red for a file that is in fact guarded.
    const branchBlock = (text, branch) => {
      const start = text.indexOf(branch.banner);
      if (start < 0) return '';
      const rest = text.slice(start);
      const stops = TOOL_BRANCHES
        .filter((other) => other !== branch)
        .map((other) => rest.indexOf(other.banner))
        .filter((index) => index >= 0);
      const tail = rest.indexOf('\nelse\n');
      if (tail >= 0) stops.push(tail);
      return stops.length > 0 ? rest.slice(0, Math.min(...stops)) : rest;
    };
    // Raised only after the branch's own refusal, and both refusal paths present. Three clauses
    // because each is satisfiable alone: a branch can carry the refusals and still set RAN first (a
    // pass nobody earned), carry one refusal and miss the other (a failing check reported as an
    // empty one), or set RAN inside the guard rather than after it.
    const branchEarnsRan = (text, branch) => {
      const block = branchBlock(text, branch);
      if (!block) return false;
      const refusals = [
        block.includes('refuse_nothing_to_check'),
        block.includes('refuse_check_failed')
      ];
      const ranAt = block.indexOf('RAN=1');
      const refusalsComplete = block.lastIndexOf('refuse_') < block.lastIndexOf('fi');
      return refusals.every(Boolean) && ranAt > block.lastIndexOf('refuse_') && refusalsComplete;
    };
    const fallbackTemplate = (await readText(path.join(skillRoot, FALLBACK_INIT_TEMPLATE))).replace(/\r\n/g, '\n');
    result.emptyToolBranchesGuarded = TOOL_BRANCHES.every((branch) => branchEarnsRan(fallbackTemplate, branch));
    // Teeth on the shipped file rather than on a sample: one branch's empty-test refusal is deleted
    // and the arm must go red on that branch alone. A hand-written sample would only prove the
    // predicate reads its own fixture.
    const goBranch = TOOL_BRANCHES[1];
    const goBlock = branchBlock(fallbackTemplate, goBranch);
    const goWithoutRefusal = goBlock.replace(
      /[ \t]*if[ \t]+!?[ \t]*printf[^\n]*\n[ \t]*refuse_nothing_to_check[^\n]*\n[ \t]*fi\n/m, ''
    );
    result.emptyToolBranchesHaveTeeth = result.emptyToolBranchesGuarded &&
      goWithoutRefusal.length > 0 && goWithoutRefusal !== goBlock &&
      !branchEarnsRan(fallbackTemplate.replace(goBlock, goWithoutRefusal), goBranch);

    if (shellAvailable) {
      // One stub toolchain, two of its verdicts. Each stub replays what the real tool prints when it
      // has no test to run and when it has a passing one, so the branch under test is reading the
      // tool's own answer rather than a shape this suite invented. STUB_MODE chooses which, because
      // two fixtures per branch is twelve directories for a claim that is about the split.
      const STUB_TOOLS = {
        go: [
          'if [ "$1" = test ] && [ "$2" = -list ]; then',
          '  [ "$STUB_MODE" = empty ] && exit 0',
          '  echo "ok  example.com/pkg"',
          '  echo "TestAdd"',
          '  exit 0',
          'fi',
          'exit 0'
        ],
        cargo: [
          'if [ "$1" = test ] && [ "$2" = "--" ]; then',
          '  [ "$STUB_MODE" = empty ] && exit 0',
          '  echo "app::tests::add: test"',
          '  exit 0',
          'fi',
          'exit 0'
        ],
        mvn: [
          'if [ "$STUB_MODE" = empty ]; then',
          '  echo "No tests to run."',
          'else',
          '  echo "Tests run: 1, Failures: 0, Errors: 0, Skipped: 0"',
          'fi',
          'exit 0'
        ],
        dotnet: [
          'if [ "$STUB_MODE" = empty ]; then',
          '  echo "No test is available in bin/Debug/net8.0/App.dll"',
          '  exit 1',
          'fi',
          'echo "Passed!  - Failed: 0, Passed: 1, Skipped: 0, Total: 1"',
          'exit 0'
        ]
      };
      // gradlew is invoked as ./gradlew from the project directory, so it is a project file rather
      // than a PATH entry; the fixture below writes it beside the manifest.
      const GRADLEW = [
        'if [ "$STUB_MODE" = empty ]; then',
        '  echo "> Task :test NO-SOURCE"',
        'else',
        '  echo "> Task :test"',
        'fi',
        'echo "BUILD SUCCESSFUL"',
        'exit 0'
      ];
      // The Python branch runs `$PY -m pytest` and `-m compileall` on a real interpreter, so its
      // stub is a `python3` earlier on PATH that answers both sub-commands: 5 with nothing collected,
      // which is the exit pytest itself uses for that outcome.
      const PYTHON_STUB = [
        'case "$1" in',
        '  -m)',
        '    if [ "$2" = pytest ]; then',
        '      [ "$STUB_MODE" = empty ] && exit 5',
        '      echo "1 passed"',
        '      exit 0',
        '    fi',
        '    exit 0 ;;',
        'esac',
        'exit 0'
      ];
      const TOOL_EXEC = {
        python: { name: 'python3', lines: PYTHON_STUB },
        go: { name: 'go', lines: STUB_TOOLS.go },
        rust: { name: 'cargo', lines: STUB_TOOLS.cargo },
        maven: { name: 'mvn', lines: STUB_TOOLS.mvn },
        dotnet: { name: 'dotnet', lines: STUB_TOOLS.dotnet },
        gradle: { name: null, lines: GRADLEW }
      };
      emptyToolDir = await mkdtemp(path.join(os.tmpdir(), 'harness-initgrowth-emptytool-'));
      const binDir = path.join(emptyToolDir, 'bin');
      await writeText(path.join(binDir, '.keep'), '');
      for (const branch of TOOL_BRANCHES) {
        const tool = TOOL_EXEC[branch.name];
        const target = tool.name ? path.join(binDir, tool.name) : null;
        if (target) {
          await writeText(target, `#!/bin/bash\n${tool.lines.join('\n')}\n`);
          await chmodExec(target);
        }
      }
      const tail = '=== Verification Complete ===';
      const redByBranch = new Map();
      const greenByBranch = new Map();
      for (const branch of TOOL_BRANCHES) {
        for (const mode of ['empty', 'full']) {
          const dir = path.join(emptyToolDir, `${branch.name}-${mode}`);
          await writeText(path.join(dir, branch.manifest), '');
          if (branch.name === 'gradle') {
            await writeText(path.join(dir, 'gradlew'), `#!/bin/bash\n${GRADLEW.join('\n')}\n`);
            await chmodExec(path.join(dir, 'gradlew'));
          }
          await writeText(path.join(dir, 'init.sh'), fallbackTemplate);
          await chmodExec(path.join(dir, 'init.sh'));
          await commitFixture(dir);
          const run = await runGateWithShell(shellCandidate, dir, {
            PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
            STUB_MODE: mode
          });
          if (run.unavailable) continue;
          if (mode === 'empty') {
            // Red for the reason the tool gave, quoted rather than paraphrased: the reader has to be
            // able to tell a project with no tests from a project whose tests failed. Recorded per
            // branch and required of EVERY branch, because an OR across them would let five correct
            // branches carry one that went back to reporting an empty suite as verified.
            const named = new RegExp(`nothing was verified — [^\\n]*${branch.tool}`);
            redByBranch.set(branch.name, !run.ok && !run.stdout.includes(tail) && named.test(run.stdout));
          } else {
            greenByBranch.set(branch.name, run.ok && run.stdout.includes(tail));
          }
        }
      }
      result.emptyToolRunsRed = TOOL_BRANCHES.every((branch) => redByBranch.get(branch.name) === true);
      result.emptyToolRunsGreen = TOOL_BRANCHES.every((branch) => greenByBranch.get(branch.name) === true);
      // Teeth, behavioural this time: the template with one branch's empty-test refusal deleted has
      // to come back GREEN on the very fixture that made it red, or the red above is the stub's
      // doing rather than the branch's.
      const teethDir = path.join(emptyToolDir, 'teeth');
      const goWithoutRefusalText = fallbackTemplate.replace(goBlock, goWithoutRefusal);
      await writeText(path.join(teethDir, 'go.mod'), '');
      await writeText(path.join(teethDir, 'init.sh'), goWithoutRefusalText);
      await chmodExec(path.join(teethDir, 'init.sh'));
      await commitFixture(teethDir);
      const teethRun = await runGateWithShell(shellCandidate, teethDir, {
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
        STUB_MODE: 'empty'
      });
      result.emptyToolGateTeeth = !teethRun.unavailable && teethRun.ok &&
        teethRun.stdout.includes(tail);
    }

    const sharedArms = result.grew && result.preserved && result.idempotent && result.detectorHasTeeth &&
      result.loopStated && result.loopIsLoadBearing &&
      result.declaredSkipTurnsGateRed && result.declaredSkipDetectorHasTeeth &&
      result.declaredScriptStillRuns &&
      result.emptyToolBranchesGuarded && result.emptyToolBranchesHaveTeeth;
    result.pass = sharedArms && result.deadBranchRefused && result.rolledBack &&
      result.refusalNamesCommand && result.refusalNameHasTeeth &&
      result.missingRefused && result.unparseableRefused &&
      result.entryAppended && result.entryUnguarded && result.entryIdempotent &&
      result.entryMissingRefused && result.entryRulesHaveTeeth &&
      result.entryGateFailsWhenUnresolvable && result.declaredSkipGateIsRed && result.declaredGateIsGreen &&
      result.emptyToolRunsRed && result.emptyToolRunsGreen && result.emptyToolGateTeeth;

    // Arms 1 and 2 need no shell, so they run everywhere. The arms that confirm behaviour — the
    // run-it confirmation, its rollback and the syntax refusal's effect on a green gate — are exactly
    // the arms a shell is required to observe, and this suite runs no shell by design. Without one,
    // the structural arms still report and the behavioural ones are marked unconfirmed rather than
    // silently counted as pass or fail.
    if (!shellAvailable) {
      // missingRefused and the loop arms need no shell: the first only asks whether a refusal was
      // printed and a file went uncreated, the second only reads a rendered file. Dropping them here
      // would lose coverage that is available on exactly the hosts that cannot run the gate. The
      // entry arms join them for the same reason — every one but the last is a text or file
      // assertion, so a host without a shell still gets the append shape, the idempotence, the
      // missing-entry refusal and the whole path table.
      result.pass = result.grew && result.preserved && result.idempotent &&
        result.missingRefused && result.detectorHasTeeth &&
        result.loopStated && result.loopIsLoadBearing &&
        result.entryAppended && result.entryUnguarded && result.entryIdempotent &&
        result.entryMissingRefused && result.entryRulesHaveTeeth &&
        result.declaredSkipTurnsGateRed && result.declaredSkipDetectorHasTeeth &&
        result.declaredScriptStillRuns &&
        result.emptyToolBranchesGuarded && result.emptyToolBranchesHaveTeeth;
      result.skipped = 'no POSIX shell: the run-it confirmation, its rollback, the syntax refusal\'s effect on a green gate, "removing the entry turns the gate red", the two exits of the skipped-declared-check arm, and the empty and populated runs of every toolchain branch were not exercised';
      return result;
    }
    return result;
  } catch (error) {
    return { ...result, error: error.message };
  } finally {
    for (const target of [growDir, deadDir, missingDir, unparseDir, entryDir, undefDir, declaredDir, emptyToolDir, probeDir]) if (target) await rm(target, { recursive: true, force: true });
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
  const selfCheckSection = `<section>
      <h2>Script Self-Check <span>${report.selfCheck.pass ? 'PASS' : 'FAIL'}</span></h2>
      <p>Scaffolded a throwaway harness and scored it ${report.selfCheck.score}/100 — confirms the bundled scripts run end-to-end rather than merely being present.${coverageLine}${selfCheckLines}${report.selfCheck.error ? ` Error: ${escapeHtml(report.selfCheck.error)}` : ''}</p>
    </section>`;
  // Under --self-check-only there is no harness report to render, and passing null into the audit
  // renderer would throw where the report is built. The section says so in words instead of showing
  // a zero: an absent audit and a harness that scored nothing are different facts, and a report that
  // cannot tell them apart is the same defect in a different place.
  const harnessHtml = report.harness
    ? htmlReport(report.harness, `Harness Benchmark: ${path.basename(report.target)}`)
    : `<main><h1>Toolchain Self-Check</h1><section>
        <h2>Harness Audit <span>NOT RUN</span></h2>
        <p>--self-check-only was given, so ${escapeHtml(path.basename(report.target))} was not audited.
           This report says nothing about that directory's harness.</p>
      </section></main>`;
  const evalHtml = harnessHtml
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