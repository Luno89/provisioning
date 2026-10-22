export function noticeRepeats(messages: readonly { role: string; notice?: { text: string } | undefined }[]): Map<number, number> {
  const repeats = new Map<number, number>()
  let run = 0
  messages.forEach((message, index) => {
    if (message.role !== 'notice' || !message.notice) {
      run = 0
      return
    }
    const next = messages[index + 1]
    const same = next?.role === 'notice' && next.notice?.text === message.notice.text
    run += 1
    repeats.set(index, same ? 0 : run)
    if (!same) run = 0
  })
  return repeats
}
