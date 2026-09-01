import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ChatComposer from './ChatComposer.js';

const mockPack = { id: 'koala', name: 'Koala', label: 'KOALA', desc: 'General Builder' };

const base = {
  input: '',
  onChangeInput: vi.fn(),
  onSend: vi.fn(),
  onStop: vi.fn(),
  isStreaming: false,
  activePack: mockPack,
  onOpenPersonaDrawer: vi.fn(),
};

describe('ChatComposer — Modern floating capsule input', () => {
  it('renders placeholder, textarea input, and sends on Enter key', () => {
    const handleSend = vi.fn();
    render(<ChatComposer {...base} input="List all pods" onSend={handleSend} />);

    const textarea = screen.getByPlaceholderText(/message koala/i);
    expect(textarea).toBeInTheDocument();

    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    expect(handleSend).toHaveBeenCalledWith('List all pods');
  });

  it('renders stop button when streaming is true', () => {
    const handleStop = vi.fn();
    render(<ChatComposer {...base} isStreaming onStop={handleStop} />);

    const stopButton = screen.getByTitle(/stop generation/i);
    expect(stopButton).toBeInTheDocument();
    fireEvent.click(stopButton);
    expect(handleStop).toHaveBeenCalled();
  });
});

/**
 * The pack menu, the tool-count button and the drawer button were three separate controls that
 * all reached the same editor, and the model <select> beside them was never passed any models.
 */
describe('one control for who answers, one for what runs it', () => {
  it('reaches the persona editor from a single control carrying the pack and its tool count', () => {
    const onOpenPersonaDrawer = vi.fn();
    render(<ChatComposer {...base} onOpenPersonaDrawer={onOpenPersonaDrawer} toolCount={17} />);

    const control = screen.getByTitle(/pick the pack/i);
    expect(control).toHaveTextContent('Koala');
    expect(control).toHaveTextContent('17 tools');

    fireEvent.click(control);
    expect(onOpenPersonaDrawer).toHaveBeenCalled();
  });

  it('does not claim a tool count it was not given', () => {
    render(<ChatComposer {...base} />);
    expect(screen.getByTitle(/pick the pack/i)).not.toHaveTextContent(/tools/);
  });

  it('offers the model as its own control, naming what actually answers', () => {
    const onOpenModelDrawer = vi.fn();
    render(
      <ChatComposer
        {...base}
        modelLabel="[OpenRouter] anthropic/claude-opus-4"
        onOpenModelDrawer={onOpenModelDrawer}
      />,
    );

    const control = screen.getByTitle(/which model answers/i);
    expect(control).toHaveTextContent('anthropic/claude-opus-4');

    fireEvent.click(control);
    expect(onOpenModelDrawer).toHaveBeenCalled();
  });

  it('hides the model control where a surface does not offer one', () => {
    render(<ChatComposer {...base} />);
    expect(screen.queryByTitle(/which model answers/i)).not.toBeInTheDocument();
  });
});
