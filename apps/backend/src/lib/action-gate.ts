
export type ToolEffect = 'read' | 'write' | 'propose';

export const ALL_EFFECTS: readonly ToolEffect[] = ['read', 'write', 'propose'] as const;

export const READ_ONLY: readonly ToolEffect[] = ['read'] as const;

export const PROPOSE_ONLY: readonly ToolEffect[] = ['read', 'propose'] as const;

export type GateDecision =
  | { allowed: true }
  | { allowed: false; reason: string };

export function gate(
  name: string,
  effect: ToolEffect | undefined,
  permitted: readonly ToolEffect[],
): GateDecision {
  if (!effect || !ALL_EFFECTS.includes(effect)) {
    return {
      allowed: false,
      reason:
        `"${name}" cannot run: it declares no effect, or declares one that is not `
        + `${ALL_EFFECTS.join(', ')}. This is a defect in the tool, not in your call — `
        + `report it and use a different tool.`,
    };
  }

  if (!permitted.includes(effect)) {
    return {
      allowed: false,
      reason:
        `"${name}" ${effect}s, and this conversation is limited to `
        + `${permitted.length ? permitted.join(' and ') : 'nothing'}. Nothing was changed. `
        + (permitted.includes('propose')
          ? 'Propose the change instead, and it will be applied once accepted.'
          : 'Describe what you would do and let the person decide.'),
    };
  }

  return { allowed: true };
}
