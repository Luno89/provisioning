export const lostCreateRace = (stderr: string): boolean => /\(AlreadyExists\)/.test(stderr) && /error when creating/.test(stderr);
