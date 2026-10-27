export const UNTRUSTED_FILE_POLICY = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox";

const SHOWN_INLINE = /^(image\/(png|jpeg|gif|webp|avif|bmp)|video\/[a-z0-9.-]+|audio\/[a-z0-9.-]+|text\/(plain|csv|markdown)|application\/(json|pdf))$/;

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

export function servedType(contentType: string): string {
  const type = (contentType.split(';')[0] ?? '').trim().toLowerCase();
  if (!MEDIA_TYPE.test(type)) return 'application/octet-stream';
  return type.startsWith('text/') ? `${type}; charset=utf-8` : type;
}

export function servingHeaders(contentType: string, name: string, inline: boolean): Record<string, string> {
  const served = servedType(contentType);
  const type = served.split(';')[0]!;
  const shown = inline && SHOWN_INLINE.test(type);
  return {
    'Content-Type': served,
    'Content-Disposition': `${shown ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-Type-Options': 'nosniff',
    ...(shown && type === 'application/pdf' ? {} : { 'Content-Security-Policy': UNTRUSTED_FILE_POLICY }),
  };
}
