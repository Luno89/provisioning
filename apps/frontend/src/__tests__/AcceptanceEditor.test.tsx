import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import AcceptanceEditor from '../components/AcceptanceEditor';

/**
 * Setting a branch's acceptance plan by hand.
 *
 * ── THE DEAD END THIS ENDS ──
 * Nothing on a branch may be accepted until something would check the finished result — a rule
 * worth keeping, since the alternative is a run reporting success on pieces never assembled and
 * tried. But the plan was only ever set by the planner during planning, so a follow-up branch had
 * none, could accept nothing, and offered no way to fix it. Reported as "I can't click accept".
 *
 * A new branch inherits its tree's plan now. This is the way out when that inherited nothing, or
 * the wrong thing.
 */

const setup = (checks: any[] = [], onSave = vi.fn().mockResolvedValue(undefined)) => {
  render(<AcceptanceEditor checks={checks} onSave={onSave} />);
  return { onSave };
};

describe('a branch with no checks', () => {
  it('says the work cannot be accepted, which nothing said before', () => {
    setup([]);
    expect(screen.getByText(/nothing would verify this request/i)).toBeInTheDocument();
    expect(screen.getByText('Set checks')).toBeInTheDocument();
  });

  it('saves one command per line', async () => {
    const { onSave } = setup([]);
    fireEvent.click(screen.getByText('Set checks'));
    fireEvent.change(screen.getByLabelText('Commands'), {
      target: { value: 'npm ci && npm test\n\n  node src/cli.js Seattle  ' },
    });
    fireEvent.click(screen.getByText('Save checks'));
    // Blank lines dropped and each entry trimmed: a trailing newline is not a check.
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(['npm ci && npm test', 'node src/cli.js Seattle']));
  });
});

describe('a branch that already has checks', () => {
  it('offers to edit rather than set', () => {
    setup([{ name: 'suite', command: 'npm test' }]);
    expect(screen.getByText('Edit checks')).toBeInTheDocument();
    expect(screen.queryByText(/nothing would verify/i)).not.toBeInTheDocument();
  });

  it('seeds the form with what is there, so editing is a correction', () => {
    setup([{ name: 'suite', command: 'npm test' }, { name: 'runs', command: 'node cli.js' }]);
    fireEvent.click(screen.getByText('Edit checks'));
    expect(screen.getByLabelText('Commands')).toHaveValue('npm test\nnode cli.js');
  });

  it('reads a bare command string, which older branches contain', () => {
    // The API has always accepted one; a plan stored that way must still be editable.
    setup(['npm test']);
    fireEvent.click(screen.getByText('Edit checks'));
    expect(screen.getByLabelText('Commands')).toHaveValue('npm test');
  });
});

describe('when the server refuses', () => {
  it('shows its reason, not a generic failure', async () => {
    /**
     * The server rejects a check that cannot fail — `echo ok` satisfies the accept gate and proves
     * nothing, and it does not matter who typed it. That reason is the useful half of the refusal.
     */
    const onSave = vi.fn().mockRejectedValue({
      response: { data: { error: 'This check cannot fail, so running it proves nothing: `echo ok` always exits 0' } },
    });
    setup([], onSave);
    fireEvent.click(screen.getByText('Set checks'));
    fireEvent.change(screen.getByLabelText('Commands'), { target: { value: 'echo ok' } });
    fireEvent.click(screen.getByText('Save checks'));

    expect(await screen.findByText(/always exits 0/)).toBeInTheDocument();
    // Still open, holding what was typed: closing would discard the thing being corrected.
    expect(screen.getByLabelText('Commands')).toHaveValue('echo ok');
  });

  it('closes on success', async () => {
    const { onSave } = setup([]);
    fireEvent.click(screen.getByText('Set checks'));
    fireEvent.change(screen.getByLabelText('Commands'), { target: { value: 'npm test' } });
    fireEvent.click(screen.getByText('Save checks'));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByLabelText('Commands')).not.toBeInTheDocument());
  });
});

describe('what it refuses to send', () => {
  it('will not save an empty plan', () => {
    // An empty plan is the state this exists to escape; saving one would recreate it.
    const { onSave } = setup([]);
    fireEvent.click(screen.getByText('Set checks'));
    fireEvent.change(screen.getByLabelText('Commands'), { target: { value: '   \n  ' } });
    expect(screen.getByText('Save checks')).toBeDisabled();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('discards the draft on cancel', () => {
    setup([{ name: 'suite', command: 'npm test' }]);
    fireEvent.click(screen.getByText('Edit checks'));
    fireEvent.change(screen.getByLabelText('Commands'), { target: { value: 'rm -rf /' } });
    fireEvent.click(screen.getByText('Cancel'));
    fireEvent.click(screen.getByText('Edit checks'));
    expect(screen.getByLabelText('Commands')).toHaveValue('npm test');
  });
});
