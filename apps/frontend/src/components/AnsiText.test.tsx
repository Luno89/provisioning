import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { AnsiText } from './AnsiText';

describe('AnsiText Component', () => {
  it('strips ANSI cursor movement artifacts like [2K[1A[G', () => {
    const rawLog = '[2K[1A[2K[1A[2K[1A[2K[GLunorica-local  kubernetes_namespace.monitoring_monitoring-ns_DCC445AB: Creating...';
    render(<AnsiText text={rawLog} />);

    expect(screen.getByText(/Lunorica-local/i)).toBeInTheDocument();
    expect(screen.queryByText(/\[2K/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\[1A/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\[G/i)).not.toBeInTheDocument();
  });

  it('renders syntax highlighting for Terraform diff additions', () => {
    const rawLog = '+ resource "kubernetes_namespace" "monitoring" {\n  + name = "monitoring"\n}';
    const { container } = render(<AnsiText text={rawLog} />);

    const styledDiv = container.querySelector('div');
    expect(styledDiv).toBeInTheDocument();
    expect(styledDiv?.style.color).toBe('rgb(74, 222, 128)'); // #4ade80
  });

  it('parses explicit ANSI color escape codes', () => {
    const rawLog = '\x1b[32mSuccess!\x1b[0m';
    const { container } = render(<AnsiText text={rawLog} />);

    const span = container.querySelector('span');
    expect(span).toBeInTheDocument();
    expect(span?.style.color).toBe('rgb(74, 222, 128)'); // #4ade80
  });

  it('replaces consecutive stack progress status lines in-place', () => {
    const rawLog = '1 Stack deploying 0 Stacks done 0 Stacks waiting\n1 Stack deploying 1 Stacks done 0 Stacks waiting';
    render(<AnsiText text={rawLog} />);

    expect(screen.getByText(/1 Stacks done/i)).toBeInTheDocument();
    expect(screen.queryByText(/0 Stacks done/i)).not.toBeInTheDocument();
  });

  it('collapses raw Braille CLI spinner frame updates into a single status line', () => {
    const rawLog = '⠋ Starting\n \n⠇\n⠋ Synthesizing\n \n⠇\n⠙ Synthesizing\n \n⠇\n⠹ Synthesizing';
    const { container } = render(<AnsiText text={rawLog} />);

    const divs = container.querySelectorAll('div');
    expect(divs.length).toBe(1);
    expect(screen.getByText(/Synthesizing/i)).toBeInTheDocument();
    expect(screen.queryByText(/Starting/i)).not.toBeInTheDocument();
  });
});
