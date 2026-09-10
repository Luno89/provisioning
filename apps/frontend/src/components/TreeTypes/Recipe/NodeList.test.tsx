import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { NodeList } from './NodeList.js';
import type { RecipeNode } from '../shared.js';

const nodes = (): RecipeNode[] => [
  { id: 'a', name: 'First step', type: 'file-exists', target: 'README.md' },
  { id: 'b', name: 'Second step', type: 'run-command', command: 'npm test' },
];

describe('NodeList', () => {
  it('shows the empty state when there are no nodes', () => {
    render(<NodeList nodes={[]} customSteps={[]} onChange={vi.fn()} />);
    expect(screen.getByText(/no steps yet/i)).toBeInTheDocument();
  });

  it('adds a step of the selected type at the top level', () => {
    const onChange = vi.fn();
    render(<NodeList nodes={[]} customSteps={[]} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: /add step/i }));

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0]![0] as RecipeNode[];
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ type: 'run-command' });
  });

  it('adds a group at the top level and opens it for editing', () => {
    const onChange = vi.fn();
    render(<NodeList nodes={[]} customSteps={[]} onChange={onChange} />);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'group' } });
    fireEvent.click(screen.getByRole('button', { name: /add step/i }));

    const next = onChange.mock.calls[0]![0] as RecipeNode[];
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ containerType: 'group', children: [] });
  });

  it('adds a loop defaulting to count with a starter maxIterations', () => {
    const onChange = vi.fn();
    render(<NodeList nodes={[]} customSteps={[]} onChange={onChange} />);

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'loop' } });
    fireEvent.click(screen.getByRole('button', { name: /add step/i }));

    const next = onChange.mock.calls[0]![0] as RecipeNode[];
    expect(next[0]).toMatchObject({ containerType: 'loop', loopType: 'count', maxIterations: 3 });
  });

  it('removes a node and clears any runIf reference to it', () => {
    const onChange = vi.fn();
    const withDependent: RecipeNode[] = [
      ...nodes(),
      { id: 'c', name: 'Depends on first', type: 'run-command', command: 'smoke', runIf: 'a' },
    ];
    render(<NodeList nodes={withDependent} customSteps={[]} onChange={onChange} />);

    fireEvent.click(screen.getAllByTitle('Remove')[0]!); // remove "a"

    const next = onChange.mock.calls[0]![0] as RecipeNode[];
    expect(next.map((n) => n.id)).toEqual(['b', 'c']);
    expect(next.find((n) => n.id === 'c')?.runIf).toBeUndefined();
  });

  it('expands a leaf step to show its editor', () => {
    render(<NodeList nodes={nodes()} customSteps={[]} onChange={vi.fn()} />);
    expect(screen.queryByText(/^Path$/)).toBeNull();
    fireEvent.click(screen.getByText('First step'));
    expect(screen.getByText(/^Path$/)).toBeInTheDocument();
  });

  it('expands a group to show the group editor and its nested add-step row', () => {
    const withGroup: RecipeNode[] = [
      { id: 'g1', name: 'My group', containerType: 'group', children: [] },
    ];
    render(<NodeList nodes={withGroup} customSteps={[]} onChange={vi.fn()} />);
    fireEvent.click(screen.getByText('My group'));
    expect(screen.getByText(/no steps in this group yet/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /add step/i }).length).toBe(2);
  });

  it('expands a loop to show loop-kind-specific fields', () => {
    const withLoop: RecipeNode[] = [
      { id: 'l1', name: 'My loop', containerType: 'loop', loopType: 'forEach', itemsCommand: 'ls', children: [] },
    ];
    render(<NodeList nodes={withLoop} customSteps={[]} onChange={vi.fn()} />);
    fireEvent.click(screen.getByText('My loop'));
    expect(screen.getByText('Items command')).toBeInTheDocument();
  });

  it('adds a step inside an expanded group, not at the top level', () => {
    const onChange = vi.fn();
    const withGroup: RecipeNode[] = [
      { id: 'g1', name: 'My group', containerType: 'group', children: [] },
    ];
    render(<NodeList nodes={withGroup} customSteps={[]} onChange={onChange} />);
    fireEvent.click(screen.getByText('My group'));

    const addButtons = screen.getAllByRole('button', { name: /add step/i });
    fireEvent.click(addButtons[0]!);

    const next = onChange.mock.calls[0]![0] as RecipeNode[];
    const group = next[0] as Extract<RecipeNode, { containerType: 'group' }>;
    expect(group.children).toHaveLength(1);
  });

  it('disables the custom step option when no custom step types are defined', () => {
    render(<NodeList nodes={[]} customSteps={[]} onChange={vi.fn()} />);
    const option = screen.getByRole('option', { name: /custom step/i }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
  });

  it('shows a branch indicator naming the earlier node a runIf-conditional node depends on', () => {
    const withBranch: RecipeNode[] = [
      ...nodes(),
      { id: 'c', name: 'Deploy check', type: 'run-command', command: 'x', runIf: 'a' },
    ];
    render(<NodeList nodes={withBranch} customSteps={[]} onChange={vi.fn()} />);
    expect(screen.getByText(/runs only if/i)).toBeInTheDocument();
  });

  it('does not show a branch indicator when runIf just points at the immediately preceding sibling', () => {
    const sequential: RecipeNode[] = [
      ...nodes(),
      { id: 'c', name: 'Follows second', type: 'run-command', command: 'x', runIf: 'b' },
    ];
    render(<NodeList nodes={sequential} customSteps={[]} onChange={vi.fn()} />);
    expect(screen.queryByText(/runs only if/i)).toBeNull();
  });

  it('offers a node inside an earlier group as a runIf target for a later top-level node', () => {
    const tree: RecipeNode[] = [
      { id: 'g1', name: 'Group', containerType: 'group', children: [{ id: 'inner', name: 'Inner step', type: 'run-command', command: 'x' }] },
      { id: 'after', name: 'After', type: 'run-command', command: 'y' },
    ];
    render(<NodeList nodes={tree} customSteps={[]} onChange={vi.fn()} />);
    fireEvent.click(screen.getByText('After'));
    const runIfSelect = screen.getAllByRole('combobox').find((el) => within(el).queryByText(/inner step passed/i));
    expect(runIfSelect).toBeTruthy();
  });
});
