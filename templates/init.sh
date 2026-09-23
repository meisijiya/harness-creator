#!/bin/bash
set -e

# Verification gate. It must exit 0 before any ticket is claimed done.
#
# This file is the MANUAL fallback: create-harness.mjs generates init.sh itself from the detected
# stack (see scripts/lib/harness-utils.mjs), and this template is what you copy by hand when the
# runtime has no Node. It probes the stack at run time instead of being generated for one, so it
# deliberately stays stack-generic — its "Next steps" block names the delegated route (the
# instruction file, then the tracker), nothing else. It must never point at a state file: this skill
# creates none, and a fresh repo has no tracker files until setup has run.

echo "=== Harness Initialization ==="

explain_failure() {
  echo ""
  echo "=== Verification FAILED ==="
  echo "Either the baseline is broken, or this skeleton has no runnable check yet."
  echo "Fix the baseline first, then re-run ./init.sh."
  echo "Do NOT mark any ticket done until ./init.sh exits 0."
}
trap explain_failure ERR

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

  # Counts the checks that actually ran. A manifest that defines none of them is the same trap as no
  # manifest at all: without this counter the script would run only the install, print
  # "Verification Complete" and exit 0 having verified nothing — the gate cannot fail, so
  # "no ticket may be marked done without evidence" becomes unreachable on exactly the fresh
  # skeleton where it matters most. The branch below refuses until a real command replaces it.
  RAN=0

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

  if [ "$RAN" -eq 0 ]; then
    echo ""
    echo "ERROR: package.json defines no check, typecheck, lint, test or build script yet."
    echo "Replace this branch in ./init.sh with the project's real verification command."
    echo "Until then ./init.sh MUST fail: a gate that cannot fail is not a gate."
    exit 1
  fi
elif [ -f pyproject.toml ] || [ -f requirements.txt ]; then
  echo "=== Running Python verification ==="
  PY="$(command -v python3 || command -v python)"
  # pytest exits 5 when no tests are collected — not a failure for a fresh project.
  "$PY" -m pytest || [ $? -eq 5 ]
  # -x skips virtualenvs/build dirs so the syntax check doesn't compile dependencies.
  "$PY" -m compileall -q -x '(^|/)(\.?venv|env|node_modules|build|dist|__pycache__)(/|$)' .
elif [ -f go.mod ]; then
  echo "=== Running Go verification ==="
  go test ./...
elif [ -f Cargo.toml ]; then
  echo "=== Running Rust verification ==="
  cargo test
elif [ -f pom.xml ]; then
  echo "=== Running Maven verification ==="
  mvn test
elif [ -f build.gradle ] || [ -f build.gradle.kts ]; then
  echo "=== Running Gradle verification ==="
  ./gradlew test
elif ls *.csproj *.sln >/dev/null 2>&1; then
  echo "=== Running .NET verification ==="
  dotnet test
else
  echo "No recognized package manifest detected."
  echo "ERROR: this is an unreplaced placeholder — nothing is being verified."
  echo "Replace this section with the project's real verification commands."
  echo "Until then ./init.sh MUST fail: a gate that cannot fail is not a gate."
  exit 1
fi

echo "=== Verification Complete ==="
echo ""
echo "Next steps:"
echo "1. Configure the tracker once: /setup-matt-pocock-skills"
echo "2. Read AGENTS.md for the startup path, the invariants and where state lives"
echo "3. Pick ONE unfinished ticket whose blocking edges are clear"
echo "4. Implement only that ticket, staying inside its scope"
echo "5. Re-run this script before claiming done"
