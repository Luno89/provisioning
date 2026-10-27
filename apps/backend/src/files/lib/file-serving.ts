export const UNTRUSTED_FILE_POLICY = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox";

const SHOWN_INLINE = /^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/[a-z0-9.-]+|audio\/[a-z0-9.-]+|text\/(plain|csv|markdown)|application\/(json|pdf))$/;

const baseType = (contentType: string): string => (contentType.split(';')[0] ?? '').trim().toLowerCase();

export function servingHeaders(contentType: string, name: string, inline: boolean): Record<string, string> {
  const type = baseType(contentType);
  const shown = inline && SHOWN_INLINE.test(type);
  return {
    'Content-Type': contentType,
    'Content-Disposition': `${shown ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff',
    ...(shown && type === 'application/pdf' ? {} : { 'Content-Security-Policy': UNTRUSTED_FILE_POLICY }),
  };
}
