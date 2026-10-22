import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ChatHero from './ChatHero.js';

describe('ChatHero — Centered empty state hero', () => {
  it('renders greeting and all 4 starter prompt cards', () => {
    const handleSelect = vi.fn();
    render(<ChatHero packName="Koala" onSelectPrompt={handleSelect} />);

    expect(screen.getByText(/How can Koala help today\?/i)).toBeInTheDocument();
    expect(screen.getByText('Propose Project Tree')).toBeInTheDocument();
    expect(screen.getByText('Inspect Infrastructure')).toBeInTheDocument();
    expect(screen.getByText('Propose App Spec')).toBeInTheDocument();
    expect(screen.getByText('Fetch Diagnostics & Logs')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Propose Project Tree'));
    expect(handleSelect).toHaveBeenCalledWith(
      expect.stringContaining('Propose a new project architecture'),
    );
  });
});
