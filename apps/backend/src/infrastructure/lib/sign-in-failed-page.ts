const escaped = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

export function signInFailedPage(service: string, targetUrl: string, why: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escaped(service)}</title></head>`
    + '<body style="font-family:system-ui;background:#0f172a;color:#e2e8f0;padding:2rem">'
    + `<p>Koala could not sign you in to ${escaped(service)}: ${escaped(why)}</p>`
    + `<p><a href="${escaped(targetUrl)}">Open ${escaped(service)} and sign in yourself</a></p>`
    + '</body></html>';
}
