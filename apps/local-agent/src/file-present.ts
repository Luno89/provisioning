import { access } from 'node:fs/promises';

export async function present(place: string, mode?: number): Promise<boolean> {
  try {
    await access(place, mode);
    return true;
  } catch {
    return false;
  }
}
