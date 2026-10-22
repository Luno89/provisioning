import { describe, it, expect } from 'vitest';
import { explainJsonError } from './json-error.js';

const why = (text: string): string => {
  try {
    JSON.parse(text);
    return 'it parsed';
  } catch (err) {
    return explainJsonError(text, (err as Error).message);
  }
};

describe('saying exactly what is wrong with JSON a model sent', () => {
  it('points at a bracket that closes the wrong thing, says what is open there, and shows the text around it', () => {
    const said = why('[{"title": "a", "leaves": [{"key": "x", "checks": {"run": "ok"}}]}}, {"title": "b"}]');
    expect(said).toContain('a } at character');
    expect(said).toContain('the innermost thing still open there is a list');
    expect(said).toContain('⟪here⟫}, {"title": "b"}');
  });

  it('is not fooled by brackets and escaped quotes inside strings', () => {
    expect(why('[{"body": "test \\"$(node greet.js)\\" = [ok] {x}"}, {"title": "b"]')).toContain('a ] at character');
  });

  it('says when something is closed that was never opened, or opened and never closed', () => {
    expect(why('[1, 2]]')).toContain('closes a list that was never opened');
    expect(why('[{"leaves": [1, 2}')).toContain('a } at character');
    expect(why('[{"leaves": [1, 2]')).toContain('2 brackets never closed — the last one opened is an object');
    expect(why('["unterminated')).toContain('a string is never closed');
  });

  it('falls back to where the parser stopped when the brackets are fine', () => {
    expect(why('[1 2]')).toMatch(/position 3.*\[1 ⟪here⟫2\]/);
  });
});
