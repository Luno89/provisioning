export interface Needs {
  find?: ((id: string) => string) | undefined;
}

export function use(needs: Needs): string {
  return needs.find ? needs.find('a') : '';
}
