#!/usr/bin/env bash
set -euo pipefail

input=$(cat)
tool=$(jq -r '.tool_name // ""' <<<"$input")

refuse() {
  jq -n --arg why "$1" '{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $why } }'
  exit 0
}

secret='apps/backend/(\.env([^.[:alnum:]]|$)|data(/|[[:space:]"'"'"']|$))'
SECRETS="The owner's rule: never read or touch apps/backend/.env or apps/backend/data/, and never read or print secrets."

case "$tool" in
  Read|Edit|Write|MultiEdit|NotebookEdit|Grep|Glob)
    target=$(jq -r '[.tool_input.file_path, .tool_input.path, .tool_input.notebook_path] | map(select(. != null)) | join(" ")' <<<"$input")
    [[ "$target" =~ $secret ]] && refuse "$SECRETS"
    exit 0
    ;;
  Bash) ;;
  *) exit 0 ;;
esac

command=$(jq -r '.tool_input.command // ""' <<<"$input")

[[ "$command" =~ $secret ]] && refuse "$SECRETS"
[[ "$command" =~ pgrep[[:space:]]+(-[[:alpha:]]*[[:space:]]+)*-[[:alpha:]]*f ]] && [[ "$command" =~ (^|[^[:alnum:]_])kill([[:space:]]|$) ]] && refuse "Never stop processes found by a pattern (pgrep -f can match the shell running it, as pkill -f does): find the pid once, read it, then stop that pid."
[[ "$command" =~ \|[[:space:]]*tail([[:space:]][^\;\&\|]*)?\&\& ]] && refuse "A gate piped through tail and then chained with && hides the gate's exit code: write the output to a file, then read the exit code (owner's rule: never judge typecheck, lint or tests through | tail)."

while IFS= read -r part; do
  part="${part#"${part%%[![:space:]]*}"}"
  [[ "$part" =~ ^(sudo[[:space:]]+)?timeout[[:space:]] ]] && refuse "No deadlines (owner's rule): work ends when it finishes, fails for good, or is stopped. Run the command without a timeout, and watch it with npm run test:status or a Monitor instead."
  [[ "$part" =~ ^git([[:space:]]+-[Cc][[:space:]]+[^[:space:]]+)*[[:space:]]+push([[:space:]]|$) ]] && refuse "Only the owner pushes, through npm run ship in their own terminal."
  [[ "$part" =~ ^pkill[[:space:]](.*[[:space:]])?-[[:alpha:]]*f ]] && refuse "Never stop processes by a pattern (pkill -f can match the shell running it): stop them by pid."
  [[ "$part" =~ ^killall([[:space:]]|$) ]] && refuse "Never stop processes by name: stop them by pid."
done < <(printf '%s\n' "$command" | sed -E 's/(\|\||&&|;|\||\$\(|\(|`)/\n/g')

exit 0
