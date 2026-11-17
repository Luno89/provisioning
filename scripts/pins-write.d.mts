export interface PinUse { file: string; pattern: string; arch?: string }
export interface PinComponent { name: string; version: string; source?: string; sha256?: string; sha512?: string; sha256s?: Record<string, string>; uses?: PinUse[]; shaUses?: PinUse[]; sourceUses?: PinUse[] }
export function pinsWritten(pins: { components: readonly PinComponent[] }, read: (file: string) => string): Map<string, string>;
