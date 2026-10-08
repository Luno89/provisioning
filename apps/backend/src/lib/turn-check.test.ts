import { describe, it, expect } from 'vitest';
import { BUILDER_TOOLS } from '@koala/agent-engine';
import { describeChoice, scoreTurn, turnChoiceProblems, type ArgCheck, type TurnReply } from './turn-check.js';

const writeProcedure = BUILDER_TOOLS.find((tool) => tool.name === 'save_procedure')!;

const attempt = (over: Partial<TurnReply> = {}): TurnReply => ({
  toolCalls: [],
  content: '',
  ...over,
});

const calling = (name: string, args: unknown): TurnReply =>
  attempt({ toolCalls: [{ name, arguments: JSON.stringify(args) }] });
describe('scoring what the model did', () => {
  it('passes a correct call', () => {
    const verdict = scoreTurn(
      calling('save_procedure', { source: 'agent a v1' }),
      { tool: 'save_procedure' },
      writeProcedure,
    );

    expect(verdict.passed).toBe(true);
  });

  it('says what it answered instead of calling anything', () => {
    const verdict = scoreTurn(
      attempt({ content: 'I would start by considering the options available to us here.' }),
      { tool: 'save_procedure' },
      writeProcedure,
    );

    expect(verdict.complaint).toContain('called no tool, answered instead');
    expect(verdict.complaint).toContain('I would start by');
  });

  it('names what it called instead', () => {
    const verdict = scoreTurn(calling('read_procedure', { agent: 'x' }), { tool: 'save_procedure' }, writeProcedure);
    expect(verdict.complaint).toBe('called read_procedure instead of save_procedure');
  });

  it('catches a missing required argument and says what was sent', () => {
    const verdict = scoreTurn(calling('save_procedure', {}), { tool: 'save_procedure' }, writeProcedure);
    expect(verdict.complaint).toBe('called save_procedure without source (sent nothing)');
  });

  it('names what was sent when the required argument is missing, so a wrong name is obvious', () => {
    const verdict = scoreTurn(
      calling('save_procedure', { agentText: 'agent a v1' }),
      { tool: 'save_procedure' },
      writeProcedure,
    );

    expect(verdict.complaint).toBe('called save_procedure without source (sent agentText)');
  });

  it('catches an invented argument alongside the right one, which the schema did not offer', () => {
    const verdict = scoreTurn(
      calling('save_procedure', { source: 'agent a v1', overwrite: true }),
      { tool: 'save_procedure' },
      writeProcedure,
    );

    expect(verdict.complaint).toContain('invented arguments overwrite');
    expect(verdict.complaint).toContain('the schema offers source');
  });

  it('catches arguments that are not valid JSON', () => {
    const verdict = scoreTurn(
      attempt({ toolCalls: [{ name: 'save_procedure', arguments: '{not json' }] }),
      { tool: 'save_procedure' },
      writeProcedure,
    );

    expect(verdict.complaint).toContain('were not valid JSON');
  });

  it('passes when the wanted call is among several made', () => {
    const several = attempt({
      toolCalls: [
        { name: 'read_procedure', arguments: '{"agent":"x"}' },
        { name: 'save_procedure', arguments: '{"source":"agent a v1"}' },
      ],
    });

    expect(scoreTurn(several, { tool: 'save_procedure' }, writeProcedure).passed).toBe(true);
  });
});

