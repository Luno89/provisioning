quietly() {
  local log pid code shown=0 width lines
  log="$(mktemp)"
  "$@" >"${log}" 2>&1 &
  pid=$!
  if [ -t 1 ]; then
    width=$(( $(tput cols 2>/dev/null || echo 100) - 6 ))
    while kill -0 "${pid}" 2>/dev/null; do
      lines="$(tr '\r' '\n' < "${log}" | sed 's/\x1b\[[0-9;]*[A-Za-z]//g' | grep -v '^[[:space:]]*$' | tail -n 8 | cut -c1-"${width}" || true)"
      [ "${shown}" -gt 0 ] && printf '\033[%dA\033[J' "${shown}"
      shown=0
      if [ -n "${lines}" ]; then
        printf '%s\n' "${lines}" | sed 's/^/    \x1b[2m/; s/$/\x1b[0m/'
        shown=$(printf '%s\n' "${lines}" | wc -l)
      fi
      sleep 0.3
    done
    [ "${shown}" -gt 0 ] && printf '\033[%dA\033[J' "${shown}"
  else
    tail -n +1 -s 0.2 -f --pid="${pid}" "${log}" | stdbuf -o0 tr '\r' '\n' | sed -u 's/\x1b\[[0-9;]*[A-Za-z]//g; /^[[:space:]]*$/d; s/^/    /'
  fi
  code=0
  wait "${pid}" || code=$?
  if [ "${code}" -ne 0 ] && [ -t 1 ]; then
    tr '\r' '\n' < "${log}" | tail -n 40
  fi
  rm -f "${log}"
  return "${code}"
}
