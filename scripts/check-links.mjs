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

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TARGETS = ['SKILL.md', 'README.md', 'references'];

const USAGE = `Usage: node scripts/check-links.mjs [--dir DIR]... [--help]

Checks that every relative Markdown link points at a heading that exists.

  --dir DIR   A file or directory to scan. Repeatable. Relative paths resolve against
              ${ROOT}
              Defaults to: ${DEFAULT_TARGETS.join(', ')}

Exit 0 when every relative anchor resolves, 1 when one does not, 2 on usage errors.`;

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

for (const [file, text] of contents) {
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

if (problems.length) {
  console.error(`check-links: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`check-links: OK (${linkCount} links, ${anchorCount} relative anchors checked across ${files.length} files)`);