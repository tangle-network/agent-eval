#!/usr/bin/env bash
# Certifies that a terminal-bench-2 task can still separate a solved state from an
# unsolved one, by running the harbor grading loop by hand against the published image.
#
# Replay work is only meaningful against a task whose oracle works. 33 of 89 reference
# solutions fetch from the network at solve time, so a task certified last month can
# fail to solve today: certification is a decaying asset and this runs before a campaign,
# not once.
#
# Mirrors harbor's phase order. The agent phase runs with NO /tests present; the verifier
# uploads tests/ to /tests only after the agent phase completes
# (harbor/verifier/verifier.py, harbor/trial/single_step.py). Reproducing that order is
# what makes the ungameability claim testable: a solution cannot pass by writing to
# /tests, because the verifier's upload overwrites that path at grade time.
#
#   Phase A: pristine image     -> inject tests -> expect reward 0 (tests FAIL)
#   Phase B: reference solution -> inject tests -> expect reward 1 (tests PASS)
#   Phase C: both containers    -> re-grade N times, idle and under CPU contention
#
# Phases A and B ask whether the suite can separate two states. Phase C asks whether it
# answers about the state at all: it re-grades containers nobody wrote to between runs, so
# every replicate reads byte-identical bytes. A suite that asserts on wall clock returns
# different verdicts there, and a task whose verdict is a coin flip cannot be ground truth
# for a repair -- a control arm "rescues" a row nothing touched, and an intervention arm
# loses a repair it made.
#
# Contention is part of the phase because unanimity on an idle box proves nothing about a
# timing assertion sitting far from its threshold. Replicates on one state pool across both
# loads, so a verdict that moves when the machine gets busy reads as the flip it is.
#
# A task is certified only when phase A fails, phase B passes, and phase C measures a flip
# rate of zero. Phase A passing means a broken oracle: the tests do not detect the unsolved
# state and the task scores nothing.
#
# Deliberately NOT `set -e`. Failing tests are the expected result of phase A, and every
# command that may legitimately exit nonzero is checked explicitly.
set -uo pipefail

usage() {
  cat <<'USAGE'
usage: certify-task-oracle.sh [options] TASK [TASK...]

  --tb2 DIR              terminal-bench-2 clone       (default: $TB2_DIR or ~/bench-cache/terminal-bench-2)
  --out DIR              per-task evidence root       (default: $TB_OUT_DIR or ~/bench-cache/bringup-results)
  --image-tag TAG        published image tag          (default: $TB_IMAGE_TAG or 20251031)
  --image-repo REPO      published image repo prefix  (default: $TB_IMAGE_REPO or alexgshaw)
  --pull                 pull the published image when absent
  --determinism N        idle re-grades per state     (default: 3; 0 skips phase C)
  --determinism-load M   contended re-grades per state (default: 2)
  --self-test            check the verdict rules against a fixed table and exit

Phase C re-grades byte-identical containers. Skipping it (--determinism 0) can only
produce CERTIFIED_UNCHECKED_DETERMINISM, never CERTIFIED: a task whose grader has not been
shown to answer about the state is not certified, it is unexamined.

Pin the clone. Task definitions move under unchanged names, so an unpinned clone
regrades against different tests without saying so.

Never rebuild the image from environment/Dockerfile for replay work. Those Dockerfiles
install unpinned apt and pip packages, so a local build drifts from the published image
the recorded trajectories ran against.
USAGE
}

# The determinism verdict is applied by the substrate rule in this repo, resolved from the
# script's own location so the tool works from any working directory.
REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)

