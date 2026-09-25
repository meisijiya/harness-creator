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
//
// The multiplier was widened 1.15 -> 1.25 on 2026-09-23 BY THE USER, not by this script. The trigger
// was a measured dead end rather than a desire for a bigger file: SKILL.md sat at 11062/11066 with
// 4 bytes of runway, and every dimension still carrying a weighted gap (frontmatter 7, failure-mode
// encoding 12, checkpoint design 6) needs net-new prose instead of rewording — so 4 bytes of runway
// blocks the whole remaining queue. It gets its own constant because it is the number a user
// decision moves; the baseline is not.
//
// The BASELINE moved 9623 -> 9950 on 2026-09-24, also by user decision, and for a different reason
// than the multiplier: the scope grew rather than the prose thickening. The boundary section now has
// to route between two delegated owners (superpowers and mattpocock) on a runtime condition instead
// of naming one, and that routing cannot be compressed into a pointer without leaving the agent
// unable to tell who owns the stage it is standing in. Recorded here because a raised cap with no
// stated reason reads, six months on, exactly like an unexamined ratchet.
const SKILL_MD_BASELINE_BYTES = 9950;
const SKILL_MD_GROWTH = 1.25; // widened from 1.15 by user decision, 2026-09-23
const SKILL_MD_MAX_BYTES = Math.floor(SKILL_MD_BASELINE_BYTES * SKILL_MD_GROWTH);

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
//
// Raised 3200 -> 3680 on 2026-09-24 by user decision, and this one is worth flagging rather than
// burying: it is precisely the move the paragraph above warns against. The anchor WAS external (the
// upstream template plus a CJK allowance) and it no longer holds, because the scope itself changed —
// the file now routes between two delegated owners on a runtime condition. The measured need was
// +518 bytes for that routing rule; the alternative on the table was to cut steps out of the startup
// or wrap-up routine to buy the room, which trades a real loss in the artifact for a fake constraint
// on the template. What keeps it from being a ratchet is that the delta is anchored to the rule that
// required it rather than to whatever the template happens to render at.
const AGENTS_MD_BASELINE_BYTES = 3680;
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
// 'entries' left with the state artifacts. Its whole subject was the shape of feature_list.json —
// that a fresh scaffold ships no project-shaped entries and states the alignment rule first. With
// no registry to inspect, the assertion had nothing left to read, and a group kept alive to inspect
// a file the skill no longer writes is the same "check and template on the same side" defect one
// level up: the gate would be asserting the existence of the thing that was removed.
const SELF_CHECK_GROUPS = [
  'budget', 'agentsBudget', 'agentsDiscover', 'scopeBrake', 'maintenance', 'skillDesign', 'dryRun',
  'selfRefs', 'bottleneckTies', 'blankGate', 'blueprint', 'agentFile', 'reportContract'
];

