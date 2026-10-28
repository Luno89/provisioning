import { describe, expect, it } from 'vitest';
import { servingHeaders, SHOWN_PDF_POLICY, UNTRUSTED_FILE_POLICY } from './file-serving.js';

describe('serving a person\'s file', () => {
  it('never shows a file that could run script, whatever it calls itself, and lets it run none', () => {
    for (const [type, name] of [
      ['text/html', 'page.html'], ['image/svg+xml', 'logo.svg'], ['application/octet-stream', 'trick.html'],
      ['application/rss+xml', 'feed.rss'], ['application/atom+xml', 'feed'], ['text/xsl', 'style.xsl'],
      ['application/x-shockwave-flash', 'old.swf'], ['text/html; charset=utf-8', 'notes.txt'], ['TEXT/HTML', 'x'],
    ] as const) {
      const headers = servingHeaders(type, name, true);
      expect(headers['Content-Disposition'], type).toMatch(/^attachment;/);
      expect(headers['Content-Security-Policy'], type).toBe(UNTRUSTED_FILE_POLICY);
      expect(headers['X-Content-Type-Options'], type).toBe('nosniff');
    }
  });

  it('shows images, video, audio and text as themselves, never sniffed, still under the policy', () => {
    for (const type of ['image/png', 'image/jpeg', 'video/mp4', 'audio/mpeg', 'text/plain; charset=utf-8', 'text/csv', 'application/json']) {
      const headers = servingHeaders(type, 'f', true);
      expect(headers['Content-Disposition'], type).toBe("inline; filename*=UTF-8''f");
      expect(headers['Content-Security-Policy'], type).toBe(UNTRUSTED_FILE_POLICY);
    }
  });

  it('shows a PDF without the sandbox, which the browser\'s viewer refuses', () => {
    expect(servingHeaders('application/pdf', 'brief.pdf', true)).toEqual({ 'Content-Type': 'application/pdf', 'Content-Disposition': "inline; filename*=UTF-8''brief.pdf", 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': SHOWN_PDF_POLICY });
    expect(servingHeaders('application/pdf', 'brief.pdf', false)['Content-Security-Policy']).toBe(UNTRUSTED_FILE_POLICY);
  });

  it('downloads anything asked for as a download', () => {
    expect(servingHeaders('image/png', 'a b.png', false)['Content-Disposition']).toBe("attachment; filename*=UTF-8''a%20b.png");
  });

  it('sends only the type it judged, never what the uploader wrote, so a type that names two cannot become a page', () => {
    for (const raw of ['application/pdf;x=1,text/html', 'application/pdf, text/html', 'image/png\r\nX-Injected: 1', 'nonsense', '']) {
      const headers = servingHeaders(raw, 'f', true);
      expect(headers['Content-Type'], raw).not.toMatch(/html|,|\r|\n|X-Injected/i);
    }
    expect(servingHeaders('application/pdf;x=1,text/html', 'f.pdf', true)).toMatchObject({ 'Content-Type': 'application/pdf', 'Content-Disposition': "inline; filename*=UTF-8''f.pdf" });
    expect(servingHeaders('application/pdf, text/html', 'f.pdf', true)).toMatchObject({ 'Content-Type': 'application/octet-stream', 'Content-Security-Policy': UNTRUSTED_FILE_POLICY });
    expect(servingHeaders('Text/Plain; charset=latin1', 'f.txt', true)['Content-Type']).toBe('text/plain; charset=utf-8');
    expect(servingHeaders('text/html;charset=utf-8,image/png', 'f', true)).toMatchObject({ 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': UNTRUSTED_FILE_POLICY, 'Content-Disposition': "attachment; filename*=UTF-8''f" });
  });
});
