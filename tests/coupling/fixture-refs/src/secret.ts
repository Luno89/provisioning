export interface Secret {
  key: string;
  source: 'generated' | 'person';
}

export interface Feed {
  source: string;
}

export const declared: Secret[] = [{ key: 'A', source: 'generated' }];
