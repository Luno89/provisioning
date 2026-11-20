import type { PersonInstance } from '../types'

const INSTANCE_STATE: Record<PersonInstance['status'], string> = {
  waiting: 'waiting for its machine',
  joined: 'joined',
  installing: 'setting up',
  ready: 'running',
  failed: 'failed',
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

export function instanceLine(instance: PersonInstance): string {
  const held = instance.heldByData ? ` (held: its data cannot run on ${instance.heldByData.version})` : ''
  const version = instance.version ? ` ${instance.version}${instance.versionWithdrawn ? ' (withdrawn)' : ''}${held}` : ''
  const updates = instance.autoUpdates === undefined ? '' : instance.autoUpdates ? ', updates automatically' : ', updates by hand'
  const reach = instance.unreachableSince ? `, not answering since ${day(instance.unreachableSince)}` : ''
  const signOuts = instance.signOutsUndelivered ? `, signing out has not reached it since ${day(instance.signOutsUndelivered.since)} (${instance.signOutsUndelivered.why})` : ''
  return `${instance.name ?? 'Instance'} on their own machine: ${INSTANCE_STATE[instance.status]}${version}${reach}${signOuts}${updates}`
}

export function yoursGoes(instance: PersonInstance | undefined): string[] {
  if (!instance) return []
  const named = instance.name ? ` ${instance.name}` : ''
  return [
    `Your instance${named} is let go of: its address stops answering and it leaves the mesh, so nobody can sign in to it any more.`,
    'It keeps running on your own machine, with your work on it, until you uninstall it. Take what you want to keep before you go.',
  ]
}

export function goesWith(instance: PersonInstance | undefined): string | undefined {
  if (!instance) return undefined
  return `Their instance ${instance.name ?? ''} is let go of here: its address stops and its machines leave the mesh. What is on their own machine stays theirs.`
}
