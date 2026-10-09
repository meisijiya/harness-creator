#!/bin/bash
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

# Counts the checks that actually ran. A guarded step SKIPS with a notice when package.json does not
# define the script yet, so before this counter existed ./init.sh could skip every check, print
# "Verification Complete" and exit 0 having verified nothing — the gate cannot fail, and "no feature
# may be marked done without evidence" becomes structurally unreachable on exactly the fresh skeleton
# where it matters most. Emitted unconditionally, because the branch that reaches the success tail at
# exit 0 must be the one that earned it. Same contract as the manual fallback templates/init.sh,
# which is the other producer of this file and carried the counter while this one did not.
RAN=0

# What the evidence below is evidence OF. The gate answers "did the checks run?"; it cannot answer
# "which version did they run against?", so a record of green read today is indistinguishable from
# one written last week against code that has since changed. A commit anchor is what separates them
# without trusting the note. A repository with no commit has no anchor and no honest substitute —
# "HEAD" is the same string in every record — so the gate refuses here, BEFORE any check runs, and
# names the one command that supplies what is missing. Anchoring after the checks would defeat it:
# the commit could move while they ran, and the record would name a version nobody verified.
# `git rev-parse HEAD` alone succeeds in a directory that owns no repository: git walks UP until
# it finds one, so a project nested inside another repo silently anchors to its PARENT's commit —
# an evidence line naming a version whose code was never checked. `--show-prefix` is what tells the
# two apart: it is EMPTY exactly when the current directory is the repository root, and holds the
# path-to-root otherwise. A comparison against `pwd` cannot be used here — on Windows git prints
# `D:/repo` while bash prints `/d/repo`, so that guard would refuse every real repository.
if ! ANCHOR="$(git rev-parse --short HEAD 2>/dev/null)" || [ -n "$(git rev-parse --show-prefix 2>/dev/null)" ]; then
  echo ""
  echo "ERROR: this harness anchors its evidence to a commit, and this directory has none of its"
  echo "own — either it is not a git repository, or it sits inside one and would otherwise record"
  echo "that outer repository's commit as if it had verified this code."
  echo "Make this directory a repository root, then re-run ./init.sh:"
  echo "  git init && git add -A && git commit -m 'Initial commit'"
  echo "Without a commit of its own there is nothing for the evidence to be evidence of."
  exit 1
fi

echo "=== node scripts/run-benchmark.mjs --self-check-only ==="
node scripts/run-benchmark.mjs --self-check-only
RAN=1

echo "=== node --check scripts/create-harness.mjs ==="
node --check scripts/create-harness.mjs
RAN=1

# The auditor is the one shipped script the self-check never executes: run-benchmark.mjs reads its
# --help as text (to scan for external system names) instead of running it, so a syntax error there
# left every gate green while the audit command was unrunnable. Syntax is the cheapest possible
# check for that, and it is added rather than substituted: the two existing steps stay as they are.
echo "=== node --check scripts/validate-harness.mjs ==="
node --check scripts/validate-harness.mjs
RAN=1

# A relative link that stops resolving is the one staleness a prose document cannot report about
# itself: nothing fails when an anchor drifts, the document just quietly points nowhere. Added
# rather than folded into an existing step, because the self-check asserts this repository's own
# invariants and not the documents those invariants are argued in.
echo "=== node scripts/check-links.mjs ==="
node scripts/check-links.mjs
RAN=1

if [ "$RAN" -eq 0 ]; then
  echo ""
  echo "ERROR: nothing in this harness verified anything — every check was skipped."
  echo "This project does not define the scripts named above yet, so none of them ran."
  echo "Replace them in ./init.sh with commands this repository can really run."
  echo "Until then ./init.sh MUST fail: a gate that cannot fail is not a gate."
  exit 1
fi

echo "=== Verification Complete ==="
echo ""
echo "Evidence anchor: $ANCHOR (the commit these checks ran against)"
echo "Record it with the result, or the record cannot say what it verified."
echo ""
echo "Next steps:"
echo "1. Read AGENTS.md for the startup path, the invariants and where work is recorded"
echo "2. Work only on what the user has explicitly authorized in this session —"
echo "   no authorization, no advance, even when the next task looks obvious"
echo "3. Produce only that, staying inside its scope"
echo "4. Re-run this script before claiming done"
