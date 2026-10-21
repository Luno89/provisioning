import { describe, expect, it } from 'vitest';
import { attachmentsText, readAttachments } from './attachments.js';

const projects = [{ id: 'p1', name: 'Shop' }];

describe('files attached to a message', () => {
  it('are read with their project, kept inside the files, and checked to be the person\'s', () => {
    expect(readAttachments([{ path: '/attachments//brief.pdf', name: 'brief.pdf', size: 2048, type: 'application/pdf', projectId: 'p1' }, { path: 'chats/c1/x.png' }], projects)).toEqual({ ok: true, attachments: [
      { name: 'brief.pdf', path: 'attachments/brief.pdf', size: 2048, type: 'application/pdf', project: { id: 'p1', name: 'Shop' } },
      { name: 'x.png', path: 'chats/c1/x.png' },
    ] });
    expect(readAttachments(undefined, projects)).toEqual({ ok: true, attachments: [] });
    expect(readAttachments([{ path: '../x' }], projects)).toMatchObject({ ok: false });
    expect(readAttachments([{ path: 'x', projectId: 'p9' }], projects)).toEqual({ ok: false, why: 'p9 is not one of your projects' });
    expect(readAttachments(Array.from({ length: 21 }, () => ({ path: 'x' })), projects)).toMatchObject({ ok: false });
  });

  it('are told to the model as where each is and how to read it', () => {
    expect(attachmentsText([{ name: 'brief.pdf', path: 'attachments/brief.pdf', size: 2048, type: 'application/pdf', project: { id: 'p1', name: 'Shop' } }, { name: 'x.png', path: 'chats/c1/x.png' }])).toBe(
      '\n\nAttached to this message (read each with read_stored_file, naming the project and the path):\n'
      + '- brief.pdf (application/pdf, 2.0 KB), in the project Shop\'s files at attachments/brief.pdf\n'
      + '- x.png, in the person\'s own files at chats/c1/x.png',
    );
    expect(attachmentsText([])).toBe('');
  });
});
