const escaped = (text: string): string => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export const signInRefusedPage = (error: string, again: string): string =>
  `<!doctype html><meta charset="utf-8"><title>Koala could not sign you in</title><body style="font-family:system-ui;padding:2rem"><p>Koala could not sign you in: ${escaped(error)}</p><p><a href="${escaped(again)}">Sign in again</a></p></body>`;
