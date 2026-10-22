export type TrialStep = 'warn-3d' | 'warn-1d' | 'pause' | 'resume' | 'last-warning' | 'delete';

export const DAY_MS = 86_400_000;
export const TRIAL_CHANGED = 'trialChanged';

export const poolTrialWorkflowId = (instanceId: string): string => `pool-trial-${instanceId}`;
export const poolRemoveWorkflowId = (instanceId: string): string => `pool-remove-${instanceId}`;
export const KEEP_PAUSED_DAYS = 30;
export const LAST_WARNING_DAYS = 3;

export interface TrialState {
  trialEndsAt: string;
  told?: readonly TrialStep[] | undefined;
  pausedAt?: string | undefined;
}

export interface DueStep {
  step: TrialStep;
  at: number;
}

type Scheduled = Exclude<TrialStep, 'resume'>;

export function trialSchedule(trialEndsAt: string): Record<Scheduled, number> {
  const end = Date.parse(trialEndsAt);
  return {
    'warn-3d': end - 3 * DAY_MS,
    'warn-1d': end - DAY_MS,
    pause: end,
    'last-warning': end + (KEEP_PAUSED_DAYS - LAST_WARNING_DAYS) * DAY_MS,
    delete: end + KEEP_PAUSED_DAYS * DAY_MS,
  };
}

export function nextTrialStep(state: TrialState, now: number): DueStep {
  const schedule = trialSchedule(state.trialEndsAt);
  const told = new Set(state.told ?? []);
  if (state.pausedAt) {
    if (now < schedule.pause) return { step: 'resume', at: now };
    if (!told.has('last-warning') && now < schedule.delete) return { step: 'last-warning', at: schedule['last-warning'] };
    return { step: 'delete', at: schedule.delete };
  }
  if (!told.has('warn-3d') && !told.has('warn-1d') && now < schedule['warn-1d']) return { step: 'warn-3d', at: schedule['warn-3d'] };
  if (!told.has('warn-1d') && now < schedule.pause) return { step: 'warn-1d', at: schedule['warn-1d'] };
  return { step: 'pause', at: schedule.pause };
}

export function extendedTrial(state: TrialState, trialEndsAt: string, now: number): TrialState {
  const schedule = trialSchedule(trialEndsAt);
  const told = (state.told ?? []).filter((step): step is 'warn-3d' | 'warn-1d' => (step === 'warn-3d' || step === 'warn-1d') && schedule[step] <= now);
  return { trialEndsAt, told, ...(state.pausedAt ? { pausedAt: state.pausedAt } : {}) };
}

export function afterStep(state: TrialState, step: TrialStep, now: number): TrialState {
  if (step === 'resume') return { trialEndsAt: state.trialEndsAt, told: (state.told ?? []).filter((done) => done === 'warn-3d' || done === 'warn-1d') };
  return {
    ...state,
    told: [...new Set([...(state.told ?? []), step])],
    ...(step === 'pause' ? { pausedAt: new Date(now).toISOString() } : {}),
  };
}

const day = (at: number | string): string => new Date(at).toUTCString().slice(0, 16);

export function trialMessage(step: TrialStep, input: { name: string; trialEndsAt: string; rootUrl: string }): { subject: string; text: string } {
  const deleteAt = trialSchedule(input.trialEndsAt).delete;
  const move = `To keep your work, move your instance to a machine of your own from ${input.rootUrl}: everything moves as it is.`;
  switch (step) {
    case 'warn-3d':
    case 'warn-1d':
      return {
        subject: `Your Koala trial ends on ${day(input.trialEndsAt)}`,
        text: `Your instance ${input.name} on Koala's servers runs until ${day(input.trialEndsAt)}. Then it stops, and its work is kept until ${day(deleteAt)}.\n\n${move}`,
      };
    case 'pause':
      return {
        subject: 'Your Koala trial has ended',
        text: `Your instance ${input.name} on Koala's servers has stopped. Its work is kept until ${day(deleteAt)}, and deleted then.\n\n${move}`,
      };
    case 'last-warning':
      return {
        subject: `Your stopped Koala instance is deleted on ${day(deleteAt)}`,
        text: `The work in your stopped instance ${input.name} is deleted on ${day(deleteAt)}, and cannot be brought back after that.\n\n${move}`,
      };
    case 'delete':
      return { subject: 'Your Koala trial instance was deleted', text: `Your instance ${input.name} on Koala's servers and its work were deleted, ${KEEP_PAUSED_DAYS} days after the trial ended.` };
    case 'resume':
      return { subject: 'Your Koala instance is running again', text: `Your trial now runs until ${day(input.trialEndsAt)}, and your instance ${input.name} is running again as you left it.` };
  }
}
