#!/usr/bin/env node
// Link and anchor checker for this repository's Markdown.
//
// It answers exactly one question: does every relative link in these documents still point at a
// heading that exists. It does NOT check whether a URL is reachable over the network, because that
// is not a fact this repository can decide — a timeout behind a corporate proxy and a genuinely
// deleted page look identical from here, and failing the gate on either would train people to
// ignore it. So the network is deliberately absent: a finding here means a document points at
// something this repository can see is gone.
//
// Exit 0 when every relative anchor resolves, 1 when any does not, 2 on usage or environment
// errors. Zero dependencies, like every other script in this repository.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TARGETS = ['SKILL.md', 'README.md', 'references'];

const USAGE = `Usage: node scripts/check-links.mjs [--dir DIR]... [--help]

Checks that every relative Markdown link points at a heading that exists, and that the
backtick-quoted pointers these documents route with still resolve:

  - a scoped path (references/gotchas.md, templates/init.sh) must exist in this repository
  - a bare filename must be a file this repository ships, resolved from the root, scripts/ or
    references/ — names that exist only under templates/ are artefacts written into a TARGET repo
  - every reference must be named by the routing document, and every routing entry must have a file
    behind it, so deleting or renaming a reference fails even though the document still names it

  --dir DIR   A file or directory to scan. Repeatable. Relative paths resolve against
              ${ROOT}
              Defaults to: ${DEFAULT_TARGETS.join(', ')}

Exit 0 when every relative anchor and pointer resolves, 1 when one does not, 2 on usage errors.`;

