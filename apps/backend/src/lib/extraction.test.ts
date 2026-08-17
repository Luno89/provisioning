import { describe, it, expect } from 'vitest';
import {
  buildExtractionPrompt,
  parseExtractionResult,
  EXTRACTION_SCHEMA,
  EXTRACTION_TURN_WINDOW,
  EXTRACTION_CHAR_CAP,
  extractServiceName,
} from './extraction.js';

const turn = (role: string, content: string) => ({ role, content });

describe('buildExtractionPrompt', () => {
  it('renders the conversation with speakers labelled', () => {
    const p = buildExtractionPrompt([turn('user', 'Add rate limiting'), turn('assistant', 'Per-user or global?')]);
    expect(p).toContain('User: Add rate limiting');
    expect(p).toContain('Assistant: Per-user or global?');
  });

  it('keeps the TAIL of a long conversation', () => {
    // A plan is refined as it goes; the earliest turns are the vaguest, and the conclusion is
    // what the extractor actually needs.
    const many = Array.from({ length: 20 }, (_, i) => turn('user', `turn ${i}`));
    const p = buildExtractionPrompt(many);
    expect(p).toContain('turn 19');
    expect(p).not.toContain('turn 0:');
    expect(p.match(/turn \d+/g)!.length).toBeLessThanOrEqual(EXTRACTION_TURN_WINDOW);
  });

  it('drops system messages, which are instructions rather than conversation', () => {
    const p = buildExtractionPrompt([turn('system', 'SECRET PROMPT'), turn('user', 'hello')]);
    expect(p).not.toContain('SECRET PROMPT');
  });

  it('truncates from the front, so the conclusion survives', () => {
    const huge = 'x'.repeat(EXTRACTION_CHAR_CAP * 2);
    const p = buildExtractionPrompt([turn('user', huge), turn('assistant', 'FINAL ANSWER')]);
    expect(p).toContain('FINAL ANSWER');
    expect(p.length).toBeLessThan(EXTRACTION_CHAR_CAP + 200);
  });

  it('handles an empty or content-free conversation', () => {
    expect(() => buildExtractionPrompt([])).not.toThrow();
    expect(() => buildExtractionPrompt([turn('user', '   ')])).not.toThrow();
  });
});

describe('parseExtractionResult', () => {
  it('reads bare constrained JSON', () => {
    expect(parseExtractionResult('{"leaves":[{"title":"Add a rate limit","body":"On /api/chat"}]}', 8))
      .toEqual([{ title: 'Add a rate limit', body: 'On /api/chat' }]);
  });

  it('reads a fenced block, for when the engine ignored the schema', () => {
    expect(parseExtractionResult('```json\n{"leaves":[{"title":"Kept"}]}\n```', 8)).toEqual([{ title: 'Kept' }]);
  });

  it('treats an empty array as a real answer, not a failure', () => {
    // The extractor must be able to say "nothing was agreed" — without that it invents work.
    expect(parseExtractionResult('{"leaves":[]}', 8)).toEqual([]);
  });

  it('returns nothing for truncated or malformed output', () => {
    // A schema can be unsupported, silently ignored, or the model can hit its limit mid-object.
    // Inventing work from a broken parse is the one outcome worse than extracting nothing.
    expect(parseExtractionResult('{"leaves":[{"title":"Broken"', 8)).toEqual([]);
    expect(parseExtractionResult('I think you should add rate limiting.', 8)).toEqual([]);
    expect(parseExtractionResult('', 8)).toEqual([]);
  });

  it('drops entries with no usable title', () => {
    expect(parseExtractionResult('{"leaves":[{"body":"orphan"},{"title":" "},{"title":"Real"}]}', 8))
      .toEqual([{ title: 'Real' }]);
  });

  it('respects the caller\'s cap', () => {
    const many = JSON.stringify({ leaves: Array.from({ length: 30 }, (_, i) => ({ title: `L${i}` })) });
    expect(parseExtractionResult(many, 8).length).toBe(8);
  });

  it('truncates absurd fields rather than rejecting the entry', () => {
    const long = 'x'.repeat(10_000);
    const [p] = parseExtractionResult(JSON.stringify({ leaves: [{ title: long, body: long }] }), 8);
    expect(p!.title.length).toBeLessThanOrEqual(200);
    expect(p!.body!.length).toBeLessThanOrEqual(4000);
  });

  it('ignores a payload shaped like something else', () => {
    expect(parseExtractionResult('{"tasks":[{"title":"wrong key"}]}', 8)).toEqual([]);
    expect(parseExtractionResult('[]', 8)).toEqual([]);
  });
});

describe('EXTRACTION_SCHEMA', () => {
  it('permits an empty leaves array', () => {
    // If the schema forced at least one entry the extractor could not decline, and a model that
    // must return something will manufacture it.
    expect((EXTRACTION_SCHEMA.properties.leaves as any).minItems).toBeUndefined();
  });

  it('requires only a title, so a bodyless entry is still valid', () => {
    expect((EXTRACTION_SCHEMA.properties.leaves.items as any).required).toEqual(['title']);
  });
});

describe('the service name the planner declares', () => {
  /**
   * Without it the name fell back to the request id the deployment carries, so every tool a service
   * exposed was prefixed `koala-request-42784df9__` — the one part of the name that should say what
   * the thing IS said nothing.
   */
  it('reads a short name out of the plan block', () => {
    const reply = 'Here is the plan.\n```json\n{"leaves":[{"title":"Do it"}],"serviceName":"weather"}\n```';
    expect(extractServiceName(reply)).toBe('weather');
  });

  it('reads it from bare JSON too', () => {
    expect(extractServiceName('{"leaves":[],"serviceName":"github-api"}')).toBe('github-api');
  });

  it('rejects a sentence, so the tree name is used instead', () => {
    // Prefixing every tool with a description is worse than falling back to a name somebody chose.
    const reply = '```json\n{"leaves":[],"serviceName":"the service that wraps the weather API"}\n```';
    expect(extractServiceName(reply)).toBeUndefined();
  });

  it('is undefined when the planner said nothing', () => {
    // The common case: most work does not produce a callable service.
    expect(extractServiceName('```json\n{"leaves":[{"title":"Do it"}]}\n```')).toBeUndefined();
    expect(extractServiceName('just talking')).toBeUndefined();
    expect(extractServiceName('')).toBeUndefined();
  });
});
