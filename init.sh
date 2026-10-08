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

echo "=== node scripts/run-benchmark.mjs --self-check-only ==="
node scripts/run-benchmark.mjs --self-check-only
RAN=1

echo "=== node --check scripts/create-harness.mjs ==="
node --check scripts/create-harness.mjs
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
echo "Next steps:"
echo "1. Read AGENTS.md for the startup path, the invariants and where work is recorded"
echo "2. Pick ONE unfinished piece of work whose prerequisites are clear"
echo "3. Produce only that, staying inside its scope"
echo "4. Re-run this script before claiming done"
