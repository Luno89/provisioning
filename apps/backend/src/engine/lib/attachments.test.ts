import { describe, expect, it } from 'vitest';
import { attachmentsText, readAttachments, type AttachableFile } from './attachments.js';

const projects = [{ id: 'p1', name: 'Shop' }];
const files: Record<string, AttachableFile> = {
  f1: { id: 'f1', path: 'chats/channel-p1/brief.pdf', size: 2048, contentType: 'application/pdf', projectId: 'p1' },
  f2: { id: 'f2', path: 'x.png', size: 3, contentType: 'image/png' },
  f3: { id: 'f3', path: 'theirs.pdf', size: 1, contentType: 'application/pdf', projectId: 'p9' },
};
const find = async (fileId: string): Promise<AttachableFile | undefined> => files[fileId];

describe('files attached to a message', () => {
  it('are read by their id from what the person keeps, named, sized and typed as kept, with their project', async () => {
    expect(await readAttachments([{ fileId: 'f1', name: 'ignored.txt', size: 1 }, { fileId: ' f2 ' }], find, projects)).toEqual({ ok: true, attachments: [
      { fileId: 'f1', name: 'brief.pdf', size: 2048, type: 'application/pdf', project: { id: 'p1', name: 'Shop' } },
      { fileId: 'f2', name: 'x.png', size: 3, type: 'image/png' },
    ] });
    expect(await readAttachments(undefined, undefined, projects)).toEqual({ ok: true, attachments: [] });
    expect(await readAttachments([], undefined, projects)).toEqual({ ok: true, attachments: [] });
  });

  it('refuses what is not a list, too many, an entry with no file id, a file the person does not keep, or one in another\'s project', async () => {
    expect(await readAttachments('f1', find, projects)).toEqual({ ok: false, why: 'attachments must be a list' });
    expect(await readAttachments(Array.from({ length: 21 }, () => ({ fileId: 'f2' })), find, projects)).toEqual({ ok: false, why: 'at most 20 files can be attached to one message' });
    expect(await readAttachments([{ path: 'x.png' }], find, projects)).toEqual({ ok: false, why: 'each attachment names the file it attaches by its fileId' });
    expect(await readAttachments(['f2'], find, projects)).toEqual({ ok: false, why: 'each attachment names the file it attaches by its fileId' });
    expect(await readAttachments([{ fileId: 'nope' }], find, projects)).toEqual({ ok: false, why: 'nope is not a file you keep' });
    expect(await readAttachments([{ fileId: 'f3' }], find, projects)).toEqual({ ok: false, why: 'f3 is kept in a project that is not yours' });
  });

  it('refuses attachments where no files can be reached', async () => {
    expect(await readAttachments([{ fileId: 'f2' }], undefined, projects)).toEqual({ ok: false, why: 'files cannot be attached to a message here' });
  });

  it('are told to the model with where each is and its id to read it by', () => {
    expect(attachmentsText([{ fileId: 'f1', name: 'brief.pdf', size: 2048, type: 'application/pdf', project: { id: 'p1', name: 'Shop' } }, { fileId: 'f2', name: 'x.png' }])).toBe(
      '\n\nAttached to this message (read each with read_stored_file, giving its file id as fileId):\n'
      + '- brief.pdf (application/pdf, 2.0 KB), in the project Shop\'s files, file id f1\n'
      + '- x.png, in the person\'s files, file id f2',
    );
    expect(attachmentsText([])).toBe('');
  });
});
