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

# Counts the checks that actually verified something. It sits at the top of the script because the
# success tail is shared by every branch below and the refusal that reads RAN sits after every
# branch: the branch that reaches exit 0 has to be the one that earned it. RAN is raised only by a
# check that ran against real work — a manifest alone never raises it, and a check that ran but had
# nothing to check refuses with its own message instead, because "no tests exist yet" and "the tests
# failed" are different facts for whoever reads the log. Same invariant as the generated init.sh
# (scripts/lib/harness-utils.mjs), which is the other producer of this file.
RAN=0

# What the evidence below is evidence OF. A gate that prints "tests pass" tells the reader the
# checks ran; it does not tell them WHICH version they ran against, so a record of green written
# last week and read today is indistinguishable from one written against today's code. Anchoring to
# a commit is what makes that distinction mechanical instead of a matter of trusting the note.
#
# A repository with no commit has no anchor, and there is no honest substitute: "HEAD" and "now" are
# the same string in every record, which is precisely the thing this refuses. So it refuses here,
# before any check runs, and says which single command supplies what is missing.
#
# `git rev-parse HEAD` alone succeeds in a directory that owns no repository: git walks UP until it
# finds one, so a project nested inside another repo silently anchors to its PARENT's commit — an
# evidence line naming a version whose code was never checked. `--show-prefix` is what tells the
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

# The refusal every manifest branch below shares for one specific outcome: the check ran and had
# nothing to check. It lives here rather than inline in six places because the wording and the exit
# status are load-bearing together, and the exit status is what makes the gate a gate. $1 is the
# tool's own reason for finding nothing, quoted so the reader can tell which tool said it.
refuse_nothing_to_check() {
  echo ""
  echo "ERROR: nothing was verified — $1"
  echo "This check ran against the project and found no work to do, so the gate has nothing to hold"
  echo "the project to. Write the first test, or delete this step from ./init.sh."
  echo "Until then ./init.sh MUST fail: a gate that cannot fail is not a gate."
  exit 1
}

# And the refusal for the other outcome: the check ran, found work, and the work failed. A separate
# function so a red gate says which of the two happened — a project with no tests yet and a project
# whose tests fail need opposite fixes, and neither is the other one's message.
refuse_check_failed() {
  echo ""
  echo "ERROR: $1 exited $2 — the check ran and the project did not pass it."
  echo "Fix the project before calling anything done."
  echo "Until then ./init.sh MUST fail: a gate that cannot fail is not a gate."
  exit 1
}

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
  # -x skips virtualenvs/build dirs so the syntax check doesn't compile dependencies.
  "$PY" -m compileall -q -x '(^|/)(\.?venv|env|node_modules|build|dist|__pycache__)(/|$)' .
  # RAN is raised here on pytest's own exit code and nothing else. compileall above is a syntax
  # gate — it passes over a tree with no Python in it, so on its own it proves nothing about
  # this project. pytest's status is the verdict: 0 means it collected tests and they passed,
  # 5 means it ran and found nothing to run, anything else means the tests ran and failed.
  PYTEST_RC=0
  "$PY" -m pytest || PYTEST_RC=$?
  if [ "$PYTEST_RC" -eq 5 ]; then
    refuse_nothing_to_check "pytest collected no tests (exit 5)."
  elif [ "$PYTEST_RC" -ne 0 ]; then
    refuse_check_failed "pytest" "$PYTEST_RC"
  fi
  RAN=1
elif [ -f go.mod ]; then
  echo "=== Running Go verification ==="
  # `go test ./...` exits 0 for a package that has no test files at all, so its status on its
  # own cannot say whether anything ran. Two of go's own judgements between them can:
  # `-list` is the tool's inventory of the test functions it would run, and vet fails on a
  # broken package whether or not a test exists. RAN is raised only past both.
  GO_LIST_RC=0
  GO_LIST="$(go test -list '.*' ./... 2>&1)" || GO_LIST_RC=$?
  printf '%s\n' "$GO_LIST"
  if [ "$GO_LIST_RC" -ne 0 ]; then
    refuse_check_failed "go test -list" "$GO_LIST_RC"
  fi
  # Every test function go can run is named Test/Benchmark/Fuzz/Example, and -list prints one
  # bare identifier per line, so an empty result means there is no test here to run.
  if ! printf '%s\n' "$GO_LIST" | grep -qE '^(Test|Benchmark|Fuzz|Example)'; then
    refuse_nothing_to_check "go test -list found no test function."
  fi
  go vet ./...
  go test ./...
  RAN=1
