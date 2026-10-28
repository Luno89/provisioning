import { describe, expect, it } from 'vitest';
import { lostCreateRace } from './apply-races.js';

describe('lostCreateRace', () => {
  it('is the controller making the namespace\'s default service account between apply\'s read and its create', () => {
    expect(lostCreateRace('Error from server (AlreadyExists): error when creating "STDIN": serviceaccounts "default" already exists')).toBe(true);
  });
  it('is not any other refusal', () => {
    expect(lostCreateRace('Error from server (Forbidden): serviceaccounts "default" is forbidden')).toBe(false);
    expect(lostCreateRace('error validating "STDIN": unknown field "imagePullSecret"')).toBe(false);
    expect(lostCreateRace('')).toBe(false);
  });
});
