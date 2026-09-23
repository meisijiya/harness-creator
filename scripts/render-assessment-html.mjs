#!/usr/bin/env node
import path from 'node:path';
import {
  htmlReport,
  loadHarnessFiles,
  parseArgs,
  scoreHarness,
  scriptCommand,
  writeText
} from './lib/harness-utils.mjs';

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(`Usage: ${scriptCommand('render-assessment-html.mjs')} [--target DIR] [--output FILE|--html FILE]

Renders the three-subsystem harness assessment as a standalone HTML file. State and lifecycle are
delegated to the engineering skills, so they are scored nowhere: the instruction file states who
owns them, and that statement is checked under "instructions".`);
  process.exit(0);
}

const target = path.resolve(args.target || args._[0] || process.cwd());
// `--html` is the flag the sibling benchmark script takes and the flag SKILL.md's task table names,
// so it is accepted here as an alias. Without it an unknown flag is stored by parseArgs and never
// read: the run prints a success line, exits 0, and writes to the default path instead — the silent
// degradation this skill forbids in a target repo. The grader asserts the alias against this file.
const output = path.resolve(args.output || args.html || path.join(target, 'harness-assessment.html'));
const result = scoreHarness(await loadHarnessFiles(target));

await writeText(output, htmlReport(result, `Harness Assessment: ${path.basename(target)}`));
console.log(`HTML report written to ${output}`);
console.log(`Overall: ${result.overall}/100`);
