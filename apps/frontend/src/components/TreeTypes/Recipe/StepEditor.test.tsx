import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { StepEditor } from './StepEditor.js';
import type { ValidationCheckDefinition, CustomStepDefinition } from '../shared.js';

describe('StepEditor — conditional fields per step type', () => {
  it('shows only a path field for file-exists', () => {
    const step: ValidationCheckDefinition = { id: 'a', name: 'A', type: 'file-exists', target: 'README.md' };
    render(<StepEditor step={step} earlierNodes={[]} customSteps={[]} onChange={vi.fn()} />);
    expect(screen.getByText('Path')).toBeInTheDocument();
    expect(screen.queryByText('Pattern (regex)')).toBeNull();
    expect(screen.queryByText('Command')).toBeNull();
  });

  it('shows path and pattern for content-matches', () => {
    const step: ValidationCheckDefinition = { id: 'a', name: 'A', type: 'content-matches', target: 'x', pattern: 'y' };
    render(<StepEditor step={step} earlierNodes={[]} customSteps={[]} onChange={vi.fn()} />);
    expect(screen.getByText('Path')).toBeInTheDocument();
    expect(screen.getByText('Pattern (regex)')).toBeInTheDocument();
  });

  it('shows kind/namespace/resource name for k8s-probe', () => {
    const step: ValidationCheckDefinition = { id: 'a', name: 'A', type: 'k8s-probe', kind: 'pod', namespace: 'default', target: 'my-pod' };
    render(<StepEditor step={step} earlierNodes={[]} customSteps={[]} onChange={vi.fn()} />);
    expect(screen.getByText('Kind')).toBeInTheDocument();
    expect(screen.getByText('Namespace')).toBeInTheDocument();
    expect(screen.getByText('Resource name')).toBeInTheDocument();
  });

  it('shows the wrapped type\'s fields plus polling controls for wait-for', () => {
    const step: ValidationCheckDefinition = {
      id: 'a', name: 'A', type: 'wait-for', waitForType: 'http-probe', target: 'http://x/health', expectedStatus: 200,
    };
    render(<StepEditor step={step} earlierNodes={[]} customSteps={[]} onChange={vi.fn()} />);
    expect(screen.getByText('Wraps')).toBeInTheDocument();
    expect(screen.getByText('Expected status')).toBeInTheDocument(); // from the wrapped http-probe fields
    expect(screen.getByText('Poll every (ms)')).toBeInTheDocument();
    expect(screen.getByText('Give up after (ms)')).toBeInTheDocument();
  });

  it('only offers earlier steps as runIf targets', () => {
    const step: ValidationCheckDefinition = { id: 'c', name: 'C', type: 'run-command', command: 'x' };
    const earlier: ValidationCheckDefinition[] = [
      { id: 'a', name: 'Build', type: 'run-command', command: 'build' },
      { id: 'b', name: 'Lint', type: 'run-command', command: 'lint' },
    ];
    render(<StepEditor step={step} earlierNodes={earlier} customSteps={[]} onChange={vi.fn()} />);
    expect(screen.getByRole('option', { name: /Build passed/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Lint passed/ })).toBeInTheDocument();
  });

  it('switching type replaces type-specific fields but keeps the name', () => {
    const step: ValidationCheckDefinition = { id: 'a', name: 'My check', type: 'file-exists', target: 'x' };
    const onChange = vi.fn();
    render(<StepEditor step={step} earlierNodes={[]} customSteps={[]} onChange={onChange} />);

    fireEvent.change(screen.getByDisplayValue('File exists'), { target: { value: 'run-command' } });

    const patch = onChange.mock.calls[0]![0];
    expect(patch.type).toBe('run-command');
    expect(patch.id).toBe('a');
    expect(patch.command).toBeDefined();
  });

  describe('custom step type', () => {
    const lighthouse: CustomStepDefinition = {
      id: 'lighthouse', name: 'Lighthouse score', description: 'Checks a Lighthouse score.',
      fields: [{ key: 'url', label: 'URL', kind: 'string' }, { key: 'ci', label: 'CI mode', kind: 'boolean' }],
      command: 'lighthouse {{url}}',
    };

    it('renders a field per declared field on the chosen custom step definition', () => {
      const step: ValidationCheckDefinition = { id: 'a', name: 'A', type: 'custom', customStepId: 'lighthouse', params: { url: 'https://x.dev', ci: true } };
      render(<StepEditor step={step} earlierNodes={[]} customSteps={[lighthouse]} onChange={vi.fn()} />);
      expect(screen.getByText('URL')).toBeInTheDocument();
      expect(screen.getAllByText('CI mode').length).toBeGreaterThan(0);
      expect(screen.getAllByRole('checkbox')[0]).toBeChecked(); // the CI mode field, before the shared Optional checkbox
      expect(screen.getByDisplayValue('https://x.dev')).toBeInTheDocument();
    });

    it('picking a custom step type seeds params from its field defaults', () => {
      const withDefault: CustomStepDefinition = { ...lighthouse, fields: [{ key: 'url', label: 'URL', kind: 'string', defaultValue: 'https://default.dev' }] };
      const step: ValidationCheckDefinition = { id: 'a', name: 'A', type: 'custom' };
      const onChange = vi.fn();
      render(<StepEditor step={step} earlierNodes={[]} customSteps={[withDefault]} onChange={onChange} />);

      fireEvent.change(screen.getByDisplayValue('Pick one…'), { target: { value: 'lighthouse' } });
      const patch = onChange.mock.calls.at(-1)![0];
      expect(patch.customStepId).toBe('lighthouse');
      expect(patch.params).toEqual({ url: 'https://default.dev' });
    });

    it('disables the custom option in the type selector when no custom steps exist', () => {
      const step: ValidationCheckDefinition = { id: 'a', name: 'A', type: 'file-exists', target: 'x' };
      render(<StepEditor step={step} earlierNodes={[]} customSteps={[]} onChange={vi.fn()} />);
      const option = screen.getByRole('option', { name: /custom step \(none defined yet\)/i }) as HTMLOptionElement;
      expect(option.disabled).toBe(true);
    });
  });
});
