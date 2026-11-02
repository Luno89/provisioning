import { beforeEach, describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';
import { EXAMPLE_PROCEDURE, RESEARCH_V2, type TrackRecord } from '@koala/agent-engine/procedure';
import type { ProcedureService } from '../services/ProcedureService.js';
import { mountInProcess, PERSON, type InProcess } from '../testing/in-process.js';
import { proceduresRouter } from './procedures.js';

let procedures: ReturnType<typeof mock<ProcedureService>>;
let app: InProcess;

beforeEach(async () => {
  procedures = mock<ProcedureService>();
  app = await mountInProcess({ prefix: '/api/procedures', router: () => proceduresRouter({ procedures }) });
});

describe('/api/procedures', () => {
  it('lists the procedures the signed-in person can see', async () => {
    procedures.list.calledWith(PERSON.id).mockResolvedValue({ procedures: [], unreadable: [] });
    expect(await app.get('/api/procedures')).toMatchObject({ status: 200, data: { procedures: [], unreadable: [] } });
  });

  it('reads one in full, and says when there is none', async () => {
    procedures.get.calledWith(PERSON.id, 'research').mockResolvedValue({ procedure: RESEARCH_V2, mine: false });
    expect(await app.get('/api/procedures/research')).toMatchObject({ status: 200, data: { procedure: { id: 'research' }, mine: false } });
    expect(await app.get('/api/procedures/ghost')).toMatchObject({ status: 404, data: { error: 'There is no procedure with that id' } });
  });

  it('checks the body without saving it, and answers the problems', async () => {
    procedures.check.mockResolvedValue([{ severity: 'error', message: 'no way out', node: 'turn' }]);
    expect(await app.post('/api/procedures/check', EXAMPLE_PROCEDURE)).toMatchObject({ status: 200, data: { problems: [{ node: 'turn' }] } });
    expect(procedures.check).toHaveBeenCalledWith(PERSON.id, JSON.parse(JSON.stringify(EXAMPLE_PROCEDURE)));
    expect(procedures.save).not.toHaveBeenCalled();
  });

  it('saves the body under the id in the address, and answers the procedure with its problems', async () => {
    procedures.save.mockResolvedValue({ saved: true, procedure: RESEARCH_V2, problems: [{ severity: 'warning', message: 'long' }] });
    expect(await app.put('/api/procedures/quick-answer', EXAMPLE_PROCEDURE)).toMatchObject({ status: 200, data: { procedure: { id: 'research' }, problems: [{ message: 'long' }] } });
    expect(procedures.save).toHaveBeenCalledWith(PERSON.id, 'quick-answer', JSON.parse(JSON.stringify(EXAMPLE_PROCEDURE)));
  });

  it('refuses a procedure that does not check clean, with its problems', async () => {
    procedures.save.mockResolvedValue({ saved: false, problems: [{ severity: 'error', message: 'no way out' }] });
    expect(await app.put('/api/procedures/quick-answer', EXAMPLE_PROCEDURE)).toMatchObject({ status: 400, data: { error: 'The procedure does not check clean', problems: [{ message: 'no way out' }] } });
  });

  it('saves builder code under the id in the address, and refuses code that does not make a procedure', async () => {
    procedures.saveBuilderCode.mockResolvedValueOnce({ saved: true, procedure: RESEARCH_V2, problems: [] });
    expect(await app.put('/api/procedures/quick-answer/builder', { code: 'p.start()' })).toMatchObject({ status: 200, data: { procedure: { id: 'research' } } });
    expect(procedures.saveBuilderCode).toHaveBeenCalledWith(PERSON.id, 'quick-answer', 'p.start()');

    procedures.saveBuilderCode.mockResolvedValueOnce({ saved: false, problems: [{ severity: 'error', message: 'line 1, column 1: nope' }] });
    expect(await app.put('/api/procedures/quick-answer/builder', { code: 'x' })).toMatchObject({ status: 400, data: { error: 'The builder code does not make a procedure that checks clean', problems: [{ message: 'line 1, column 1: nope' }] } });
  });

  it('reports each model\'s track record on a procedure', async () => {
    const records: TrackRecord[] = [];
    procedures.trackRecords.calledWith(PERSON.id, 'research').mockResolvedValue(records);
    expect(await app.get('/api/procedures/research/track-record')).toMatchObject({ status: 200, data: { records: [] } });
  });

  it('deletes the person\'s own copy, and says when they have none', async () => {
    procedures.remove.calledWith(PERSON.id, 'research').mockResolvedValue(true);
    procedures.remove.calledWith(PERSON.id, 'ghost').mockResolvedValue(false);
    expect(await app.delete('/api/procedures/research')).toMatchObject({ status: 200, data: { ok: true } });
    expect(await app.delete('/api/procedures/ghost')).toMatchObject({ status: 404, data: { error: 'You have no copy of that procedure to delete' } });
  });
});
