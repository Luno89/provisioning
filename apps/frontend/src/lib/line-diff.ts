export type DiffLine = { kind: 'same' | 'removed' | 'added'; line: string }

export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n')
  const b = after.split('\n')
  const lengths = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i]![j] = a[i] === b[j] ? lengths[i + 1]![j + 1]! + 1 : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ kind: 'same', line: a[i]! }); i += 1; j += 1 }
    else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) { out.push({ kind: 'removed', line: a[i]! }); i += 1 }
    else { out.push({ kind: 'added', line: b[j]! }); j += 1 }
  }
  while (i < a.length) { out.push({ kind: 'removed', line: a[i]! }); i += 1 }
  while (j < b.length) { out.push({ kind: 'added', line: b[j]! }); j += 1 }
  return out
}
