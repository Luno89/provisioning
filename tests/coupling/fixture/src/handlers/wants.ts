export interface Wants {
  pick?: ((id: string) => string) | undefined;
}

export const want = (wants: Wants): string => wants.pick?.('x') ?? '';
