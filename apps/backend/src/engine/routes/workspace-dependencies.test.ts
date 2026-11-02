import { beforeEach, describe, expect, it } from 'vitest';
import { matches, mock } from 'vitest-mock-extended';
import type { DependencyView, WorkspaceDependencyService } from '../services/WorkspaceDependencyService.js';
import { mountInProcess, PERSON, type InProcess } from '../testing/in-process.js';
import { workspaceDependenciesRouter } from './workspace-dependencies.js';

type Service = Pick<WorkspaceDependencyService, 'list' | 'save' | 'remove'>;

const body = { name: 'pdf-tools', summary: 'PDF tools.', provides: ['pdftotext'], install: [{ via: 'dnf', packages: ['poppler-utils'] }] };
const view: DependencyView = { name: 'pdf-tools', summary: 'PDF tools.', provides: ['pdftotext'], install: [{ via: 'dnf', packages: ['poppler-utils'] }], mine: true, script: false, usedBy: { tools: [], servers: [], dependencies: [], steps: [], trees: [] } };

let dependencies: ReturnType<typeof mock<Service>>;
let app: InProcess;

beforeEach(async () => {
  dependencies = mock<Service>();
  app = await mountInProcess({ prefix: '/api/workspace-dependencies', router: () => workspaceDependenciesRouter({ dependencies }) });
});

describe('/api/workspace-dependencies', () => {
  it('lists the signed-in person\'s catalogue', async () => {
    dependencies.list.calledWith(PERSON.id).mockResolvedValue([view]);
    expect(await app.get('/api/workspace-dependencies')).toMatchObject({ status: 200, data: { dependencies: [{ name: 'pdf-tools' }] } });
  });

  it('saves a dependency that names itself in the address, as the person', async () => {
    dependencies.save.calledWith(PERSON.id, matches((saved) => (saved as { name?: string }).name === 'pdf-tools')).mockResolvedValue({ saved: true, dependency: view });
    expect(await app.put('/api/workspace-dependencies/pdf-tools', body)).toMatchObject({ status: 200, data: { dependency: { name: 'pdf-tools', mine: true } } });
  });

  it('refuses a body that names another dependency, or is not one, before the service is asked', async () => {
    expect(await app.put('/api/workspace-dependencies/pdf-tools', { ...body, name: 'other' })).toMatchObject({ status: 400, data: { error: 'the dependency in the body is not called "pdf-tools"' } });
    const unread = await app.put<{ error: string; problems: string[] }>('/api/workspace-dependencies/pdf-tools', { name: 'pdf-tools', install: 'nothing' });
    expect(unread.status).toBe(400);
    expect(unread.data.problems).toEqual([unread.data.error]);
    expect(dependencies.save).not.toHaveBeenCalled();
  });

  it('answers a dependency that does not hold together with every problem', async () => {
    dependencies.save.mockResolvedValue({ saved: false, problems: ['pdf-tools has to say how it is installed', 'it provides nothing'] });
    expect(await app.put('/api/workspace-dependencies/pdf-tools', body)).toMatchObject({ status: 400, data: { error: 'pdf-tools has to say how it is installed; it provides nothing', problems: ['pdf-tools has to say how it is installed', 'it provides nothing'] } });
  });

  it('removes one nothing needs, and keeps one something does, saying why', async () => {
    dependencies.remove.calledWith(PERSON.id, 'free').mockResolvedValue({ removed: true });
    dependencies.remove.calledWith(PERSON.id, 'pdf-tools').mockResolvedValue({ removed: false, why: 'pdf-tools is still needed by the tool fetch_pdf' });
    expect(await app.delete('/api/workspace-dependencies/free')).toMatchObject({ status: 200, data: { ok: true } });
    expect(await app.delete('/api/workspace-dependencies/pdf-tools')).toMatchObject({ status: 409, data: { error: 'pdf-tools is still needed by the tool fetch_pdf' } });
  });
});
