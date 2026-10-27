const RASTER_DATA = /^data:image\/(png|jpeg|gif|webp|avif|bmp)[;,]/i;

export function shownImage(src: string | undefined, origin: string): boolean {
  if (!src) return false;
  if (RASTER_DATA.test(src)) return true;
  let url: URL;
  try {
    url = new URL(src, origin);
  } catch {
    return false;
  }
  return url.protocol === 'blob:' ? url.origin === origin || src.startsWith(`blob:${origin}/`) : url.origin === origin;
}

export function imageHost(src: string, origin: string): string {
  try {
    return new URL(src, origin).host || src;
  } catch {
    return src;
  }
}
