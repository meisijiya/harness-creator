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

export function initScriptFromCommands(commands) {
  const body = commands.map(renderVerificationStep).join('\n\n');
  // The next-steps block names state, so it names exactly the artifacts this skill writes and
  // nothing else. A startup script that tells the agent to read a file this skill never creates is
  // a dangling instruction, and the artifact list stays clean because the leak sits in the
  // contents of a file that IS expected to exist.
  //
  // State no longer appears here because it no longer lives here: it is delegated, and the route
  // to it is the instruction file, which exists before the tracker is configured. Naming the
  // tracker's own files instead would be exactly the dangling pointer this block is built to
  // avoid — a fresh repo has none of them until setup has run.
  const nextSteps = [
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

${body}

echo "=== Verification Complete ==="
echo ""
echo "Next steps:"
${nextSteps.map((line) => `echo "${line}"`).join('\n')}
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
  const init = byPath.get('init.sh') || '';

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
      structuredHas(agents, ['to-tickets', 'handoff', 'setup-matt-pocock-skills', '承接方', 'delegat'], 'Delegated state and handoff owners named')
    ],
    verification: [
      hasFile(byPath, ['init.sh'], 'Verification entrypoint exists'),
      textHas(init, ['set -e'], 'Verification fails fast'),
      textHas(init + agents, ['test', 'pytest', 'vitest', 'cargo test', 'go test', 'dotnet test', '测试'], 'Test command documented'),
      textHas(init + agents, ['build', 'type', 'lint', 'compile', '类型', '构建'], 'Static/build check documented'),
      textHas(allText, ['Evidence', 'Verification Evidence', 'command and output', '证据', 'CI'], 'Verification evidence is recorded')
    ],
    scope: [
      structuredHas(agents, ['One feature at a time', 'one-feature-at-a-time', 'one requirement at a time', 'one ticket at a time', '一次一个功能', '一次一个需求', '一次一个工单'], 'One-ticket-at-a-time rule exists'),
      textHas(agents, ['dependencies', 'blocking', '阻塞边', '依赖'], 'Blocking edges are stated'),
      textHas(agents, ['status', '状态'], 'Ticket status is explicit'),
      structuredHas(agents, ['Stay in scope', 'scope', '保持在本工单范围内', '保持在范围内', '范围'], 'Scope boundary documented'),
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
