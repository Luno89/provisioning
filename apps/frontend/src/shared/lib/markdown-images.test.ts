import { describe, expect, it } from 'vitest';
import { imageHost, shownImage } from './markdown-images';

const ORIGIN = 'https://luno.nowrinkles.app';

describe('an image in what Koala or a person wrote', () => {
  it('is shown only from Koala itself, a blob the page made or a picture in the text', () => {
    expect(shownImage('/api/artifacts/a1/raw', ORIGIN)).toBe(true);
    expect(shownImage(`${ORIGIN}/api/files/x.png`, ORIGIN)).toBe(true);
    expect(shownImage(`blob:${ORIGIN}/6a1f`, ORIGIN)).toBe(true);
    expect(shownImage('data:image/png;base64,iVBORw0KGgo=', ORIGIN)).toBe(true);
  });

  it('never loads from anywhere else, so an address in the text cannot carry anything out by being shown', () => {
    for (const src of ['https://evil.example/pixel.png?secret=abc', '//evil.example/x.png', 'http://luno.nowrinkles.app/x.png', 'data:image/svg+xml;base64,PHN2Zz4=', 'blob:https://evil.example/1', 'javascript:alert(1)', undefined, '']) {
      expect(shownImage(src, ORIGIN), String(src)).toBe(false);
    }
    expect(imageHost('https://evil.example/pixel.png?secret=abc', ORIGIN)).toBe('evil.example');
  });
});