elif [ -f Cargo.toml ]; then
  echo "=== Running Rust verification ==="
  # `cargo test` exits 0 after running zero tests, so libtest's own `--list` is the inventory
  # this branch asks first: it names every test the harness would run and prints nothing when
  # the crate has none. The `cargo test` that follows is what decides pass from fail, and RAN
  # is raised only once a test was found to run and it ran green.
  CARGO_LIST_RC=0
  CARGO_LIST="$(cargo test -- --list 2>&1)" || CARGO_LIST_RC=$?
  printf '%s\n' "$CARGO_LIST"
  if [ "$CARGO_LIST_RC" -ne 0 ]; then
    refuse_check_failed "cargo test -- --list" "$CARGO_LIST_RC"
  fi
  if ! printf '%s\n' "$CARGO_LIST" | grep -qE ':[[:space:]]*test$'; then
    refuse_nothing_to_check "cargo test -- --list found no test."
  fi
  cargo test
  RAN=1
elif [ -f pom.xml ]; then
  echo "=== Running Maven verification ==="
  # Maven's own answer to "did anything run": surefire prints a `Tests run:` summary line for
  # every test class it executed, and prints no such line — only "No tests to run" — when the
  # build had none. A build that reaches BUILD SUCCESS having printed neither verified nothing.
  MVN_RC=0
  MVN_OUT="$(mvn test 2>&1)" || MVN_RC=$?
  printf '%s\n' "$MVN_OUT"
  if [ "$MVN_RC" -ne 0 ]; then
    refuse_check_failed "mvn test" "$MVN_RC"
  fi
  if ! printf '%s\n' "$MVN_OUT" | grep -q 'Tests run:'; then
    refuse_nothing_to_check "mvn test executed no test (no surefire 'Tests run:' summary)."
  fi
  RAN=1
elif [ -f build.gradle ] || [ -f build.gradle.kts ]; then
  echo "=== Running Gradle verification ==="
  # Gradle states outright which of its tasks had nothing to run: it marks such a task
  # NO-SOURCE and still reports BUILD SUCCESSFUL. `test` depends on compiling both main and
  # test sources, so NO-SOURCE here means the task verified nothing at all.
  GRADLE_RC=0
  GRADLE_OUT="$(./gradlew test 2>&1)" || GRADLE_RC=$?
  printf '%s\n' "$GRADLE_OUT"
  if [ "$GRADLE_RC" -ne 0 ]; then
    refuse_check_failed "./gradlew test" "$GRADLE_RC"
  fi
  if printf '%s\n' "$GRADLE_OUT" | grep -qE 'Task :test NO-SOURCE'; then
    refuse_nothing_to_check "the Gradle test task was NO-SOURCE."
  fi
  RAN=1
elif ls *.csproj >/dev/null 2>&1 || ls *.sln >/dev/null 2>&1; then
  echo "=== Running .NET verification ==="
  # `dotnet test` is the only .NET-side check here, and it says in its own output when it
  # discovered nothing — "No test is available" is the test platform reporting an empty
  # discovery, which is a different fact from a discovered test failing. Split the two before
  # reading the exit status, so the empty project is not reported as a failing one.
  DOTNET_RC=0
  DOTNET_OUT="$(dotnet test 2>&1)" || DOTNET_RC=$?
  printf '%s\n' "$DOTNET_OUT"
  if printf '%s\n' "$DOTNET_OUT" | grep -qi 'no test is available'; then
    refuse_nothing_to_check "dotnet test discovered no test."
  fi
  if [ "$DOTNET_RC" -ne 0 ]; then
    refuse_check_failed "dotnet test" "$DOTNET_RC"
  fi
  RAN=1
else
  echo "No recognized package manifest detected."
  echo "ERROR: this is an unreplaced placeholder — nothing is being verified."
  echo "Replace this section with the project's real verification commands."
  echo "Until then ./init.sh MUST fail: a gate that cannot fail is not a gate."
  exit 1
fi

# The one verdict, after every branch rather than inside one of them, because the success tail below
# is shared by all seven: a branch that reaches exit 0 must be the one that earned it, and RAN is
# the only record of that. Every branch above therefore raises RAN through a check that ran against
# real work and either had nothing to check — in which case it has already refused with that reason
# named — or ran and was green.
#
# Reaching this point with RAN still 0 means every candidate the file probed for failed to resolve:
# package.json defines no check, typecheck, lint, test or build script, and no other project
# manifest was recognized. A candidate this file probed for and did not resolve is not counted
# against the project: it was never declared here, which is the same line the generator draws when
# it writes only the scripts the manifest defines.
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
echo "Evidence anchor: $ANCHOR (the commit these checks ran against)"
echo "Record it with the result, or the record cannot say what it verified."
echo ""
echo "Next steps:"
echo "1. Read AGENTS.md for the startup path, the invariants and where work is recorded"
echo "2. Work only on what the user has explicitly authorized in this session —"
echo "   no authorization, no advance, even when the next task looks obvious"
echo "3. Produce only that, staying inside its scope"
echo "4. Re-run this script before claiming done"