// GitHub's heading slug: lowercase, drop punctuation, spaces to hyphens, and disambiguate
// repeats by appending -1, -2, ... in document order. This is the same rule the reference
// excerpts in this repository's upstream sources follow, so an anchor copied from there keeps
// resolving after a heading is renamed.
export function slugify(heading) {
  return heading
    .trim()
    .replace(/`/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}

export function headingSlugs(markdown) {
  const seen = new Map();
  const slugs = new Set();
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^(#{1,6})\s+\S(.*)$/.exec(line);
    if (!match) continue;
    const base = slugify(match[2]);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    slugs.add(count === 0 ? base : `${base}-${count}`);
  }
  return slugs;
}

// Every Markdown link destination in the document. Inline images are links too, and a broken
// image path is the same defect as a broken prose link.
export function linkTargets(markdown) {
  const targets = [];
  const pattern = /!?\[[^\]]*\]\(\s*<?([^)\s]+)>?(?:\s+"[^"]*")?\s*\)/g;
  for (const match of markdown.matchAll(pattern)) targets.push(match[1]);
  return targets;
}

// Repository-internal pointers written as backtick-quoted paths — the form this repository
// actually routes in. SKILL.md points at its nine references that way and carries no Markdown link
// at all, so the check above sees nothing there: delete a reference and the anchor check stays
// green while every reader of that document walks to a file that no longer exists. Copying prose
// into a document has the opposite property — a stale copy is visible in the same diff as the code
// it described — so pointer-shaped references trade one kind of rot for another unless something
// checks them.
//
// Two shapes, because the documents use two shapes. A scoped path (`references/gotchas.md`,
// `templates/init.sh`) resolves against the repository root and is checked directly. A BARE filename
// (`harness-maintenance-pattern.md`) is what SKILL.md's routing list actually ships, and it cannot be
// checked the same way — resolving it by asking the repository "do you have a file with this name"
// is self-referential on exactly the deletion this check exists to catch. Measured, not reasoned
// about: with the index keyed on disk contents, deleting references/gotchas.md and moving
// scripts/create-harness.mjs both left `check-links: OK`. The bare form is therefore admitted by the
// index and judged on existence at the call site, and the arms below ask the mirror question in both
// directions — a reference nothing points at, and a named entry with no file behind it.
const POINTER_SCOPE = ['references/', 'scripts/', 'templates/', 'agents/'];

// The document that routes the reference set. Everything under references/ must be named here.
const ROUTING_DOC = 'SKILL.md';
const ROUTED_DIR = 'references';
const ROUTING_DOC_DIR = ROOT;

// The directories this repository works in, as opposed to the ones it renders into someone else. A
// bare name resolving here is a pointer; one that resolves only under templates/ is a produced
// artefact. A literal rather than a derived list, because the distinction is a decision about what
// this repository IS, not a fact about its current contents.
const RUNTIME_DIRS = ['.', 'scripts', ROUTED_DIR];

// Every filename this repository ships, by bare name. Read from the git index rather than from
// disk for the reason given on pointerTargets: a file that has been removed or renamed is still a
// name the documents may point at, and a disk walk cannot see that, so a pointer arm keyed on the
// disk would go blind on the exact edit it is meant to catch. Falls back to a disk walk when git is
// unavailable, which is correct rather than clever — it is weaker, and the routing arms below do not
// depend on it.
function shippedFileIndex() {
  const index = new Set();
  let tracked = '';
  try {
    tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    tracked = '';
  }
  if (tracked) {
    for (const line of tracked.split('\n')) {
      if (line) index.add(line.split('/').join(path.sep));
    }
    return index;
  }
  const skip = new Set(['node_modules', 'evals', '.workbuddy', '.scratch', '.git']);
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(entry.name) || entry.name.startsWith('.')) continue;
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else index.add(entry.name);
    }
  };
  walk(ROOT);
  return index;
}

// A token is a pointer when it is a scoped path under a directory this repository ships, or a bare
// filename this repository is known to ship. Directory-only tokens (`references/`) are excluded:
// they name a container, and demanding a container resolve as a file is a false alarm rather than a
// finding.
//
// The leading `<技能目录>/` is stripped rather than matched. SKILL.md says outright that the skill
// directory must not be used as a relative path, and every script it routes to is written that way
// (`<技能目录>/scripts/check-links.mjs`); stripping the placeholder resolves each one against this
// repository, which is the only place the file exists. Matching on the raw token instead left every
// script pointer unexamined while the gate reported OK — measured, not assumed.
export function pointerTargets(markdown, shipped) {
  const targets = [];
  for (const match of markdown.matchAll(/`([^`\n]+)`/g)) {
    const token = match[1].trim().replace(/^<[^>]+>\//, '');
    if (!/^[A-Za-z0-9_.-]+\.[a-z]+(?:[#?].*)?$/.test(token)) continue;
    if (POINTER_SCOPE.some((prefix) => token.startsWith(prefix))) targets.push(token);
    // A bare name is admitted when this repository HAS it at a path a reader would walk to — the
    // root, a runtime directory — or when the git index still remembers it somewhere else. Neither
    // test alone works. Disk alone is blind to a MOVED file: the moved script stops being a pointer,
    // the reported count falls from 101 to 99, and the gate stays green instead of failing (measured,
    // twice). The index alone is not enough either, because it remembers the templates of documents
    // this skill writes into a TARGET repo — `templates/spec-layer/mission.md` — and admitting on it
    // made every mention of the mission document a pointer to a file that is not there (measured: 13
    // false alarms on a clean tree). So the index admits a name the runtime directories do not hold,
    // and the caller then asks the only question that matters: does the file still EXIST?
    else if (RUNTIME_DIRS.some((dir) => existsSync(path.join(ROOT, dir, token)))
      || (shippedHas(shipped, token) && !producedOnly(token, shipped))) {
      targets.push(token);
    }
  }
  return targets;
}

// The index holds repository-relative paths; a document names files by bare name, so membership is
// asked by basename. Callers pair this with an existence check: the index answers "is this a name
// this repository uses", never "is the file still there".
function shippedHas(shipped, token) {
  for (const candidate of shipped) if (path.basename(candidate) === token) return true;
  return false;
}

// A tracked name that lives under templates/ is a document this skill renders into a TARGET repo —
// `mission.md`, `tech-stack.md` — so it is not a pointer to anything here. Read from the index's
// full paths, so nothing has to know how deep templates/ nests, and deliberately narrow: a file that
// has merely MOVED must not match, or admitting on it would suppress the report it exists to cause.
// The runtime check runs FIRST because it is the stronger statement — a name the repository holds at
// a path a reader walks to is a pointer whatever else it is tracked as — and it also bounds this to
// the first matching entry, so a name tracked in both places is judged by the runtime directory.
function producedOnly(token, shipped) {
  for (const candidate of shipped) {
    if (path.basename(candidate) !== token) continue;
    if (RUNTIME_DIRS.some((dir) => existsSync(path.join(ROOT, dir, token)))) return false;
    return candidate.split(path.sep).join('/').startsWith('templates/');
  }
  return false;
}
// The reverse question: of the files this repository routes, which does the routing document not
// name AS A ROUTING ENTRY? A file that nothing points at is a reference the reader cannot reach.
//
// Scoped to the entries, not to every mention: this used to collect every backtick token in the
// document, which made a reference named only in passing prose look routed. Deleting the actual
// routing bullet then left the gate green (measured), and the count printed beside it — 8 entries
// over 9 files — was the only thing that showed it, with nothing asserting the two agree. Reusing
// danglingRoutingEntries is what makes the two arms one question asked twice.
export function unroutedFiles(markdown, routed = []) {
  const named = new Set(danglingRoutingEntries(markdown).map((entry) => path.basename(entry)));
  return routed.filter((file) => !named.has(file));
}

// The other direction, and the one the reverse check cannot reach: a routing entry whose file is
// gone. The two are one defect — the document and the repository disagree about the reference set —
// but only this one fires when a file is DELETED, because a deleted file also disappears from the
// index the reverse check compares against. Measured: dropping references/gotchas.md left the gate
// green while SKILL.md still told the reader to open it.
//
// The entry is identified by SHAPE, not by a list of names: a bullet of the routing section reads
// "- cross-session memory: `memory-persistence-pattern.md`". That shape is what distinguishes a
// routed source from a name this skill writes into a target repo — `harness-creator-verification.md`
// and `docs/agents/` appear in the same section as inline code but never as a routing bullet, which
// is why this raises nothing for them and needs no allowlist to stay quiet.
//
// The shape is "a bullet whose ONLY backtick span is a filename", not "a bullet ending in one". The
// stricter reading was blind to four rewordings that a real edit makes — a bullet with trailing
// prose, two names in one bullet, an asterisk bullet, a dash instead of a colon — and blindness there
// is silent in the worst way: zero entries is a legitimate result for an empty routing section, so
// de-shaping the list turned the check off without a word. Requiring the filename to be the bullet's
// only code keeps the discriminator while surviving the rewording; the count is compared against
// the references on disk at the call site, so a section that stops parsing is now a finding rather
// than a smaller number.
export function danglingRoutingEntries(markdown) {
  const entries = [];
  for (const line of markdown.split(/\r?\n/)) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (!bullet) continue;
    const codes = [...bullet[1].matchAll(/`([^`\n]+)`/g)].map((match) => match[1].trim());
    // Markdown and scripts only. `package.json`, `go.mod` and `Cargo.toml` are quoted all over the
    // option and detection prose, and a repository legitimately has none of them — widening the
    // pattern to every filename made each of those a routing entry, so the gate went red on the
    // documents that were already correct.
    if (codes.length === 1 && /^[A-Za-z0-9_.-]+\.(md|mjs)$/.test(codes[0])) entries.push(codes[0]);
  }
  return entries;
}

// Locate a bare filename among the directories this repository works in, or null when no shipped
// file has that name. When the git index remembers a name the disk no longer has, the path it used
// to have is returned so the caller can name a real location — the caller decides whether the file
// still EXISTS, because that is the question being asked, and folding the two together is what
// disarmed the dangling-entry arm once already (measured: deleting references/gotchas.md stayed
// green while the entry still named it).
function findShipped(name, shipped, fromDir) {
  for (const dir of [fromDir, path.join(ROOT, 'scripts'), path.join(ROOT, ROUTED_DIR)]) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return shippedHas(shipped, name) ? path.join(ROOT, name) : null;
}

function isExternal(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//');
}

function listMarkdownFiles(target) {
  const stats = statSync(target);
  if (stats.isFile()) return [target];
  const found = [];
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) found.push(...listMarkdownFiles(child));
    else if (entry.name.endsWith('.md')) found.push(child);
  }
  return found;
}

function parseArgs(argv) {
  const args = { dirs: [], help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--help' || token === '-h') args.help = true;
    else if (token === '--dir') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--dir needs a value');
      args.dirs.push(value);
      i += 1;
    } else throw new Error(`unknown argument: ${token}`);
  }
  return args;
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`check-links: ${error.message}`);
  console.error(USAGE);
  process.exit(2);
}

if (args.help) {
  console.log(USAGE);
  process.exit(0);
}

const targets = (args.dirs.length ? args.dirs : DEFAULT_TARGETS).map((entry) => path.resolve(ROOT, entry));

let files;
try {
  files = targets.flatMap((entry) => listMarkdownFiles(entry));
} catch (error) {
  console.error(`check-links: cannot scan: ${error.message}`);
  process.exit(2);
}

if (files.length === 0) {
  console.error('check-links: nothing to scan (no Markdown files found)');
  process.exit(2);
}

// Anchor checking is a cross-file fact, so every file's heading set is collected before any link
// is judged. A one-pass design would report a link to a file it has not read yet as "no such
// file", which is the shape of a false green.
const contents = new Map();
for (const file of files) contents.set(file, readFileSync(file, 'utf8'));

const problems = [];
let linkCount = 0;
let anchorCount = 0;
let pointerCount = 0;

const shippedFiles = shippedFileIndex();

for (const [file, text] of contents) {
  // Pointer-shaped references resolve against the repository, not against the set of Markdown files
  // the link loop happens to have collected: DEFAULT_TARGETS scans Markdown only, so a pointer into
  // scripts/ would fail for being un-scannable rather than for being missing.
  for (const token of pointerTargets(text, shippedFiles)) {
    pointerCount += 1;
    const [filePart, anchorPart] = token.split('#');
    // A bare name has no directory to resolve against. It is located through the index, and when
    // even the index has no entry for it the name points at something this repository never shipped —
    // which is a finding, not a skip: `references/gotchas.md` resolves from references/, and a
    // bare `gone.md` cannot resolve from anywhere.
    const resolved = filePart.includes('/')
      ? path.resolve(ROOT, decodeURIComponent(filePart))
      : findShipped(filePart, shippedFiles, path.dirname(file));
    if (!resolved) {
      problems.push(`${path.relative(ROOT, file)}: repository pointer does not resolve: ${token}`);
      continue;
    }
    if (!existsSync(resolved)) {
      problems.push(`${path.relative(ROOT, file)}: repository pointer does not resolve: ${token}`);
      continue;
    }
    if (!anchorPart) continue;
    const anchor = decodeURIComponent(anchorPart).toLowerCase();
    if (!headingSlugs(readFileSync(resolved, 'utf8')).has(anchor)) {
      problems.push(`${path.relative(ROOT, file)}: anchor #${anchor} does not exist in ${path.relative(ROOT, resolved)}`);
    }
  }

  for (const target of linkTargets(text)) {
    linkCount += 1;
    if (isExternal(target) || target.startsWith('#')) {
      // A bare #anchor inside the same document is checkable against that document's own slugs.
      if (!target.startsWith('#')) continue;
      anchorCount += 1;
      const anchor = decodeURIComponent(target.slice(1)).toLowerCase();
      if (anchor && !headingSlugs(text).has(anchor)) {
        problems.push(`${path.relative(ROOT, file)}: anchor #${anchor} does not exist in this file`);
      }
      continue;
    }

    const [filePart, anchorPart] = target.split('#');
    const resolved = path.resolve(path.dirname(file), decodeURIComponent(filePart));
    anchorCount += 1;
    if (!contents.has(resolved)) {
      problems.push(`${path.relative(ROOT, file)}: link target not found in this repository: ${target}`);
      continue;
    }
    if (!anchorPart) continue;
    const anchor = decodeURIComponent(anchorPart).toLowerCase();
    if (!headingSlugs(contents.get(resolved)).has(anchor)) {
      problems.push(`${path.relative(ROOT, file)}: anchor #${anchor} does not exist in ${path.relative(ROOT, resolved)}`);
    }
  }
}

const routingDoc = path.join(ROOT, ROUTING_DOC);
// Declared outside the branch because the success line reports it: `0 routed files` is the number
// that says this arm never ran, and a shadowing `const` inside the branch would have printed a
// permanent 0 next to a PASS — the same blindness this check was added to end.
let routed = [];
let entries = 0;
if (existsSync(routingDoc)) {
  routed = readdirSync(path.join(ROOT, ROUTED_DIR))
    .filter((name) => name.endsWith('.md'))
    .sort();
  const routingText = readFileSync(routingDoc, 'utf8');
  for (const orphan of unroutedFiles(routingText, routed)) {
    problems.push(`${ROUTING_DOC}: ${ROUTED_DIR}/${orphan} is not pointed at by the routing document`);
  }
  const named = danglingRoutingEntries(routingText);
  entries = named.length;
  for (const entry of named) {
    if (!/^[A-Za-z0-9_.-]+\.(md|mjs)$/.test(entry)) continue;
    // Resolved where every other pointer resolves, then judged on EXISTENCE: a name the index still
    // remembers but the disk no longer has is exactly the dangling case, so the index cannot be
    // allowed to answer "found" here. Resolving under references/ only, as this did before, made the
    // non-reference arm unreachable — a routing entry for a script was reported missing under
    // references/, so every such entry was a false positive (measured on a seeded entry, since no
    // shipped routing entry names a script today).
    const resolved = findShipped(entry, shippedFiles, ROUTING_DOC_DIR);
    if (!resolved || !existsSync(resolved)) {
      problems.push(`${ROUTING_DOC}: routing entry \`${entry}\` names no file in this repository`);
    }
  }
}

if (problems.length) {
  console.error(`check-links: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

// The pointer count is reported next to the link count on purpose. "0 pointers checked" against a
// document that routes its references in backticks is the number that reveals this script is blind
// there, and it would otherwise sit invisibly in a passing run.
console.log(`check-links: OK (${linkCount} links, ${pointerCount} repository pointers, ${entries} routing entries over ${routed.length} routed files, ${anchorCount} relative anchors checked across ${files.length} files)`);