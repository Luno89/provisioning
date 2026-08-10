import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import Markdown from '../components/Markdown';

/**
 * Every reply was rendered with `whitespace-pre-wrap`, so the model's most structured output came
 * out as its own syntax. Measured on a real reply: a comparison of five fields arrived as a
 * markdown table and displayed as rows of pipe characters.
 */
describe('rendering a reply', () => {
  it('renders a table, which is the case that read worst', () => {
    const md = [
      '| Field | Default |',
      '|---|---|',
      '| `initialInterval` | 1 second |',
    ].join('\n');
    const { container } = render(<Markdown>{md}</Markdown>);

    expect(container.querySelector('table')).toBeTruthy();
    expect(screen.getByText('initialInterval')).toBeTruthy();
    // Wide content scrolls in its own box rather than pushing the page sideways.
    expect(container.querySelector('.overflow-x-auto')).toBeTruthy();
  });

  it('renders headings and emphasis instead of their punctuation', () => {
    const { container } = render(<Markdown>{'## Retry policy\n\nAll fields are **optional**.'}</Markdown>);

    expect(container.querySelector('h2')?.textContent).toBe('Retry policy');
    expect(container.querySelector('strong')?.textContent).toBe('optional');
    expect(container.textContent).not.toContain('##');
  });

  it('renders lists', () => {
    const { container } = render(<Markdown>{'- one\n- two'}</Markdown>);
    expect(container.querySelectorAll('li')).toHaveLength(2);
  });

  it('distinguishes inline code from a fenced block', () => {
    const { container } = render(<Markdown>{'Use `npm test` first.\n\n```\nnode cli.js\n```'}</Markdown>);

    expect(container.querySelector('code')?.textContent).toBe('npm test');
    expect(container.querySelector('pre')).toBeTruthy();
  });
});

describe('rendering untrusted text', () => {
  it('shows raw HTML rather than parsing it', () => {
    /**
     * This renders model output and repository content the model quotes. Raw HTML is not enabled,
     * so a reply containing a script tag is text, not a tag.
     */
    const { container } = render(<Markdown>{'<script>alert(1)</script> and <b>bold</b>'}</Markdown>);

    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(container.textContent).toContain('alert(1)');
  });

  it('refuses a javascript: link', () => {
    // A crafted link in a reply must not become a click target.
    const { container } = render(<Markdown>{'[click](javascript:alert(1))'}</Markdown>);
    const href = container.querySelector('a')?.getAttribute('href') ?? '';

    expect(href.startsWith('javascript:')).toBe(false);
  });

  it('opens a model-chosen link without handing over a referrer', () => {
    const { container } = render(<Markdown>{'[docs](https://example.com)'}</Markdown>);
    const a = container.querySelector('a')!;

    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toContain('noreferrer');
  });

  it('survives half-written markdown, which is what streaming produces', () => {
    // Content arrives a token at a time, so every intermediate state is parsed.
    expect(() => render(<Markdown>{'| Field | Def'}</Markdown>)).not.toThrow();
    expect(() => render(<Markdown>{'## Unclosed **bold'}</Markdown>)).not.toThrow();
  });
});
