#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  formatScoreReport,
  htmlReport,
  loadHarnessFiles,
  parseArgs,
  readJson,
  scoreHarness,
  writeText
} from './lib/harness-utils.mjs';

const execFileAsync = promisify(execFile);

// English tracker-mode fixture used by the self-check's second stage. Declared before
// the top-level flow below — const initializers would still be in the TDZ otherwise.
const ENGLISH_AGENTS_MD = `# AGENTS.md

Project harness for reliable agent-assisted development.

## Startup workflow

Before writing code:

1. Read this file in full
2. Read \`CONTEXT.md\` for domain vocabulary and recent ADRs in \`docs/adr/\`
3. Run \`./init.sh\` to verify the environment
4. Read \`.scratch/handoff.md\` if a handoff exists
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

1. Write a reference-style handoff to \`.scratch/handoff.md\`: goal, current status, recommended next step; reference specs, ADRs and commits by path, never copy their content
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
  console.log(`Usage: node scripts/run-benchmark.mjs [--target DIR] [--output FILE] [--html FILE] [--no-self-check]

Runs a lightweight harness benchmark:
  1. Self-check: scaffold a throwaway harness and confirm it validates (proves the scripts work).
  2. Scores the current target harness.
  3. Checks eval coverage in evals/evals.json.
  4. Produces a JSON report and optional HTML report.

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
// The second stage guards bilingual scoring: Matt-style toolchains (to-spec, handoff,
// grill-with-docs) produce English artifacts, so an English tracker-mode harness must
// score just as well as the Chinese registry-mode scaffold.
async function runSelfCheck() {
  let dir;
  try {
    dir = await mkdtemp(path.join(os.tmpdir(), 'harness-selfcheck-'));
    await writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'selfcheck', scripts: { check: 'tsc', test: 'vitest run', build: 'vite build' } })
    );
    await execFileAsync('node', [path.join(scriptDir, 'create-harness.mjs'), '--target', dir]);
    const scored = scoreHarness(await loadHarnessFiles(dir));
    const english = await scoreEnglishTrackerFixture(dir);
    const minScore = Number(args.minSelfCheckScore || 90);
    return {
      pass: scored.overall >= minScore && english.overall >= minScore,
      score: scored.overall,
      englishScore: english.overall,
      bottleneck: scored.bottleneck ?? english.bottleneck
    };
  } catch (error) {
    return { pass: false, score: 0, error: error.message };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
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

function recommend(harnessResult, evalResult) {
  if (harnessResult.overall >= 85 && evalResult.score >= 90) {
    return 'Ready for realistic before/after agent-session benchmarking.';
  }
  if (harnessResult.overall < 70) {
    return `Improve the ${harnessResult.bottleneck} subsystem before benchmarking agent behavior.`;
  }
  if (evalResult.score < 80) {
    return 'Expand eval coverage before treating benchmark results as representative.';
  }
  return 'Usable, with some gaps worth tightening after first real sessions.';
}

function renderBenchmarkHtml(report) {
  const selfCheckSection = report.selfCheck?.skipped
    ? ''
    : `<section>
      <h2>Script Self-Check <span>${report.selfCheck.pass ? 'PASS' : 'FAIL'}</span></h2>
      <p>Scaffolded a throwaway harness and scored it ${report.selfCheck.score}/100, plus an English tracker-mode fixture at ${report.selfCheck.englishScore ?? 0}/100 — confirms the bundled scripts run end-to-end and scoring is bilingual.${report.selfCheck.error ? ` Error: ${escapeHtml(report.selfCheck.error)}` : ''}</p>
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
