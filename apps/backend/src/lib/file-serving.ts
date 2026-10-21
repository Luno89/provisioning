export const UNTRUSTED_FILE_POLICY = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox";

const ACTIVE = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/javascript|application\/javascript|application\/ecmascript)\b/i;

export function servingHeaders(contentType: string, name: string, inline: boolean): Record<string, string> {
  const active = ACTIVE.test(contentType) || /\.(html?|xhtml|svg|xml|js|mjs)$/i.test(name);
  return {
    'Content-Type': contentType,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff',
    ...(active ? { 'Content-Security-Policy': UNTRUSTED_FILE_POLICY } : {}),
  };
}
