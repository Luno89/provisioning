#!/usr/bin/env bash
set -euo pipefail

input=$(cat)
command=$(jq -r '.tool_input.command // ""' <<<"$input")

if ! grep -qE '(^|[;&|( ]|&&)[[:space:]]*(npm (run )?(test|gate|ship|lint)([: ]|$)|npm run test:[a-z0-9:-]+|npx vitest)' <<<"$command"; then
  exit 0
fi
if sed -E 's#[0-9]?>+[[:space:]]*/dev/null##g' <<<"$command" | grep -qE '(^|[^0-9&])>[^&]|\|[[:space:]]*tee([[:space:]]|$)'; then
  exit 0
fi

logs="${TMPDIR:-/tmp}/claude-test-logs"
wrapped=$(cat <<EOF
mkdir -p '$logs'; QUIET_LOG="$logs/\$(date +%Y%m%d-%H%M%S)-\$\$.log"
{ $command
} > "\$QUIET_LOG" 2>&1; quiet_code=\$?
grep -nE '(FAIL|✗|×|✖|error TS|Error:|AssertionError| failed| problems? )' "\$QUIET_LOG" | head -n 40 || true
echo '--- last 25 lines ---'
tail -n 25 "\$QUIET_LOG"
echo "--- full log: \$QUIET_LOG (exit \$quiet_code)"
exit \$quiet_code
EOF
)

jq -n --argjson input "$input" --arg command "$wrapped" \
  '{hookSpecificOutput: {hookEventName: "PreToolUse", updatedInput: ($input.tool_input + {command: $command})}}'
