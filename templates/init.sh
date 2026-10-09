#!/bin/bash
set -e

# Verification gate. It must exit 0 before any work is claimed done.
#
# This file is the MANUAL fallback: create-harness.mjs generates init.sh itself from the detected
# stack (see scripts/lib/harness-utils.mjs), and this template is what you copy by hand when the
# runtime has no Node. It probes the stack at run time instead of being generated for one, so it
# deliberately stays stack-generic — its "Next steps" block names only the artifacts this skill
# writes, and nothing else. It must never point at a file this skill does not create.

echo "=== Harness Initialization ==="

explain_failure() {
  echo ""
  echo "=== Verification FAILED ==="
  echo "Either the baseline is broken, or this skeleton has no runnable check yet."
  echo "Fix the baseline first, then re-run ./init.sh."
  echo "Do NOT call anything done until ./init.sh exits 0."
}
trap explain_failure ERR

# Counts the checks that actually ran, and it lives at the top of the script because the success tail
# is shared by every branch below. Counting inside the package.json branch alone left the Python, Go,
# Rust, Maven, Gradle and .NET branches reaching "Verification Complete" without ever touching it —
# `pytest` collecting nothing and `compileall` walking an empty tree both exit 0, so the tail printed
# a pass for a directory where no check had anything to check. Same invariant as the generated
# init.sh (scripts/lib/harness-utils.mjs), which is the other producer of this file: the branch that
# reaches exit 0 must be the one that earned it.
RAN=0

if [ -f package.json ]; then
  if [ -f pnpm-lock.yaml ]; then
    PM="pnpm"
  elif [ -f yarn.lock ]; then
    PM="yarn"
  elif [ -f bun.lock ] || [ -f bun.lockb ]; then
    PM="bun"
  else
    PM="npm"
  fi

  if [ -d node_modules ]; then
    echo "SKIP: dependency install (node_modules already present)"
  else
    echo "=== Installing dependencies with $PM ==="
    if [ "$PM" = "npm" ]; then
      npm install
    else
      "$PM" install
    fi
  fi

  # Candidates this file probes for. Each is resolved against the manifest at run time, so a
  # candidate the project does not define was never a declared check for THIS project — that is
  # discovery, not a skip, and the verdict below must not punish a project for not having a build
  # script. RAN is initialised at the top of the script rather than here, because the refusal that
  # reads it sits after every branch; a second RAN=0 here would also give --add-check two opening
  # anchors to find, and it refuses anything but exactly one. The generated init.sh
  # (scripts/lib/harness-utils.mjs) reaches the same rule from the other side: it resolves the same
  # candidate list at generation time and writes only the ones that exist, so a step it writes is a
  # step it will run — a --commands entry it cannot resolve is refused by name instead of skipped.

  node -e "const s=require('./package.json').scripts||{}; process.exit(s.check||s.typecheck||s['type-check']?0:1)" && {
    if node -e "const s=require('./package.json').scripts||{}; process.exit(s.check?0:1)"; then
      [ "$PM" = "npm" ] && npm run check || "$PM" run check
    elif node -e "const s=require('./package.json').scripts||{}; process.exit(s.typecheck?0:1)"; then
      [ "$PM" = "npm" ] && npm run typecheck || "$PM" run typecheck
    else
      [ "$PM" = "npm" ] && npm run type-check || "$PM" run type-check
    fi
    RAN=1
  }

  node -e "const s=require('./package.json').scripts||{}; process.exit(s.lint?0:1)" && {
    [ "$PM" = "npm" ] && npm run lint || "$PM" run lint
    RAN=1
  }

  node -e "const s=require('./package.json').scripts||{}; process.exit(s.test?0:1)" && {
    [ "$PM" = "npm" ] && npm test || "$PM" test
    RAN=1
  }

  node -e "const s=require('./package.json').scripts||{}; process.exit(s.build?0:1)" && {
    [ "$PM" = "npm" ] && npm run build || "$PM" run build
    RAN=1
  }
elif [ -f pyproject.toml ] || [ -f requirements.txt ]; then
  echo "=== Running Python verification ==="
  PY="$(command -v python3 || command -v python)"
  # pytest exits 5 when no tests are collected — not a failure for a fresh project.
  "$PY" -m pytest || [ $? -eq 5 ]
  # -x skips virtualenvs/build dirs so the syntax check doesn't compile dependencies.
  "$PY" -m compileall -q -x '(^|/)(\.?venv|env|node_modules|build|dist|__pycache__)(/|$)' .
  RAN=1
elif [ -f go.mod ]; then
  echo "=== Running Go verification ==="
  go test ./...
  RAN=1
elif [ -f Cargo.toml ]; then
  echo "=== Running Rust verification ==="
  cargo test
  RAN=1
elif [ -f pom.xml ]; then
  echo "=== Running Maven verification ==="
  mvn test
  RAN=1
elif [ -f build.gradle ] || [ -f build.gradle.kts ]; then
  echo "=== Running Gradle verification ==="
  ./gradlew test
  RAN=1
elif ls *.csproj *.sln >/dev/null 2>&1; then
  echo "=== Running .NET verification ==="
  dotnet test
  RAN=1
else
  echo "No recognized package manifest detected."
  echo "ERROR: this is an unreplaced placeholder — nothing is being verified."
  echo "Replace this section with the project's real verification commands."
  echo "Until then ./init.sh MUST fail: a gate that cannot fail is not a gate."
  exit 1
fi

# The one verdict, after every branch rather than inside one of them. Placed here because the tail
# below is shared: a check that only the package.json branch could leave unset would let the Go,
# Rust, Maven, Gradle, .NET and Python branches print "Verification Complete" for a run in which no
# counter was ever touched — a pass nobody earned, from a branch that looked like it had run tests.
# A candidate this file probed for and did not resolve is not counted against the project: it was
# never declared here, which is the same line the generator draws when it writes only the scripts
# the manifest defines.
if [ "$RAN" -eq 0 ]; then
  echo ""
  echo "ERROR: nothing in this harness verified anything — no check ran."
  echo "No manifest resolved to a runnable check: package.json defines no check, typecheck, lint,"
  echo "test or build script, and no other project manifest was recognized."
  echo "Replace the section above in ./init.sh with the project's real verification command."
  echo "Until then ./init.sh MUST fail: a gate that cannot fail is not a gate."
  exit 1
fi

echo "=== Verification Complete ==="
echo ""
echo "Next steps:"
echo "1. Read AGENTS.md for the startup path, the invariants and where work is recorded"
echo "2. Work only on what the user has explicitly authorized in this session —"
echo "   no authorization, no advance, even when the next task looks obvious"
echo "3. Produce only that, staying inside its scope"
echo "4. Re-run this script before claiming done"
