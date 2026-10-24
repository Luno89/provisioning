import type { PersonInstance } from '../types'

const INSTANCE_STATE: Record<PersonInstance['status'], string> = {
  waiting: 'waiting for its machine',
  joined: 'joined',
  installing: 'setting up',
  ready: 'running',
  failed: 'failed',
  paused: 'stopped, trial ended',
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

export function instanceLine(instance: PersonInstance): string {
  const where = instance.where === 'pool' ? 'on Koala\'s servers' : 'on their own machine'
  const trial = instance.trialEndsAt ? `, trial ends ${day(instance.trialEndsAt)}` : ''
  const version = instance.version ? ` ${instance.version}` : ''
  const updates = instance.autoUpdates === undefined ? '' : instance.autoUpdates ? ', updates automatically' : ', updates by hand'
  return `${instance.name ?? 'Instance'} ${where}: ${INSTANCE_STATE[instance.status]}${version}${trial}${updates}`
}

export function yoursGoes(instance: PersonInstance | undefined): string[] {
  if (!instance) return []
  const named = instance.name ? ` ${instance.name}` : ''
  return instance.where === 'pool'
    ? [`Your instance${named} on Koala's servers is deleted, with everything in it: chats, projects, repositories, apps and their data.`]
    : [
      `Your instance${named} is let go of: its address stops answering and it leaves the mesh, so nobody can sign in to it any more.`,
      'It keeps running on your own machine, with your work on it, until you uninstall it. Take what you want to keep before you go.',
    ]
}

export function goesWith(instance: PersonInstance | undefined): string | undefined {
  if (!instance) return undefined
  return instance.where === 'pool'
    ? `Their instance ${instance.name ?? ''} on Koala's servers is deleted with everything in it.`
    : `Their instance ${instance.name ?? ''} is let go of here: its address stops and its machines leave the mesh. What is on their own machine stays theirs.`
}
