import { describe, it, expect } from 'vitest';
import { EXPECTATIONS, SCENARIO_FIELDS, SCRIPT_LOOKUPS, SCRIPT_REPLY, SCRIPT_WHEN, STAGE_ACTIONS, STEP_FIELDS, WORLD_FIELDS, renderCheckGuide } from './check-guide.js';

const ALL = { SCENARIO_FIELDS, WORLD_FIELDS, EXPECTATIONS, STAGE_ACTIONS, STEP_FIELDS, SCRIPT_WHEN, SCRIPT_REPLY, SCRIPT_LOOKUPS };

describe('the guide a check writer works from', () => {
  it('gives only examples that read as JSON, since they will be copied', () => {
    for (const [table, entries] of Object.entries(ALL)) {
      for (const [key, entry] of Object.entries(entries)) {
        if (entry.example === undefined) continue;
        expect(() => JSON.parse(entry.example!), `${table}.${key}: ${entry.example}`).not.toThrow();
      }
    }
  });

  it('explains every part of a check, every expectation, stage action, script rule and lookup', () => {
    const guide = renderCheckGuide();
    for (const entries of Object.values(ALL)) {
      for (const key of Object.keys(entries)) expect(guide).toContain(`\`${key}\``);
    }
  });
});
