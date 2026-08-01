#!/usr/bin/env bash
set -euo pipefail
cd /dev/shm/ae-r2-tn
export MODEL_API_KEY="$ZAI_GLM_API_KEY"
node dist/cli.js analyst-benchmark \
  --dataset codetracebench \
  --analyst dspy-rlm \
  --python /dev/shm/ae-r2-tn/clients/python/.venv/bin/python \
  --labels /dev/shm/ae-r2-tn/.scratch/split3-thin-blind-labels.json \
  --trace-dir /dev/shm/ctb-split3-restored-traces \
  --artifact-dir /dev/shm/ctb-split3-prepared/extracted \
  --out /dev/shm/smoke-restored \
  --revision aa213b84ffb6690fc37ca15766d6ca174ec36d4d \
  --split verified-miniswe-normalizer-remainder-thin-blind-28 \
  --base-url https://api.z.ai/api/coding/paas/v4 \
  --api-key-env MODEL_API_KEY \
  --model glm-5.2 \
  --limit 4 \
  --seed 0 \
  --concurrency 4 \
  --repetitions 2 \
  --max-output-tokens 8192 \
  --timeout-ms 1200000 \
  --max-cost-usd 4 \
  --instructions-file /dev/shm/ae-r2-tn/.scratch/winner-instructions.txt
