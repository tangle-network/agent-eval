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
#
# A task is certified only when phase A fails and phase B passes. Phase A passing means a
# broken oracle: the tests do not detect the unsolved state and the task scores nothing.
#
# Deliberately NOT `set -e`. Failing tests are the expected result of phase A, and every
# command that may legitimately exit nonzero is checked explicitly.
set -uo pipefail

usage() {
  cat <<'USAGE'
usage: certify-task-oracle.sh [options] TASK [TASK...]

  --tb2 DIR         terminal-bench-2 clone            (default: $TB2_DIR or ~/bench-cache/terminal-bench-2)
  --out DIR         per-task evidence root            (default: $TB_OUT_DIR or ~/bench-cache/bringup-results)
  --image-tag TAG   published image tag               (default: $TB_IMAGE_TAG or 20251031)
  --image-repo REPO published image repo prefix       (default: $TB_IMAGE_REPO or alexgshaw)
  --pull            pull the published image when absent

Pin the clone. Task definitions move under unchanged names, so an unpinned clone
regrades against different tests without saying so.

Never rebuild the image from environment/Dockerfile for replay work. Those Dockerfiles
install unpinned apt and pip packages, so a local build drifts from the published image
the recorded trajectories ran against.
USAGE
}

TB2="${TB2_DIR:-$HOME/bench-cache/terminal-bench-2}"
OUT_ROOT="${TB_OUT_DIR:-$HOME/bench-cache/bringup-results}"
IMAGE_TAG="${TB_IMAGE_TAG:-20251031}"
IMAGE_REPO="${TB_IMAGE_REPO:-alexgshaw}"
PULL=0
TASKS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --tb2) TB2="$2"; shift 2 ;;
    --out) OUT_ROOT="$2"; shift 2 ;;
    --image-tag) IMAGE_TAG="$2"; shift 2 ;;
    --image-repo) IMAGE_REPO="$2"; shift 2 ;;
    --pull) PULL=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
    *) TASKS+=("$1"); shift ;;
  esac
done

[ ${#TASKS[@]} -gt 0 ] || { echo "no task named" >&2; usage >&2; exit 2; }
[ -d "$TB2" ] || { echo "no terminal-bench-2 clone at $TB2" >&2; exit 2; }
command -v docker >/dev/null || { echo "docker is not on PATH" >&2; exit 2; }

mkdir -p "$OUT_ROOT"
SUMMARY="$OUT_ROOT/summary.psv"
[ -s "$SUMMARY" ] || echo 'task|image|image_bytes|unsolved_reward|unsolved_secs|solve_rc|solve_secs|solved_reward|solved_secs|tests_before_agent_phase|tests_after_solve|verdict' > "$SUMMARY"

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
  docker rm -f "$ca" >/dev/null 2>&1

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
  docker rm -f "$cb" >/dev/null 2>&1

  local verdict
  if [ "$unsolved_reward" = "1" ]; then
    # Checked before the certified case: tests that pass on an untouched image cannot
    # measure a repair, whatever phase B says.
    verdict="BROKEN_ORACLE_passes_unsolved"
  elif [ "$unsolved_reward" = "0" ] && [ "$solved_reward" = "1" ]; then
    verdict=CERTIFIED
  else
    verdict="NOT_CERTIFIED(unsolved=$unsolved_reward,solved=$solved_reward)"
  fi
  echo "VERDICT=$verdict"
  echo "$task|$image|$size|$unsolved_reward|$unsolved_secs|$solve_rc|$solve_secs|$solved_reward|$solved_secs|$before|$after|$verdict" >> "$SUMMARY"
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