// One sentence builder per group, keyed by the same names. The self-check asserts the two sets are
// equal in both directions, so a group without a line (console-only) and a line without a group
// (prose nothing backs) both fail instead of shipping. Each builder gets the group object and must
// return '' for a missing group.
const SELF_CHECK_REPORT_LINES = new Map([
  ['budget', (group) => ` SKILL.md sits at ${group.size}/${group.max} bytes (${group.pass ? 'within' : 'OVER'} budget).`],
  ['agentsBudget', (group) => ` The generated AGENTS.md stays inside its external byte, line and working-rule budgets (${group.pass ? 'verified' : 'FAILED'}).`],
  ['agentsDiscover', (group) => ` The instruction file does not restate what the agent can read for itself, and the detector is proven to have teeth by a seeded violation (${group.pass ? 'verified' : 'FAILED'}).`],
  ['scopeBrake', (group) => ` The generated instruction file routes between its two delegated owners on a runtime condition, names to-tickets, handoff and their setup prerequisite, and carries none of the removed doctrine (${group.pass ? 'verified' : `missing routing ${(group.missingRouting || []).join(', ') || 'none'}; routing detector ${group.routingTeeth ? 'has teeth' : 'BLIND'}; brake ${group.brake ? 'present' : 'MISSING'}; leaked ${(group.leaked || []).join(', ') || 'none'}; doctrine detector ${group.seeded?.length ? 'has teeth' : 'BLIND'}`}).`],
  ['maintenance', (group) => ` Harness maintenance has a moment to happen: the generated instruction file tells the agent to optimise the harness at wrap-up when the session's own output leaves it stale or thin, rather than when the harness files happen to have been touched, and the detector is proven to have teeth per term and against the old diff-keyed phrasing (${group.pass ? 'verified' : `stated ${group.stated ? 'yes' : 'MISSING'}; missing terms ${(group.missing || []).join(', ') || 'none'}; per-term detector ${group.teeth ? 'has teeth' : 'BLIND'}; old-form rejection ${group.oldFormRejected ? 'honoured' : 'LEAKED'}`}).`],
  ['skillDesign', (group) => ` The skill's own design rules are machine-checked rather than trusted to prose: SKILL.md's design section states the wrap-up criterion on the session's own output, and the detector is proven to have teeth per term, against the pre-09-25 rule line, against the old condition wearing the new vocabulary, and against a shortened requirement list (${group.pass ? 'verified' : `stated ${group.stated ? 'yes' : 'MISSING'}; missing terms ${(group.missing || []).join(', ') || 'none'}; diff key ${(group.leaked || []).length ? `LEAKED (${group.leaked.join(', ')})` : 'absent'}; per-term detector ${group.teeth ? 'has teeth' : 'BLIND'}; old rule line ${group.oldFormRejected ? 'rejected' : 'ACCEPTED'}; hybrid form ${group.hybridRejected ? 'rejected' : 'ACCEPTED'}; list-shrink witness ${group.witness ? 'has teeth' : 'BLIND'}`}).`],
  ['dryRun', (group) => ` --dry-run writes nothing, reports the target's real state, and its plan matches the live run entry for entry (${group.pass ? 'verified' : 'FAILED'}).`],
  ['selfRefs', (group) => ` ${group.checked} shipped file(s) checked for command reachability from a target repo (${group.pass ? 'all runnable' : `relative self-reference in ${(group.offenders || []).join(', ')}`}).`],
  ['bottleneckTies', (group) => ` The bottleneck line names ${group.tieCount} tied subsystem(s) as a tie instead of picking one (${group.pass ? 'verified' : 'FAILED'}).`],
  ['blankGate', (group) => ` A project with nothing to verify — no manifest, or a manifest with no runnable script — gets a placeholder step that exits non-zero instead of reporting a pass it did not earn, and the manual fallback template refuses on the same two shapes (${group.pass ? 'verified' : 'FAILED'}).`],
  ['blueprint', (group) => ` The project-description slot stays a visible pending marker when the user has not stated one, while a blueprint change rewrites that slot only — the rest of the file survives byte for byte, and a shape this skill did not render is refused rather than guessed at (${group.pass ? 'verified' : `pending ${group.pendingMarked ? 'ok' : 'NO'}; no stack fill ${group.noInventedFill ? 'ok' : 'NO'}; verbatim ${group.verbatim ? 'ok' : 'NO'}; slot-only ${group.slotRewritten && group.restIntact ? 'ok' : 'NO'}; detector ${group.detectorHasTeeth ? 'has teeth' : 'BLIND'}; refusal ${group.refusalHonoured && group.refusedUntouched ? 'ok' : 'NO'}`}).`],
  ['agentFile', (group) => ` An existing CLAUDE.md is reused instead of having AGENTS.md created beside it, and an existing instruction file is left byte-identical while its missing sections are still reported (${group.pass ? 'verified' : 'FAILED'}).`],
  ['reportContract', (group) => ` The report a human reads names the subsystem count the model actually has, and the renderer honours the output path it is given instead of exiting 0 at the default one (${group.pass ? 'verified' : `flag ${group.honouredFlag ? 'honoured' : 'DROPPED'}; contradicting claim ${(group.reported || []).join(', ') || 'none'}; detector ${group.seededCaught ? 'has teeth' : 'BLIND'}`}).`]
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
const FORBIDDEN_IN_AGENTS_MD = [
  { name: 'in-repo state registry', pattern: /feature[-_]list\.json/ },
  { name: 'in-repo progress log', pattern: /progress\.md/ },
  { name: 'landing-point doctrine', pattern: /落点/ },
  { name: 'tracking-policy section', pattern: /产物追踪策略/ },
  { name: 'controlled release', pattern: /受控放行/ },
  { name: 'governance modes', pattern: /两种模式|--mode\b/ },
  { name: 'extracted agent-doc layer', pattern: /tracking-policy\.md|escalation\.md/ },
  // Narrowed 09-24 by the same user ruling that added ROUTING_TERMS above. What is forbidden is an
  // INSTALLATION check: telling the agent to test whether another skill is installed, or to point the
  // user at installing one. That was the shape this pattern was added for on 09-23 and it has not
  // changed. What is now required, and therefore allowed, is a RUNTIME presence read — the render
  // routes between superpowers and mattpocock on whether the superpowers bootstrap is in the agent's
  // own system prompt, which the agent observes without inspecting anything on disk. Different
  // sentence, different subject. The routing rule cannot be stated without the second, so the pattern
  // stays on installation shape and the positive half lives in ROUTING_TERMS.
  // The pattern is deliberately narrow — it must not fire on the correct render, which says "承接方默认已安装，本技能不检查、
  // 不安装" (a negation). Matching a bare 已安装 would make the gate reject its own correct output.
  { name: 'owner-installation check', pattern: /承接方.{0,10}(未安装|是否已安装)|提示安装|检查.{0,4}是否已安装/ }
];
const SEEDED_VIOLATION = '\n状态写入 feature_list.json 与 progress.md；产物追踪策略；'
  + '五落点；受控放行；两种模式；分册 tracking-policy.md 与 escalation.md；'
  + '承接方未安装时提示安装。';

// The other half of the boundary. The render no longer names ONE delegated owner; it routes between
// two on a runtime condition, and these are the terms that make that routing legible to an agent
// standing in a target repo. Each is load-bearing: drop the absence branch and an agent whose session
// carries no superpowers bootstrap is left with no owner at all, which is the common case in a plain
// checkout rather than an edge case.
//
// The negative proof is per-term instead of one seeded blob. A blob proves the predicate reads the
// string; deleting exactly one term at a time and requiring the predicate to name exactly that term
// proves it is sensitive to each of them independently, so a render that kept "superpowers" while
// losing the fallback cannot pass on the strength of its survivors.
//
// Declared here, ahead of the runSelfCheck() call site (line 314), for the temporal-dead-zone reason
// this file has already paid for twice.
//
// '判不出' joined 09-24. The first four terms made the two-way routing legible but left its own
// failure mode silent: an agent that cannot tell whether the bootstrap is present had no stated
// recourse, and a three-way condition (present / absent / undecidable) was being carried by two
// terms. Undecidable falls to the absence branch deliberately — the absence branch is the one that
// still has an owner, so the undecidable case degrades to a working default rather than to no owner
// at all. The term is here so that branch cannot be dropped quietly.
const ROUTING_TERMS = ['superpowers', '引导词', '不在场', '判不出', 'mattpocock'];
const missingRoutingTerms = (text) => ROUTING_TERMS.filter((term) => !text.includes(term));

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
// Section-scoped rather than whole-file on purpose — the skill name appears in the delegation
// section too, so a file-wide match would stay green after the wrap-up step was deleted, and a
// file-wide strip would remove the copy that does not matter. Declared HERE, not next to the
// functions that use it: those run from inside runSelfCheck(), which is invoked at line 343, so a
// const sitting beside them is still in its temporal dead zone when first read. This file has paid
// for that mistake four times now, always with the same symptom — a FAIL that looks like a missing
// feature rather than an uninitialised binding.
const maintenanceSection = (text) =>
  text.split(/^##\s+/m).slice(1).find((part) => part.startsWith('会话结束')) || '';

// Every design rule in SKILL.md was unguarded prose until this gate. The suite reads the artifact a
// target repo receives, and SKILL.md is mentioned in this file exactly twice: a byte count
// (checkSkillBudget) and a path-shape scan (checkSelfReferencePaths). Neither reads a word of it.
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
const SKILL_DESIGN_TERMS = ['收尾', '按会话产出', '本技能所管的文件'];
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
  ['本技能所管的文件', '- 收尾＝按会话产出按需优化（指令文件、`init.sh`、工作规则）。']
];
// Section-scoped rather than whole-file: the old wording is still quoted on purpose in the
// maintenance reference and the README as a counter-example, and a file-wide arm would flag that
// deliberate prose. Declared HERE, not beside the functions that use it — those run from inside
// runSelfCheck(), so a const sitting next to them is still in its temporal dead zone when read.
const skillDesignSection = (text) =>
  text.split(/^##\s+/m).slice(1).find((part) => part.startsWith('设计规则')) || '';

// Declared at module scope, ahead of the runSelfCheck() call: a const sitting next to the function
// that reads it would still be in its temporal dead zone at that call site.
const SELFTEXT_EXEMPT = new Set(['README.md']);
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
  ['scopeBrake', 'Scope brake'],
  ['maintenance', 'Maintenance trigger'],
  ['skillDesign', 'SKILL.md design rule'],
  ['dryRun', 'Dry run'],
  ['selfRefs', 'Self-reference paths'],
  ['bottleneckTies', 'Bottleneck ties'],
  ['blankGate', 'Blank-project gate'],
  ['blueprint', 'Blueprint slot'],
  ['agentFile', 'Agent-file invariant'],
  ['reportContract', 'Report contract']
]);





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
  4. Checks the SKILL.md size budget (${SKILL_MD_MAX_BYTES} bytes = ${SKILL_MD_GROWTH}x the ${SKILL_MD_BASELINE_BYTES}-byte baseline).
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
     resolves from the skill directory, and no shipped text may point at a bare skills/<name>/
     prefix. The first names an invocation the agent cannot run, the second a file it cannot open,
     both because its cwd is the target repo rather than the skills directory.
 10. Checks the bottleneck headline: a tie must name every tied subsystem, a unique minimum must
     name one, and a complete harness must report none.
 11. Checks the blank-project gate: the placeholder verification step must exit non-zero, a real
     command must still run, and — asserted through the real generator, not a hand-written string —
     a manifest that defines no check/typecheck/lint/test/build also refuses instead of exiting 0
     having verified nothing. The same invariant has a second producer, the hand-copy fallback
     templates/init.sh, which the generator probes cannot reach: every refusal it prints must be
     armed with a non-zero exit, both refusals must still be present, and a success tail must
     remain. A gate that cannot fail is not a gate.
 12. Checks the plain-description slot: omitting --blueprint must leave a visible pending marker
     rather than stack-derived text, and a supplied description must reach AGENTS.md verbatim.
 13. Checks the instruction-file invariant: an existing CLAUDE.md must not get a second AGENTS.md
     beside it, and an existing instruction file must stay byte-identical while its missing
     harness sections are still reported.
 14. Checks the self-check's own coverage: every group in SELF_CHECK_GROUPS must have a bound check,
     a place in the pass conjunction, a line in the shareable HTML report, and a line on the console
     a human actually reads — four registration points, asserted as one set equality. A gate that
     only ever prints is half a carrier; a gate that is only ever printed is the other half.
 15. Checks the report contract: the renderer must honour the output path it is handed rather than
     reporting success at the default one, and the report a human reads must name the subsystem
     count the model actually has — seeded on both sides, since a detector that finds nothing is
     indistinguishable from one that looks for nothing.
 16. Checks the maintenance trigger: the generated instruction file must tell the agent to optimise
     the harness at wrap-up when the session's own output leaves it stale or thin — NOT when the
     harness files happen to have been touched, which is self-referential and can only see rot it
     already fixed. Seeded on both sides: each term is dropped in turn to prove it is load-bearing,
     and the old diff-keyed sentence must be rejected, so the gate cannot be satisfied by the new
     vocabulary bolted onto the old condition.
 17. Checks the skill's OWN design rules, which no other gate can see: every other group reads the
     artifact a target repo receives, and the only two mentions of SKILL.md in this file are a byte
     count and a path-shape scan. SKILL.md must still state the wrap-up criterion on the session's
     own output, must not key it on files having been touched, and may not carry the old condition
     wearing the new vocabulary. Seeded on four sides — each term dropped in turn, the pre-09-25 rule
     line rejected, the hybrid form rejected, and an incomplete rule refused by the very term it is
     missing — because deleting that rule outright used to leave every other gate green and make the
     byte budget line greener still.
 18. Produces a JSON report and optional HTML report.

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
  for (const line of consoleSelfCheckLines(selfCheck)) console.log(line);
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
// Renders the console block the human reads. Extracted from the top-level flow so the coverage
// check reads the very lines that will be printed — a declared console label that the block never
// emits is the "prose nothing backs" failure this suite refuses everywhere else. It takes the report
// object rather than the individual groups so the check can call it on a preview before the real
// print, and each arm stays guarded so a group that failed to compute prints nothing rather than
// throwing while reporting a failure.
function consoleSelfCheckLines(selfCheck) {
  const lines = [];
  if (!selfCheck || selfCheck.skipped) return lines;
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
    const { pass, offenders = [], selfRestraintStated, seededCaught, error } = selfCheck.agentsDiscover;
    lines.push(`  AGENTS.md discoverability: ${pass ? 'PASS' : 'FAIL'} — default render free of restated content: ${offenders.length === 0 ? 'ok' : `NO (${offenders.join(', ')})`}; self-restraint rule stated: ${selfRestraintStated ? 'ok' : 'NO'}; seeded violation caught: ${seededCaught ? 'ok' : 'NO'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.scopeBrake) {
    const { pass, brake, routing, missingRouting = [], routingTeeth, leaked = [], seeded = [], error } = selfCheck.scopeBrake;
    lines.push(`  Scope brake: ${pass ? 'PASS' : 'FAIL'} — engineering workflow delegated in the generated AGENTS.md: ${brake ? 'ok' : 'NO'}; routes between both owners on a runtime condition: ${routing ? 'ok' : `MISSING (${missingRouting.join(', ')})`}; routing detector has teeth: ${routingTeeth ? 'ok' : 'BLIND'}; doctrine carried over from the removed scope: ${leaked.length === 0 ? 'none' : `LEAKED (${leaked.join(', ')})`}; detector catches a seeded violation: ${seeded.length >= 7 ? 'ok' : `BLIND (${seeded.length}/7 patterns)`}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.maintenance) {
    const { pass, stated, missing = [], teeth, oldFormRejected, error } = selfCheck.maintenance;
    lines.push(`  Maintenance trigger: ${pass ? 'PASS' : 'FAIL'} — wrap-up step keys on the session's own output leaving the harness stale, not on the harness files having been touched: ${stated ? 'ok' : `MISSING (${missing.join(', ') || 'section not found'})`}; per-term detector: ${teeth ? 'ok' : 'BLIND'}; diff-keyed phrasing rejected: ${oldFormRejected ? 'ok' : 'LEAKED'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.skillDesign) {
    const { pass, stated, missing = [], leaked = [], teeth, oldFormRejected, hybridRejected, witness, error } = selfCheck.skillDesign;
    lines.push(`  SKILL.md design rule: ${pass ? 'PASS' : 'FAIL'} — the skill's own design section states the wrap-up criterion on the session's output: ${stated ? 'ok' : `MISSING (${missing.join(', ') || 'section not found'})`}; the diff key it replaced: ${leaked.length === 0 ? 'absent' : `LEAKED (${leaked.join(', ')})`}; per-term detector: ${teeth ? 'ok' : 'BLIND'}; pre-09-25 rule line rejected: ${oldFormRejected ? 'ok' : 'ACCEPTED'}; hybrid form rejected: ${hybridRejected ? 'ok' : 'ACCEPTED'}; requirement-list shrink caught: ${witness ? 'ok' : 'BLIND'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.dryRun) {
    const { pass, changesNothing, previewedFiles, reflectsState, planMatchesRun, wrote = [], error } = selfCheck.dryRun;
    lines.push(`  Dry run: ${pass ? 'PASS' : 'FAIL'} — writes nothing: ${changesNothing ? 'ok' : `NO (still wrote ${wrote.join(', ') || 'files'})`}; plans artifacts: ${previewedFiles ? 'ok' : 'NO'}; reflects existing state: ${reflectsState ? 'ok' : 'NO'}; plan matches the real run: ${planMatchesRun ? 'ok' : 'NO'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.selfRefs) {
    const { pass, offenders = [], checked, error } = selfCheck.selfRefs;
    lines.push(`  Self-reference paths: ${pass ? 'PASS' : 'FAIL'} — ${checked} shipped file(s) checked${offenders.length ? `; unreachable relative path in ${offenders.join(', ')}` : ''}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.bottleneckTies) {
    const { pass, tieCount, uniqueCount, noneCount, tieLabel } = selfCheck.bottleneckTies;
    lines.push(`  Bottleneck ties: ${pass ? 'PASS' : 'FAIL'} — tie names all 3 subsystems: ${tieCount === 3 ? 'ok' : `NO (${tieCount})`}; unique minimum names one: ${uniqueCount === 1 ? 'ok' : `NO (${uniqueCount})`}; complete harness reports none: ${noneCount === 0 ? 'ok' : `NO (${noneCount})`} — ${tieLabel}`);
  }
  if (selfCheck.blankGate) {
    const { pass, placeholderFails, realRuns, scriptlessRefuses, withTestRuns, templateRefusals, templateRefusalsExitNonZero, templateStillRuns } = selfCheck.blankGate;
    lines.push(`  Blank-project gate: ${pass ? 'PASS' : 'FAIL'} — placeholder verification exits non-zero: ${placeholderFails ? 'ok' : 'NO'}; a real command still runs: ${realRuns ? 'ok' : 'NO'}; a manifest with no runnable script refuses too: ${scriptlessRefuses ? 'ok' : 'NO'}; a manifest with a real script still runs: ${withTestRuns ? 'ok' : 'NO'}; the manual fallback carries ${templateRefusals} refusal(s) each armed with a non-zero exit: ${templateRefusalsExitNonZero ? 'ok' : 'NO'}; and still reaches a success tail: ${templateStillRuns ? 'ok' : 'NO'}`);
  }
  if (selfCheck.blueprint) {
    const { pass, pendingMarked, noInventedFill, verbatim, slotRewritten, restIntact, detectorHasTeeth, refusalHonoured, refusedUntouched, error } = selfCheck.blueprint;
    lines.push(`  Blueprint slot: ${pass ? 'PASS' : 'FAIL'} — omitted --blueprint stays a pending marker: ${pendingMarked ? 'ok' : 'NO'}; no stack-derived fill: ${noInventedFill ? 'ok' : 'NO'}; supplied blueprint reaches AGENTS.md verbatim: ${verbatim ? 'ok' : 'NO'}; a rewrite touches the slot only: ${slotRewritten && restIntact ? 'ok' : 'NO'}; detector has teeth: ${detectorHasTeeth ? 'ok' : 'BLIND'}; an unrecognised shape is refused: ${refusalHonoured && refusedUntouched ? 'ok' : 'NO'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.agentFile) {
    const { pass, noSecondFile, choseClaude, untouched, missingReported, error } = selfCheck.agentFile;
    lines.push(`  Agent-file invariant: ${pass ? 'PASS' : 'FAIL'} — existing CLAUDE.md means no AGENTS.md is created: ${noSecondFile && choseClaude ? 'ok' : 'NO'}; existing instruction file left byte-identical: ${untouched ? 'ok' : 'NO'}; missing sections still reported: ${missingReported ? 'ok' : 'NO'}${error ? ` — ${error}` : ''}`);
  }
  if (selfCheck.reportContract) {
    const { pass, honouredFlag, reported = [], claimsModel, seededCaught, error } = selfCheck.reportContract;
    lines.push(`  Report contract: ${pass ? 'PASS' : 'FAIL'} — --html honoured by the renderer: ${honouredFlag ? 'ok' : 'DROPPED (wrote to the default path)'}; report names the model's subsystem count: ${claimsModel ? 'ok' : 'NO'}; contradicting claim: ${reported.length === 0 ? 'none' : `FOUND (${reported.join(', ')})`}; seeded violation caught: ${seededCaught ? 'ok' : 'NO'}${error ? ` — ${error}` : ''}`);
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
      maintenance: () => checkMaintenanceTrigger(),
      skillDesign: () => checkSkillDesignRule(),
      dryRun: () => checkDryRun(),
      selfRefs: () => checkSelfReferencePaths(),
      bottleneckTies: () => checkBottleneckTies(),
      blankGate: () => checkBlankProjectGate(),
      blueprint: () => checkBlueprintSlot(),
      agentFile: () => checkAgentFileInvariant(),
      reportContract: () => checkReportContract()
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
  const multiplierSane = SKILL_MD_GROWTH > 1 && SKILL_MD_GROWTH <= 1.5;
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
    // The required half moved from a generic boundary to the NAMED owners. "Some engineering skill
    // owns this" is unfalsifiable and leaves the agent with nowhere to look, so the render must
    // name to-tickets and handoff, and must name the setup prerequisite that makes them work —
    // otherwise a fresh repo points at a capability it cannot reach yet. The forbidden half is
    // unchanged in shape and re-scoped in content (see FORBIDDEN_IN_AGENTS_MD).
    const brake = /工程\s*skill/.test(text) && /不代做/.test(text)
      && /to-tickets/.test(text) && /handoff/.test(text) && /setup-matt-pocock-skills/.test(text);
    // The routing half, kept as its own label: a render that names both owners but loses the absence
    // branch fails on that point specifically instead of on the brake as a whole, so the failure says
    // which rule went missing rather than only that something did.
    const missingRouting = missingRoutingTerms(text);
    const routing = missingRouting.length === 0;
    // Teeth, one term at a time. Deleting a term and requiring the predicate to report exactly that
    // term proves the check is sensitive to each term on its own; a single seeded blob would only
    // prove it reads the string.
    const routingTeeth = ROUTING_TERMS.every((term) => {
      const reported = missingRoutingTerms(text.split(term).join('\u0000'));
      return reported.length === 1 && reported[0] === term;
    });
    const leaked = FORBIDDEN_IN_AGENTS_MD.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
    const seeded = FORBIDDEN_IN_AGENTS_MD
      .filter(({ pattern }) => pattern.test(`${text}${SEEDED_VIOLATION}`))
      .map(({ name }) => name);
    return {
      pass: brake && routing && routingTeeth && leaked.length === 0 && seeded.length === FORBIDDEN_IN_AGENTS_MD.length,
      brake,
      routing,
      missingRouting,
      routingTeeth,
      leaked,
      seeded
    };
  } catch (error) {
    return { pass: false, brake: false, routing: false, missingRouting: [], routingTeeth: false, leaked: [], seeded: [], error: error.message };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

// Maintenance needs a moment to happen, and until now nothing in the shipped artifact supplied
// one: the skill could assess a harness on request, but a repo's agent had no instruction telling
// it when re-assessment was due. "After a long task, re-assess" carried only by prose is the exact
// failure this suite exists to close — a rule with no mechanical carrier loses to one successful
// wrong action — so the trigger is asserted in the artifact a target repo actually receives.
//
// Keyed on the skill NAME inside the wrap-up section, because that is the only form that resolves
// from the target repo: a path relative to the skill repository is dead on arrival there, and a
// concrete runtime path varies by host. (maintenanceSection() itself is declared up with the terms.)
function maintenanceTriggerStated(text) {
  const section = maintenanceSection(text);
  const missing = MAINTENANCE_TERMS.filter((term) => !section.includes(term));
  return { stated: missing.length === 0, missing };
}

// Scoped to the wrap-up section for the same reason the predicate is, and removing EVERY occurrence
// of the term rather than the first: a term that appears in both the step's heading and its body
// (会话产出 does) would otherwise survive the strip, and the arm would report BLIND on a render that
// is in fact correctly keyed. The arm asks "is this term gone?", so it has to make it gone.
function maintenanceWithout(text, term) {
  const section = maintenanceSection(text);
  return section ? text.replace(section, section.split(term).join('')) : text;
}

async function checkMaintenanceTrigger() {
  let dir;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), 'harness-maintenance-'));
    await execFileAsync('node', [path.join(scriptDir, 'create-harness.mjs'), '--target', dir]);
    const rendered = await readText(path.join(dir, 'AGENTS.md'));
    const { stated, missing } = maintenanceTriggerStated(rendered);
    // Per-term arm: drop exactly one term from the wrap-up section and require the predicate to name
    // exactly that term, so a render that kept the owner name while losing the output criterion
    // cannot pass on the strength of its survivors.
    const teeth = MAINTENANCE_TERMS.every((term) =>
      maintenanceTriggerStated(maintenanceWithout(rendered, term)).missing.includes(term));
    // Negative arm: the diff-keyed sentence this gate replaced must be REJECTED outright. Without it
    // the gate would still accept that sentence with the new vocabulary bolted on.
    const oldForm = `## 会话结束\n\n${MAINTENANCE_OLD_FORM}，候选改动列出后再落地；不做全仓审计\n`;
    const oldFormRejected = !maintenanceTriggerStated(oldForm).stated;
    return { pass: stated && teeth && oldFormRejected, stated, missing, teeth, oldFormRejected };
  } catch (error) {
    return { pass: false, stated: false, missing: [], teeth: false, oldFormRejected: false, error: error.message };
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
    ['Covers delegated state and handoff', /委派/],
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
    ['Covers the scope brake against doing the engineering workflow', /范围边界/],
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
    // Added with the two-owner routing rule. The gate proves the generated file CARRIES the routing
    // sentence; only a case shows whether an agent, handed both skill sets, routes rather than asking
    // the user which one is installed — and whether it keeps state and handoff with the owner that
    // can actually serve them. Same split the maintenance and blueprint entries record above.
    ['Covers the two-owner routing condition', /分流/]
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
  return {
    pass: placeholderFails && realRuns && scriptlessRefuses && withTestRuns
      && templateRefusalsExitNonZero && templateStillRuns,
    placeholderFails,
    realRuns,
    scriptlessRefuses,
    withTestRuns,
    templateRefusals,
    templateRefusalsExitNonZero,
    templateStillRuns
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
