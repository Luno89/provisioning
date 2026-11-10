export const trustProxyFor = (env: Readonly<Record<string, string | undefined>>): number | 'loopback' =>
  env.NODE_ENV === 'production' ? 1 : 'loopback';
