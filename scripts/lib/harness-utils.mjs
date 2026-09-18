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
export const SUBSYSTEMS = ['instructions', 'state', 'verification', 'scope', 'lifecycle'];

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
// covers the section in English or in another wording, so appending would produce two startup
// paths — the drift references/matt-coexistence.md warns about.
export function diffSections(templateMarkdown, existingMarkdown) {
  const existing = existingMarkdown.toLowerCase();
  return markdownSections(templateMarkdown)
    .filter((section) => !existing.includes(section.replace(/^#+\s*/, '').toLowerCase()));
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

  return [install, ...dedupe(candidates)];
}

export function initScriptFromCommands(commands) {
  const body = commands.map(renderVerificationStep).join('\n\n');
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

${body}

echo "=== Verification Complete ==="
echo ""
echo "Next steps:"
echo "1. Read feature_list.json to see current feature state"
echo "2. Read progress.md for current status, blockers and next steps"
echo "3. Read .scratch/handoff.md if a handoff exists"
echo "4. Pick ONE unfinished feature to work on"
echo "5. Implement only that feature"
echo "6. Re-run verification before claiming done"
`;
}

const INSTALL_STEP = /^(?:npm|pnpm|yarn|bun) (?:install|ci|i)$/;
const SCRIPT_STEP = /^(?:npm|pnpm|yarn|bun) (?:run )?([\w:.-]+)$/;
const NON_SCRIPT_ARGS = new Set(['install', 'ci', 'i', 'exec', 'dlx', 'create']);

function renderVerificationStep(command) {
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
    return `if has_script "${name}"; then
  echo "=== ${escapeForEcho(command)} ==="
  ${command}
else
  echo "SKIP: ${escapeForEcho(command)} (package.json has no \\"${name}\\" script yet)"
fi`;
  }

  return `echo "=== ${escapeForEcho(command)} ==="
${command}`;
}

function escapeForEcho(value) {
  return value.replaceAll('"', '\\"');
}

export function dedupe(values) {
  return [...new Set(values)];
}

export function scoreHarness(files) {
  const byPath = new Map(files.map((file) => [file.path, file.content]));
  const allText = files.map((file) => `${file.path}\n${file.content}`).join('\n\n');
  const agents = byPath.get('AGENTS.md') || byPath.get('CLAUDE.md') || '';
  const featureList = byPath.get('feature_list.json') || byPath.get('feature-list.json') || '';
  const progress = byPath.get('progress.md') || '';
  const init = byPath.get('init.sh') || '';
  // Tracker-mode and handoff artifacts. session-handoff.md is the legacy in-repo
  // template; .scratch/handoff.md and CONTEXT.md follow the reference-style,
  // ephemeral convention. Either satisfies the same checks.
  const legacyHandoff = byPath.get('session-handoff.md') || '';
  const scratchHandoff = byPath.get('.scratch/handoff.md') || '';
  const contextDoc = byPath.get('CONTEXT.md') || '';
  // The upstream setup skill owns docs/agents/* and creates CONTEXT.md/ADRs only
  // lazily. Either artifact therefore proves tracker mode on its own:
  // a repo where setup ran before harness-creator has docs/agents/ but no CONTEXT.md yet.
  const domainRouting = byPath.get('docs/agents/domain.md') || '';
  const issueTracker = byPath.get('docs/agents/issue-tracker.md') || '';
  const adrDir = byPath.has('docs/adr/');
  const handoffMaterial = `${scratchHandoff}\n${legacyHandoff}`;
  const stateDocs = `${progress}\n${handoffMaterial}\n${contextDoc}`;

  // Tracker mode: no feature registry, so the state artifact is CONTEXT.md or the tracker
  // routing matt owns, and continuity lives in the ticket system + the AGENTS.md session-end
  // routine. Scoring a tracker harness with registry-shaped checks would report a false
  // "state" bottleneck and push users toward feature_list.json — the wrong mode. When tracker
  // mode is detected, the state/scope checks below read AGENTS.md too and accept tracker
  // vocabulary, and never require harness-shaped markers inside files matt owns.
  // Those files appear only once the upstream setup runs, which this skill deliberately does not
  // do — so in the window right after `create-harness --mode tracker` the generated AGENTS.md is
  // the only evidence of the mode. Read it too, keyed on the vocabulary a human reads there
  // ("state lives in the ticket system"), never on a marker invented to satisfy the scorer.
  const trackerStateVocab = structuredHas(agents, ['工单系统', 'issue tracker', 'ticket system'], '');
  const trackerMode = !featureList && Boolean(contextDoc || domainRouting || issueTracker || adrDir || trackerStateVocab.pass);
  const stateScope = trackerMode ? `${stateDocs}\n${agents}` : stateDocs;

  const stateArtifactStructured = () => {
    if (jsonFeatureList(featureList, '').pass) return true;
    // The upstream tracker routing is a generated, structured spec — accept it as-is rather than
    // forcing a glossary heading that the upstream format never produces.
    if (issueTracker.trim().length > 0) return true;
    // A tracker harness whose long-lived files do not exist yet is structured by construction:
    // its AGENTS.md routes state to the ticket system and the repo is meant to hold no registry.
    // Demanding a file here is what scored a correct tracker harness as a broken one.
    if (trackerMode) return true;
    // CONTEXT.md: accept the upstream canonical format (## Language + **Term**: + _Avoid_) as well
    // as harness vocabulary, so an upstream-authored file scores without edits.
    return structuredHas(contextDoc, ['## Language', '## Terms', '术语', 'glossary', 'domain', '领域'], '').pass;
  };

  const checks = {
    instructions: [
      hasFile(byPath, ['AGENTS.md', 'CLAUDE.md'], 'Agent instruction file exists'),
      structuredHas(agents, ['Startup Workflow', 'Before writing code', '启动工作流', '编写代码前'], 'Startup workflow documented'),
      structuredHas(agents, ['Definition of Done', 'done only when', '完成定义'], 'Definition of done documented'),
      structuredHas(agents, ['Verification Commands', '验证命令', './init.sh', 'test', 'verify', '测试'], 'Verification commands discoverable'),
      structuredHas(agents, ['feature_list.json', 'progress.md', 'CONTEXT.md', 'docs/agents/domain.md'], 'State artifacts routed from instructions')
    ],
    state: [
      trackerMode
        ? { pass: true, message: 'State artifact exists (AGENTS.md routes state to the ticket system; no in-repo registry by design)' }
        : hasFile(byPath, ['feature_list.json', 'feature-list.json', 'CONTEXT.md', 'docs/agents/issue-tracker.md'], 'State artifact exists (feature registry, CONTEXT.md, or tracker routing)'),
      { pass: stateArtifactStructured(), message: 'State artifact is structured (valid feature JSON, CONTEXT.md glossary, or tracker routing)' },
      {
        pass: trackerMode
          ? hasFile(byPath, ['.scratch/handoff.md', 'session-handoff.md'], '').pass
            || structuredHas(agents, ['handoff', '交接'], '').pass
          : hasFile(byPath, ['progress.md', '.scratch/handoff.md', 'session-handoff.md'], '').pass,
        message: 'Continuity artifact exists (progress log, handoff file, or tracker-mode handoff convention)'
      },
      structuredHas(stateScope, ['Current State', '当前状态', 'Status', '现状', '状态', 'Where things stand', 'Where we are'], 'Current state snapshot recorded'),
      {
        pass: structuredHas(`${stateDocs}\n${agents}`, ['Blockers', '阻塞', '依赖', 'Risks', '风险', 'Open questions', 'Remaining'], '').pass
          && structuredHas(`${stateDocs}\n${agents}`, ['Next', '下一步', '接下来', '需求进度', '继续'], '').pass,
        message: 'Blockers and next step captured'
      }
    ],
    verification: [
      hasFile(byPath, ['init.sh'], 'Verification entrypoint exists'),
      textHas(init, ['set -e'], 'Verification fails fast'),
      textHas(init + agents, ['test', 'pytest', 'vitest', 'cargo test', 'go test', 'dotnet test', '测试'], 'Test command documented'),
      textHas(init + agents, ['build', 'type', 'lint', 'compile', '类型', '构建'], 'Static/build check documented'),
      textHas(allText, ['Evidence', 'Verification Evidence', 'command and output', '证据', 'CI'], 'Verification evidence is recorded')
    ],
    scope: [
      structuredHas(agents, ['One feature at a time', 'one-feature-at-a-time', 'one requirement at a time', 'one ticket at a time', '一次一个功能', '一次一个需求', '一次一个工单'], 'One-feature-at-a-time rule exists'),
      textHas(featureList + contextDoc + agents, ['dependencies', '依赖', 'blocking'], 'Dependencies or blocking edges tracked'),
      textHas(agents + featureList, ['status', '状态'], 'Feature status is explicit'),
      structuredHas(agents, ['Stay in scope', 'scope', '保持在范围内', '范围'], 'Scope boundary documented'),
      structuredHas(agents, ['Definition of Done', '完成定义'], 'Completion gate limits scope closure')
    ],
    lifecycle: [
      hasFile(byPath, ['init.sh'], 'Startup script exists'),
      structuredHas(agents, ['End of Session', 'Before ending', '会话结束', '结束会话前'], 'End-of-session procedure exists'),
      {
        pass: legacyHandoff.length > 0 || scratchHandoff.length > 0
          || structuredHas(agents, ['handoff', '交接'], '').pass,
        message: 'Handoff path documented (reference-style convention or file)'
      },
      structuredHas(`${progress}\n${handoffMaterial}\n${agents}`, ['Last Updated', '最后更新', 'Current Objective', '当前目标', 'Recommended Next Step', '推荐的下一步', '下一步', '需求进度', 'Goal', 'Objective', 'Next steps'], 'Session restart markers exist'),
      textHas(agents + init, ['restartable', 'clean', 'Next steps', '重新启动', '干净'], 'Clean restart path documented')
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

function jsonFeatureList(text, message) {
  try {
    const parsed = JSON.parse(text);
    const valid = Array.isArray(parsed.features) && parsed.features.every((feature) =>
      typeof feature.id === 'string'
      && typeof feature.name === 'string'
      && typeof feature.description === 'string'
      && typeof feature.status === 'string'
    );
    return { pass: valid, message };
  } catch {
    return { pass: false, message };
  }
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

export async function loadHarnessFiles(root) {
  const candidates = [
    'AGENTS.md',
    'CLAUDE.md',
    'CONTEXT.md',
    'feature_list.json',
    'feature-list.json',
    'progress.md',
    '.scratch/handoff.md',
    'session-handoff.md',
    'docs/agents/domain.md',
    'docs/agents/issue-tracker.md',
    'init.sh'
  ];
  const files = [];
  for (const candidate of candidates) {
    const fullPath = path.join(root, candidate);
    if (await exists(fullPath)) {
      files.push({ path: candidate, content: await readText(fullPath) });
    }
  }
  // matt creates docs/adr/ lazily — it can exist while CONTEXT.md still does not — so an ADR
  // directory alone must still mark the repo as tracker. A directory is not readable as text,
  // so record a marker entry that only the tracker-mode probe consults.
  if (await exists(path.join(root, 'docs/adr'))) {
    files.push({ path: 'docs/adr/', content: '', kind: 'dir' });
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
      <p>Five-subsystem harness validation report.</p>
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