TB2="${TB2_DIR:-$HOME/bench-cache/terminal-bench-2}"
OUT_ROOT="${TB_OUT_DIR:-$HOME/bench-cache/bringup-results}"
IMAGE_TAG="${TB_IMAGE_TAG:-20251031}"
IMAGE_REPO="${TB_IMAGE_REPO:-alexgshaw}"
PULL=0
DETERMINISM=3
DETERMINISM_LOAD=2
SELF_TEST=0
TASKS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --tb2) TB2="$2"; shift 2 ;;
    --out) OUT_ROOT="$2"; shift 2 ;;
    --image-tag) IMAGE_TAG="$2"; shift 2 ;;
    --image-repo) IMAGE_REPO="$2"; shift 2 ;;
    --pull) PULL=1; shift ;;
    --determinism) DETERMINISM="$2"; shift 2 ;;
    --determinism-load) DETERMINISM_LOAD="$2"; shift 2 ;;
    --self-test) SELF_TEST=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
    *) TASKS+=("$1"); shift ;;
  esac
done

case "$DETERMINISM" in ''|*[!0-9]*) echo "--determinism must be a whole number" >&2; exit 2 ;; esac
case "$DETERMINISM_LOAD" in ''|*[!0-9]*) echo "--determinism-load must be a whole number" >&2; exit 2 ;; esac
# One re-grade cannot disagree with anything, so a replicate count of 1 measures no flip
# and must not be mistaken for a clean phase C. The rule downstream rejects such a group
# too; refusing at the flag names the actual mistake instead of failing three phases later.
if [ "$DETERMINISM" -eq 1 ]; then
  echo "--determinism 1 measures no flip; use 0 to skip phase C or 2 or more to run it" >&2
  exit 2
fi
if [ "$DETERMINISM_LOAD" -eq 1 ]; then
  echo "--determinism-load 1 measures no flip; use 0 to skip the contended group or 2 or more" >&2
  exit 2
fi

# The one place a verdict word is chosen. Order is load-bearing: a suite that passes on an
# untouched image, or answers differently about identical bytes, cannot measure a repair
# however cleanly the two states separated, so both are read before the certified case.
certify_verdict() { # $1 = unsolved reward, $2 = solved reward, $3 = stable|unstable|skipped, $4 = flip_bp, $5 = replicates
  if [ "$1" = "1" ]; then
    echo "BROKEN_ORACLE_passes_unsolved"
  elif [ "$3" = "unstable" ]; then
    echo "NONDETERMINISTIC_ORACLE(flip=$(printf '%d.%02d' $(($4 / 100)) $(($4 % 100)))%,n=$5)"
  elif [ "$1" = "0" ] && [ "$2" = "1" ]; then
    [ "$3" = "stable" ] && echo CERTIFIED || echo CERTIFIED_UNCHECKED_DETERMINISM
  else
    echo "NOT_CERTIFIED(unsolved=$1,solved=$2)"
  fi
}

self_test() {
  local failures=0 got
  # unsolved solved determinism flip_bp replicates -> expected verdict
  while read -r unsolved solved state flip n expected; do
    [ -n "$unsolved" ] || continue
    got=$(certify_verdict "$unsolved" "$solved" "$state" "$flip" "$n")
    if [ "$got" != "$expected" ]; then
      echo "FAIL certify_verdict($unsolved,$solved,$state,$flip,$n) = '$got', expected '$expected'" >&2
      failures=$((failures + 1))
    fi
  done <<'VERDICTS'
0 1 stable 0 10 CERTIFIED
0 1 unstable 666 15 NONDETERMINISTIC_ORACLE(flip=6.66%,n=15)
0 1 skipped 0 0 CERTIFIED_UNCHECKED_DETERMINISM
1 1 stable 0 10 BROKEN_ORACLE_passes_unsolved
1 1 unstable 5000 10 BROKEN_ORACLE_passes_unsolved
0 0 stable 0 10 NOT_CERTIFIED(unsolved=0,solved=0)
VERDICTS

  if [ "$failures" -eq 0 ]; then
    echo "self-test OK"
    return 0
  fi
  echo "self-test failed: $failures case(s)" >&2
  return 1
}

if [ "$SELF_TEST" -eq 1 ]; then
  self_test
  exit $?
fi

