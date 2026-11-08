import { statfs } from 'node:fs/promises';
import { freeBytes } from '../lib/file-room.js';

export const roomOn = (folder: string) => async (): Promise<number> => freeBytes(await statfs(folder));
