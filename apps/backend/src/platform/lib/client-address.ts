export const trustProxyFor = (env: Readonly<Record<string, string | undefined>>): number | false =>
  env.NODE_ENV === 'production' ? 1 : false;