[ ${#TASKS[@]} -gt 0 ] || { echo "no task named" >&2; usage >&2; exit 2; }
[ -d "$TB2" ] || { echo "no terminal-bench-2 clone at $TB2" >&2; exit 2; }
command -v docker >/dev/null || { echo "docker is not on PATH" >&2; exit 2; }

mkdir -p "$OUT_ROOT"
SUMMARY="$OUT_ROOT/summary.psv"
[ -s "$SUMMARY" ] || echo 'task|image|image_bytes|unsolved_reward|unsolved_secs|solve_rc|solve_secs|solved_reward|solved_secs|tests_before_agent_phase|tests_after_solve|determinism_replicates|determinism_flip_bp|verdict' > "$SUMMARY"

# Reads a [section] key out of task.toml without a toml parser. The harbor schema keeps
# timeout_sec on the line following its section header, so a two-line window is enough.
read_timeout() { # $1 = task dir, $2 = section, $3 = fallback seconds
  local value
  value=$(grep -A2 "^\[$2\]" "$1/task.toml" 2>/dev/null | grep timeout_sec | head -1 | tr -cd '0-9.' | cut -d. -f1)
  echo "${value:-$3}"
}

start_container() { # $1 = container name, $2 = image
  docker rm -f "$1" >/dev/null 2>&1
  docker run -d --name "$1" --entrypoint "" "$2" sleep infinity >/dev/null 2>&1 ||
    docker run -d --name "$1" --entrypoint "" "$2" tail -f /dev/null >/dev/null 2>&1 ||
    return 1
  docker exec "$1" mkdir -p /logs/verifier /logs/agent /logs/artifacts >/dev/null 2>&1
}

inject_tests() { # $1 = container name, $2 = task dir
  docker exec "$1" mkdir -p /tests >/dev/null 2>&1
  docker cp "$2/tests/." "$1:/tests/" >/dev/null 2>&1 || return 1
  docker exec "$1" chmod +x /tests/test.sh >/dev/null 2>&1
}

# Echoes "<reward> <seconds>". Reward is whatever the task's own test.sh wrote, or
# NO_REWARD_FILE when it wrote nothing -- never a default, because a missing reward and a
# zero reward mean different things.
run_tests() { # $1 = container, $2 = label, $3 = out dir, $4 = timeout
  local start end reward
  # A reward file left by the previous run would be read as this run's verdict.
  docker exec "$1" rm -f /logs/verifier/reward.txt >/dev/null 2>&1
  start=$(date +%s.%N)
  docker exec -e DEBIAN_FRONTEND=noninteractive "$1" \
    timeout "$4" bash -c '(/tests/test.sh) > /logs/verifier/test-stdout.txt 2>&1'
  end=$(date +%s.%N)
  docker exec "$1" cat /logs/verifier/test-stdout.txt > "$3/$2-tests.txt" 2>&1
  reward=$(docker exec "$1" cat /logs/verifier/reward.txt 2>/dev/null | tr -d '[:space:]')
  echo "${reward:-NO_REWARD_FILE} $(echo "$end-$start" | bc)"
}

tests_dir_state() { # $1 = container; ABSENT is the ungameability precondition
  docker exec "$1" sh -c 'ls -d /tests 2>/dev/null || echo ABSENT' 2>/dev/null | tr -d '[:space:]'
}

# Identifies the suite bytes the replicates graded against. Provenance only: it is never
# compared against a digest produced by another scheme.
suite_digest() { # $1 = task dir
  (
    cd "$1/tests" 2>/dev/null || exit 1
    find . -type f -print0 | LC_ALL=C sort -z | while IFS= read -r -d '' rel; do
      printf '/tests/%s\0' "${rel#./}"
      cat "$rel"
      printf '\0'
    done
  ) | sha256sum | cut -d' ' -f1
}

# One busy loop per visible CPU, bounded by its own timeout so a replicate group that ends
# early cannot leave load behind for the next one.
start_load() { # $1 = container, $2 = seconds
  docker exec -d "$1" sh -c \
    "n=\$(nproc 2>/dev/null || echo 2); i=0; while [ \"\$i\" -lt \"\$n\" ]; do timeout $2 sh -c 'while :; do :; done' >/dev/null 2>&1 & i=\$((i+1)); done" \
    >/dev/null 2>&1
}

# Per-assertion verdicts the suite reported for the last grading, as a JSON array, or the
# word null when it reported none.
#
# Read from pytest's own `-rA` summary, one line per test id, because that is the finest
# granularity the suite publishes: it keeps the parameter, so `test_speedup[6]` is its own
# unit. The CTRF report beside it collapses a parametrised test to its base name, and a
# base name is a conjunction over its parameters -- which is how a suite whose per-size
# timing assertions each flip can still return one steady verdict at a state far from the
# threshold. A suite that publishes no summary is recorded as publishing none.
read_assertions() { # $1 = container
  local rows
  rows=$(docker exec "$1" cat /logs/verifier/test-stdout.txt 2>/dev/null |
    awk '$1 ~ /^(PASSED|FAILED|ERROR|XPASS|XFAIL|SKIPPED)$/ && $2 ~ /::/ {
           id = $2
           sub(/^.*\//, "", id)
           gsub(/\\/, "\\\\", id)
           gsub(/"/, "\\\"", id)
           printf "{\"id\":\"%s\",\"passed\":%s}\n", id, ($1 == "PASSED" ? "true" : "false")
         }' | LC_ALL=C sort | paste -sd,)
  if [ -z "$rows" ]; then echo null; else echo "[$rows]"; fi
}

# Re-grades one container N times with nothing written between the runs. Echoes
# "<passes> <fails>" and appends one JSON replicate per line to the sink.
replicate_group() { # $1 = container, $2 = count, $3 = timeout, $4 = json sink
  local i=0 passes=0 fails=0 reward start end ms assertions reward_json passed_json
  while [ "$i" -lt "$2" ]; do
    docker exec "$1" rm -f /logs/verifier/reward.txt /logs/verifier/ctrf.json >/dev/null 2>&1
    start=$(date +%s%3N)
    docker exec -e DEBIAN_FRONTEND=noninteractive "$1" \
      timeout "$3" bash -c '(/tests/test.sh) > /logs/verifier/test-stdout.txt 2>&1' >/dev/null 2>&1
    end=$(date +%s%3N)
    reward=$(docker exec "$1" cat /logs/verifier/reward.txt 2>/dev/null | tr -d '[:space:]')
    assertions=$(read_assertions "$1")
    ms=$((end - start))
    # A missing reward and a reward of 0 are different failures; neither is folded.
    if [ -z "$reward" ]; then reward_json=null; else reward_json="\"$reward\""; fi
    if [ "$reward" = "1" ]; then
      passes=$((passes + 1))
      passed_json=true
    else
      fails=$((fails + 1))
      passed_json=false
    fi
    printf '{"index":%d,"reward":%s,"passed":%s,"wallMs":%d,"assertions":%s}\n' \
      "$i" "$reward_json" "$passed_json" "$ms" "${assertions:-null}" >> "$4"
    i=$((i + 1))
  done
  echo "$passes $fails"
}

# Runs the idle group then the contended group on one container, appends both groups to the
# JSON accumulator, and echoes the pooled "<passes> <fails>" for that state.
replicate_state() { # $1 = container, $2 = state, $3 = timeout, $4 = seconds per grade, $5 = groups file
  local sink passes=0 fails=0 got bound
  sink=$(mktemp)
  read -r got <<< "$(replicate_group "$1" "$DETERMINISM" "$3" "$sink")"
  passes=$(echo "$got" | cut -d' ' -f1)
  fails=$(echo "$got" | cut -d' ' -f2)
  printf '{"state":"%s","load":"idle","replicates":[%s]}\n' "$2" "$(paste -sd, "$sink")" >> "$5"
  echo "  determinism $2/idle: ${passes} pass / ${fails} fail" >&2

  if [ "$DETERMINISM_LOAD" -gt 0 ]; then
    : > "$sink"
    bound=$(( (${4:-30} * (DETERMINISM_LOAD + 1)) + 30 ))
    start_load "$1" "$bound"
    read -r got <<< "$(replicate_group "$1" "$DETERMINISM_LOAD" "$3" "$sink")"
    printf '{"state":"%s","load":"contended","replicates":[%s]}\n' "$2" "$(paste -sd, "$sink")" >> "$5"
    echo "  determinism $2/contended: $(echo "$got" | cut -d' ' -f1) pass / $(echo "$got" | cut -d' ' -f2) fail" >&2
    passes=$((passes + $(echo "$got" | cut -d' ' -f1)))
    fails=$((fails + $(echo "$got" | cut -d' ' -f2)))
  fi
  rm -f "$sink"
  echo "$passes $fails"
}

certify_one() { # $1 = task
  local task="$1"
  local task_dir="$TB2/$task"
  local out="$OUT_ROOT/$task"
  local image="$IMAGE_REPO/$task:$IMAGE_TAG"

  echo "=== $task | image=$image ==="
  if [ ! -d "$task_dir" ]; then
    echo "VERDICT=NO_TASK_DIR($task_dir)"
    return 1
  fi
  mkdir -p "$out"

  if ! docker image inspect "$image" >/dev/null 2>&1; then
    if [ "$PULL" -eq 1 ]; then
      echo "pulling $image"
      docker pull "$image" >/dev/null 2>&1 || { echo "VERDICT=IMAGE_PULL_FAILED"; return 1; }
    else
      echo "VERDICT=IMAGE_MISSING (re-run with --pull)"
      return 1
    fi
  fi
  local size
  size=$(docker image inspect "$image" --format '{{.Size}}')
  echo "image_bytes=$size"
  # A certification is about specific bytes, so the evidence records the manifest digest.
  # An image loaded from an archive has no RepoDigests; the tag is then recorded as-is and
  # a reader can see it carries no `@sha256:`.
  local image_ref
  image_ref=$(docker image inspect "$image" --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' 2>/dev/null)
  [ -n "$image_ref" ] || image_ref="$image"
  echo "image_ref=$image_ref"

  local verifier_timeout agent_timeout
  verifier_timeout=$(read_timeout "$task_dir" verifier 900)
  agent_timeout=$(read_timeout "$task_dir" agent 900)

  # ---------- PHASE A: pristine start state ----------
  local ca="tb-certify-a-$task"
  if ! start_container "$ca" "$image"; then
    echo "VERDICT=CONTAINER_START_FAILED"
    return 1
  fi
  local before
  before=$(tests_dir_state "$ca")
  echo "tests_dir_before_agent_phase=$before"
  inject_tests "$ca" "$task_dir" || { echo "VERDICT=TEST_INJECT_FAILED"; docker rm -f "$ca" >/dev/null 2>&1; return 1; }
  local unsolved_reward unsolved_secs
  read -r unsolved_reward unsolved_secs <<< "$(run_tests "$ca" unsolved "$out" "$verifier_timeout")"
  echo "phaseA_unsolved_reward=$unsolved_reward test_secs=$unsolved_secs"
  # The container stays up: phase C re-grades these exact bytes.

  # ---------- PHASE B: reference solution, then grade ----------
  local cb="tb-certify-b-$task"
  if ! start_container "$cb" "$image"; then
    echo "VERDICT=CONTAINER_START_FAILED"
    return 1
  fi
  docker exec "$cb" mkdir -p /solution >/dev/null 2>&1
  docker cp "$task_dir/solution/." "$cb:/solution/" >/dev/null 2>&1
  docker exec "$cb" chmod +x /solution/solve.sh >/dev/null 2>&1
  local solve_start solve_end solve_rc
  solve_start=$(date +%s.%N)
  docker exec -e DEBIAN_FRONTEND=noninteractive "$cb" \
    timeout "$agent_timeout" bash -c '(/solution/solve.sh) > /logs/agent/oracle.txt 2>&1'
  solve_rc=$?
  solve_end=$(date +%s.%N)
  docker exec "$cb" cat /logs/agent/oracle.txt > "$out/oracle.txt" 2>&1
  local solve_secs
  solve_secs=$(echo "$solve_end-$solve_start" | bc)
  echo "solve_rc=$solve_rc solve_secs=$solve_secs"
  # The solution ran to completion without /tests ever existing. A solution that passed
  # by writing its own reward would have had to create that path itself.
  local after
  after=$(tests_dir_state "$cb")
  echo "tests_dir_after_solve=$after"
  inject_tests "$cb" "$task_dir" || { echo "VERDICT=TEST_INJECT_FAILED"; docker rm -f "$cb" >/dev/null 2>&1; return 1; }
  local solved_reward solved_secs
  read -r solved_reward solved_secs <<< "$(run_tests "$cb" solved "$out" "$verifier_timeout")"
  echo "phaseB_solved_reward=$solved_reward test_secs=$solved_secs"

  # ---------- PHASE C: the same bytes, graded again ----------
  local groups_file det_replicates=0 det_flip_bp=0 det_state=skipped
  groups_file=$(mktemp)
  if [ "$DETERMINISM" -gt 0 ]; then
    local pooled
    for pair in "$ca unsolved ${unsolved_secs%%.*}" "$cb solved ${solved_secs%%.*}"; do
      # shellcheck disable=SC2086
      set -- $pair
      pooled=$(replicate_state "$1" "$2" "$verifier_timeout" "$3" "$groups_file")
      echo "phaseC_${2}_suite_reward=$(echo "$pooled" | cut -d' ' -f1)pass/$(echo "$pooled" | cut -d' ' -f2)fail"
    done
    printf '{"taskName":"%s","image":"%s","suiteDigest":"%s","measuredAt":"%s","groups":[%s]}\n' \
      "$task" "$image_ref" "$(suite_digest "$task_dir")" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      "$(paste -sd, "$groups_file")" > "$out/determinism.json"

    # The rule lives in the substrate, so a certification run and a campaign cannot
    # disagree about what a stable oracle is. No node means no verdict, not a weaker one.
    local fields
    fields=$(cd "$REPO_ROOT" && npx --no-install tsx scripts/tb-oracle-determinism.ts \
      "$out/determinism.json" --out "$out/determinism-verdict.json" 2>"$out/determinism-verdict.log")
    case $? in
      0|3) ;;
      *) cat "$out/determinism-verdict.log" >&2; echo "VERDICT=DETERMINISM_RULE_UNAVAILABLE"; return 1 ;;
    esac
    cat "$out/determinism-verdict.log"
    # shellcheck disable=SC2086
    set -- $fields
    for field in "$@"; do
      case "$field" in
        flip_bp=*) det_flip_bp="${field#flip_bp=}" ;;
        replicates=*) det_replicates="${field#replicates=}" ;;
        state=*) det_state="${field#state=}" ;;
      esac
    done
    echo "phaseC_flip_bp=$det_flip_bp replicates=$det_replicates state=$det_state"
  fi
  rm -f "$groups_file"

  docker rm -f "$ca" >/dev/null 2>&1
  docker rm -f "$cb" >/dev/null 2>&1

  local verdict
  verdict=$(certify_verdict "$unsolved_reward" "$solved_reward" "$det_state" "$det_flip_bp" "$det_replicates")
  echo "VERDICT=$verdict"
  echo "$task|$image|$size|$unsolved_reward|$unsolved_secs|$solve_rc|$solve_secs|$solved_reward|$solved_secs|$before|$after|$det_replicates|$det_flip_bp|$verdict" >> "$SUMMARY"
  [ "$verdict" = "CERTIFIED" ]
}

failed=0
for task in "${TASKS[@]}"; do
  certify_one "$task" | tee "$OUT_ROOT/$task.log"
  # tee is last in the pipeline, so read the certifier's own status.
  [ "${PIPESTATUS[0]}" -eq 0 ] || failed=$((failed + 1))
done

echo
echo "certified $(( ${#TASKS[@]} - failed ))/${#TASKS[@]}; summary: $SUMMARY"
[ "$failed" -eq 0 ]
