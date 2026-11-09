#!/usr/bin/env bash
set -euo pipefail

command=$(jq -r '.tool_input.command // ""')

searches='^[[:space:]]*(git[[:space:]]+grep|grep|egrep|rg)([[:space:]]|$)'
repo='^[[:space:]]*git[[:space:]]+grep'
source='(^|[[:space:]/"'"'"'])(apps|packages|tests|src)(/|[[:space:]]|$|["'"'"'])|--include=[^[:space:]]*\.tsx?|-t[[:space:]]*ts|--type[= ]ts|\.tsx?([[:space:]]|$|["'"'"'])'

reads_source=false
while IFS= read -r part; do
  [[ "$part" =~ $searches ]] || continue
  if [[ "$part" =~ $repo ]] || [[ "$part" =~ $source ]]; then reads_source=true; fi
done < <(printf '%s\n' "$command" | sed -E 's/(\|\||&&|;|\||\$\(|\()/\n/g')

if [[ "$reads_source" == true ]]; then
  jq -n '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: "This searches source code as text. For callers, references or what a change touches, the owner wants the coding tools, not grep: `npm run refs -- <file> <Symbol>`, the LSP tool (findReferences from the caller side once that workspace is open), and `npm run flows` (flow maps from the frontend action to how the flow ends, and the concept index). Before any change list, run the change-list skill. Grep stays fine for plans, logs and plain text."
    }
  }'
fi