describe('checking the arguments a case cares about', () => {
  const check = (args: unknown, expect_: Parameters<typeof scoreTurn>[1]) =>
    scoreTurn(calling('save_procedure', args), expect_, writeProcedure);

  it('matches an exact value', () => {
    expect(check({ source: 'a' }, { tool: 'save_procedure', args: [{ arg: 'source', is: 'a' }] }).passed).toBe(true);
    expect(check({ source: 'b' }, { tool: 'save_procedure', args: [{ arg: 'source', is: 'a' }] }).complaint)
      .toContain('wanted a');
  });

  it('matches a substring, and quotes what it wanted when it is missing', () => {
    const verdict = check(
      { source: 'agent other v1' },
      { tool: 'save_procedure', args: [{ arg: 'source', contains: 'agent tidy' }] },
    );

    expect(verdict.complaint).toContain('does not contain "agent tidy"');
    expect(verdict.complaint).toContain('agent other v1');
  });

  it('matches a pattern', () => {
    const ok = check(
      { source: 'agent a v1\n  loop  tool-rounds' },
      { tool: 'save_procedure', args: [{ arg: 'source', matches: 'loop\\s+tool-rounds' }] },
    );

    expect(ok.passed).toBe(true);
  });

  it('catches an argument sent empty', () => {
    expect(check({ source: '   ' }, { tool: 'save_procedure', args: [{ arg: 'source', nonEmpty: true }] }).complaint)
      .toContain('sent "source" empty');
  });

  it('matches boolean values case-insensitively whether string or boolean', () => {
    const boolTool = {
      name: 'list_tasks',
      description: 'list tasks',
      parameters: {
        type: 'object' as const,
        properties: { ready: { type: 'boolean' } },
      },
      failures: [],
    };
    const checkBool = (args: unknown, check_: ArgCheck) =>
      scoreTurn(calling('list_tasks', args), { tool: 'list_tasks', args: [check_] }, boolTool as any);

    expect(checkBool({ ready: true }, { arg: 'ready', is: 'true' }).passed).toBe(true);
    expect(checkBool({ ready: 'True' }, { arg: 'ready', is: 'true' }).passed).toBe(true);
    expect(checkBool({ ready: 'true' }, { arg: 'ready', is: 'true' }).passed).toBe(true);
    expect(checkBool({ ready: false }, { arg: 'ready', is: 'false' }).passed).toBe(true);
    expect(checkBool({ ready: 'False' }, { arg: 'ready', is: 'false' }).passed).toBe(true);
    expect(checkBool({ ready: false }, { arg: 'ready', is: 'true' }).complaint)
      .toContain('wanted true');
  });
});

describe('irrelevance, where the right move is to call nothing', () => {
  it('passes when it answers instead of reaching for a tool', () => {
    expect(scoreTurn(attempt({ content: 'An agent is the who; the loop is the how.' }), { tool: null }).passed)
      .toBe(true);
  });

  it('fails when it calls something anyway, and names it', () => {
    const verdict = scoreTurn(calling('save_procedure', { source: 'x' }), { tool: null });

    expect(verdict.passed).toBe(false);
    expect(verdict.complaint).toBe('called save_procedure when it should have called nothing and answered');
  });

  it('fails a silent attempt, so a dead endpoint cannot score a pass here', () => {
    const verdict = scoreTurn(attempt({ content: '' }), { tool: null });

    expect(verdict.passed).toBe(false);
    expect(verdict.complaint).toContain('answered nothing');
  });
});


describe('what a turn check may expect the model to choose', () => {
  it('takes a tool the catalogue has, with argument checks on its real arguments', () => {
    expect(turnChoiceProblems({ tool: 'save_procedure', args: [{ arg: 'source', nonEmpty: true }] }, [writeProcedure])).toEqual([]);
  });

  it('refuses a tool that does not exist, and an argument the tool does not take', () => {
    expect(turnChoiceProblems({ tool: 'nope' }, [writeProcedure])).toEqual(['it expects the model to choose nope, which is not a tool']);
    expect(turnChoiceProblems({ tool: 'save_procedure', args: [{ arg: 'sauce', nonEmpty: true }] }, [writeProcedure])).toEqual(['save_procedure has no argument called "sauce"']);
  });

  it('refuses argument checks on a turn that should call nothing, and a broken pattern', () => {
    expect(turnChoiceProblems({ tool: null, args: [{ arg: 'x', nonEmpty: true }] }, [])).toEqual(['a turn that chooses no tool has no arguments to check']);
    expect(turnChoiceProblems({ tool: 'save_procedure', args: [{ arg: 'source', matches: '(' }] }, [writeProcedure])).toEqual(['"(" is not a valid pattern']);
  });

  it('says what it checks in a line', () => {
    expect(describeChoice({ tool: null })).toBe('answers without calling a tool');
    expect(describeChoice({ tool: 'read_file', args: [{ arg: 'path', contains: 'a' } satisfies ArgCheck] })).toBe('chooses read_file with path right');
  });
});
