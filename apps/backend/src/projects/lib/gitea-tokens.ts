import type { Followed } from '@koala/engine-core/processes';

export interface TokenToRevoke {
  name: string;
  ownerId: string;
  username: string;
  process?: string | undefined;
  at: string;
}

export interface GiteaTokenPods {
  live(): Promise<readonly string[]>;
  whenGone(onGone: (pod: string) => void): Promise<Pick<Followed, 'ended' | 'stop'>>;
}

export const tokenKey = (token: Pick<TokenToRevoke, 'username' | 'name'>): string => `${token.username}/${token.name}`;

export const leftOver = (tokens: readonly TokenToRevoke[], live: readonly string[]): TokenToRevoke[] =>
  tokens.filter((token) => !token.process || !live.includes(token.process));
