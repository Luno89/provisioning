import { describe, expect, it } from 'vitest';
import { servingHeaders, UNTRUSTED_FILE_POLICY } from './file-serving.js';

describe('serving a person\'s file', () => {
  it('lets a file that could run script run none, whatever it calls itself', () => {
    expect(servingHeaders('text/html', 'page.html', true)['Content-Security-Policy']).toBe(UNTRUSTED_FILE_POLICY);
    expect(servingHeaders('image/svg+xml', 'logo.svg', true)['Content-Security-Policy']).toBe(UNTRUSTED_FILE_POLICY);
    expect(servingHeaders('application/octet-stream', 'trick.html', true)['Content-Security-Policy']).toBe(UNTRUSTED_FILE_POLICY);
  });

  it('shows a PDF, an image or a video as itself, never sniffed', () => {
    const pdf = servingHeaders('application/pdf', 'brief.pdf', true);
    expect(pdf).toEqual({ 'Content-Type': 'application/pdf', 'Content-Disposition': "inline; filename*=UTF-8''brief.pdf", 'X-Content-Type-Options': 'nosniff' });
    expect(servingHeaders('image/png', 'a b.png', false)['Content-Disposition']).toBe("attachment; filename*=UTF-8''a%20b.png");
  });
});
