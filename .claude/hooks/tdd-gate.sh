#!/usr/bin/env bash
set -euo pipefail

input=$(cat)
tool=$(jq -r '.tool_name // ""' <<<"$input")

case "$tool" in
  Edit|Write|MultiEdit|NotebookEdit)
    path=$(jq -r '.tool_input.file_path // ""' <<<"$input")
    [[ "$path" =~ (^|/)(apps|packages|scripts|tests|charts)/ ]] || exit 0
    ;;
  Bash)
    command=$(jq -r '.tool_input.command // ""' <<<"$input")
    [[ "$command" =~ git[[:space:]].*commit ]] || exit 0
    ;;
  *) exit 0 ;;
esac

root="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
exec "$root/node_modules/.bin/tsx" "$root/tests/lib/tdd-gate-hook.ts" <<<"$input"
