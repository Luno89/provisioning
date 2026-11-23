import type { ProvisioningView, ProvisionPieceKey, ProvisionPieceState, ProvisionPieceView, ProvisionReason } from '@koala/engine-core/koala-install'

export interface PieceShown {
  key: ProvisionPieceKey
  title: string
  state: ProvisionPieceState
  words: string
}

export type SetupShown =
  | { kind: 'up'; key: string; line: string; root?: string }
  | { kind: 'open'; key: string; heading: string; because: string; pieces: PieceShown[]; failed?: string; again: boolean; root?: string }

export type CardShown =
  | { kind: 'not-started'; line: string }
  | { kind: 'set-up'; line: string }
  | { kind: 'setting-up'; setups: SetupShown[] }

const BECAUSE: Record<ProvisionReason, string> = {
  revision: 'for the new revision of Koala\'s chart',
  missing: 'because a piece was found missing',
  asked: 'because you asked',
}

function pieceWords(piece: ProvisionPieceView): string {
  if (piece.state === 'waiting') return 'waiting to start'
  if (piece.state === 'working') return piece.line ?? 'under way'
  if (piece.state === 'up') return 'up'
  return piece.why ?? 'it gave no reason'
}

const upLine = (setup: ProvisioningView): string =>
  setup.target.kind === 'koala'
    ? `Koala's services and monitoring are set up (revision ${setup.revision}).`
    : `${setup.target.machine}'s collector is set up.`

const heading = (setup: ProvisioningView): string =>
  setup.target.kind === 'koala' ? `Koala's own services and monitoring, revision ${setup.revision}` : `${setup.target.machine}'s collector`

function stoppedLine(setup: ProvisioningView): string {
  const failed = setup.pieces.filter((entry) => entry.state === 'failed')
  if (failed.length > 0) return `Stopped at ${failed.map((piece) => `${piece.title}: ${pieceWords(piece)}`).join('; ')}`
  return `Stopped: ${setup.why ?? 'it gave no reason'}`
}

const rootSaid = (setup: ProvisioningView): { root?: string } =>
  (setup.root ? { root: `My Machines does not show this yet: ${setup.root.why}` } : {})

function setupShown(setup: ProvisioningView, canAgain: boolean): SetupShown {
  const key = setup.target.clusterId
  if (setup.state === 'up') return { kind: 'up', key, line: upLine(setup), ...rootSaid(setup) }
  return {
    kind: 'open',
    key,
    heading: heading(setup),
    because: BECAUSE[setup.reason],
    pieces: setup.pieces.map((piece) => ({ key: piece.key, title: piece.title, state: piece.state, words: pieceWords(piece) })),
    ...(setup.state === 'failed' ? { failed: stoppedLine(setup) } : {}),
    again: setup.state === 'failed' && canAgain,
    ...rootSaid(setup),
  }
}

const order = (setup: ProvisioningView): string => (setup.target.kind === 'koala' ? '' : setup.target.machine)

export function provisioningShown(setups: readonly ProvisioningView[], canAgain: boolean): CardShown {
  if (setups.length === 0) return { kind: 'not-started', line: 'Koala has not started setting itself up yet.' }
  const sorted = [...setups].sort((a, b) => order(a).localeCompare(order(b)))
  if (sorted.every((setup) => setup.state === 'up' && !setup.root)) return { kind: 'set-up', line: sorted.map(upLine).join(' ') }
  return { kind: 'setting-up', setups: sorted.map((setup) => setupShown(setup, canAgain)) }
}
