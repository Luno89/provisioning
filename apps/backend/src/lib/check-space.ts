import type { UserMetadata } from './types.js';
import type { MemoryItem } from './memory-store.js';
import type { CheckScript } from './check-script.js';

export const SPACE_EMAIL_DOMAIN = 'checks.internal';

export interface SpaceOrigin {
  person: string;
  checkRunId: string;
  scenarioId: string;
  script?: CheckScript | undefined;
}

export function scriptedModelBase(env: Readonly<Record<string, string | undefined>>): string {
  const api = env.CHECKS_API_URL?.trim() || `http://localhost:${env.PORT?.trim() || '3001'}/api`;
  return `${api.replace(/\/+$/, '')}/checks/scripted`;
}

export const scriptedEndpointId = (spaceId: string): string => `scripted-${spaceId}`;

export const spaceEmail = (spaceId: string): string => `${spaceId}@${SPACE_EMAIL_DOMAIN}`;

export function spaceUser(spaceId: string, origin: SpaceOrigin, now: string): UserMetadata {
  return {
    id: spaceId,
    email: spaceEmail(spaceId),
    twoFactorEnabled: false,
    emailVerified: true,
    createdAt: now,
    space: {
      person: origin.person,
      checkRunId: origin.checkRunId,
      scenarioId: origin.scenarioId,
      ...(origin.script ? { models: 'scripted' as const, script: origin.script } : { models: 'borrowed' as const }),
      world: {},
    },
  };
}

export const isSpace = (user: Pick<UserMetadata, 'space'> | undefined): boolean => Boolean(user?.space);

export const modelOwner = (user: Pick<UserMetadata, 'id' | 'space'> | undefined, fallback: string): string =>
  (user?.space && user.space.models !== 'scripted' ? user.space.person : undefined) ?? user?.id ?? fallback;

export function reowned<T extends { ownerId?: string | undefined }>(records: readonly T[], person: string, space: string): T[] {
  return records.filter((record) => record.ownerId === person).map((record) => ({ ...record, ownerId: space }));
}

export interface PromptChange {
  agent: string;
  prompt: string;
}

export function spacePersonas<T extends { slug: string; ownerId?: string | undefined; prompt?: string | undefined }>(
  personas: readonly T[],
  person: string,
  space: string,
  change?: PromptChange | undefined,
): T[] {
  const copied = reowned(personas, person, space);
  if (!change) return copied;
  const base = copied.find((persona) => persona.slug === change.agent) ?? personas.find((persona) => persona.slug === change.agent && persona.ownerId === undefined);
  if (!base) return copied;
  return [...copied.filter((persona) => persona.slug !== change.agent), { ...base, ownerId: space, prompt: change.prompt }];
}

export function spacePractices(memories: readonly MemoryItem[], person: string, space: string, trial?: string | undefined): MemoryItem[] {
  return memories
    .filter((memory) => memory.ownerId === person && memory.category === 'practice' && !memory.invalidAt && (memory.status === 'active' || memory.id === trial))
    .map((memory) => ({ ...memory, id: `${space}-${memory.id}`, ownerId: space, ...(memory.id === trial ? { status: 'active' as const } : {}) }));
}
