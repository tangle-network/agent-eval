#!/bin/bash
# One arm's readouts once its run has ended: graded versions, the compare.py curve, and the chat arm's tokens by kind.
set -u
S=/mnt/traces/scratch/evolve/2026-11-27; O=$S/readouts; D=/mnt/traces/discovery-runs; E=$D/_evolve
export DISCO_CHECKOUT=$S/disco-engine
cd $S/disco-engine
log() { echo "$(date -u +%FT%TZ) $*" >> $O/finalize.log; }
chat() { # RUN_ID BOARD_FOLDER NAME
  while systemctl --user is-active --quiet "disco-run@$1.service"; do sleep 120; done
  sleep 180
  log "$3 ended; grading $1"
  node tools/evolve/grade-versions.mjs $D/$1 $2 --out $O/graded-$3.json > $O/grade-$3.log 2>&1; log "$3 grade exit $?"
  python3 -I $S/export.py chat $D/$1 $O/graded-$3.json > $O/curve-$3.json; log "$3 export exit $?"
  node $S/chat-tokens.mjs $D/$1 > $O/tokens-$3.json; log "$3 tokens exit $?"
  touch $O/done-$3
}
engine() { # RUN_ID BOARD_FOLDER NAME
  until [ -f $E/$1/evolve-result.json ]; do sleep 60; done
  log "$3 settled"
  python3 -I $S/export.py program-search $E/$1 > $O/curve-$3.json; log "$3 export exit $?"
  cp $E/$1/best/construction.json $O/best-$3.json
  node tools/evolve/grade-versions.mjs $E/$1 $2 --out $O/graded-$3.json > $O/grade-$3.log 2>&1; log "$3 grade exit $?"
  touch $O/done-$3
}
case "$1" in
ac1-engine) engine evolve-first-autocorrelation-inequality-record-20261127e plays/board-first-autocorrelation-inequality ac1-engine-e ;;
ac1-chat) chat record-first-autocorrelation-inequality-20261127a plays/board-first-autocorrelation-inequality ac1-chat54 ;;
cp-chat) chat board-circle-packing-attempt-20261127a plays/board-circle-packing cp-chat54 ;;
esac
