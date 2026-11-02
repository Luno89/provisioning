import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import type { DocumentRead, DocumentService, OpenedDocument } from '../services/DocumentService.js';
import { TEST_USER } from '../../platform/routes/test-harness.js';
import { routesInProcess, type InProcessRoutes } from '../../platform/testing/routes.js';
import { documentsRouter } from './documents.js';

const opened: OpenedDocument = { workspace: 'conversation-c1', path: 'research/r1/findings.md', owner: 'koala-u1', repo: 'research-c1', ref: 'main', content: '# Findings' };

let documents: ReturnType<typeof mock<DocumentService>>;
let app: InProcessRoutes;

beforeEach(async () => {
  documents = mock<DocumentService>();
  app = await routesInProcess({ prefix: '/api/documents', router: () => documentsRouter({ documents }) });
});

describe('/api/documents', () => {
  it('opens the file the query names in the workspace the address names, for the signed-in person', async () => {
    const read: DocumentRead = { ok: true, document: opened };
    documents.read.mockResolvedValue(read);
    expect(await app.get('/api/documents/conversation-c1?path=research%2Fr1%2Ffindings.md')).toMatchObject({ status: 200, data: opened });
    expect(documents.read).toHaveBeenCalledWith(TEST_USER.id, 'conversation-c1', 'research/r1/findings.md', undefined);
  });

  it('reads at the commit the query names, and from the default when it names none or an empty one', async () => {
    documents.read.mockResolvedValue({ ok: true, document: opened });
    await app.get('/api/documents/tree-t1?path=a.md&at=c0ffee1');
    expect(documents.read).toHaveBeenLastCalledWith(TEST_USER.id, 'tree-t1', 'a.md', 'c0ffee1');
    await app.get('/api/documents/tree-t1?path=a.md&at=');
    expect(documents.read).toHaveBeenLastCalledWith(TEST_USER.id, 'tree-t1', 'a.md', undefined);
  });

  it('asks for the empty path when the query gives none, leaving the service to refuse it', async () => {
    documents.read.mockResolvedValue({ ok: false, status: 400, error: ' is not a path inside the workspace' });
    expect(await app.get('/api/documents/tree-t1')).toMatchObject({ status: 400 });
    expect(documents.read).toHaveBeenCalledWith(TEST_USER.id, 'tree-t1', '', undefined);
  });

  it('answers a refusal with the status and words the service gave', async () => {
    documents.read.mockResolvedValue({ ok: false, status: 404, error: 'research/r9/findings.md has not been saved to research-c1' });
    expect(await app.get('/api/documents/conversation-c1?path=research%2Fr9%2Ffindings.md')).toMatchObject({ status: 404, data: { error: 'research/r9/findings.md has not been saved to research-c1' } });
  });
});
