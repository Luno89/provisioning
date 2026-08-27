import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ChatComposer from './ChatComposer.js';

const mockPack = { id: 'koala', name: 'Koala', label: 'KOALA', desc: 'General Builder' };

describe('ChatComposer — Modern floating capsule input', () => {
  it('renders placeholder, textarea input, and sends on Enter key', () => {
    const handleSend = vi.fn();
    const handleChange = vi.fn();

    render(
      <ChatComposer
        input="List all pods"
        onChangeInput={handleChange}
        onSend={handleSend}
        onStop={vi.fn()}
        isStreaming={false}
        activePack={mockPack}
        personaPacks={[mockPack]}
        onSelectPack={vi.fn()}
        onOpenPersonaDrawer={vi.fn()}
      />
    );

    const textarea = screen.getByPlaceholderText(/message koala/i);
    expect(textarea).toBeInTheDocument();

    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    expect(handleSend).toHaveBeenCalledWith('List all pods');
  });

  it('renders stop button when streaming is true', () => {
    const handleStop = vi.fn();

    render(
      <ChatComposer
        input=""
        onChangeInput={vi.fn()}
        onSend={vi.fn()}
        onStop={handleStop}
        isStreaming={true}
        activePack={mockPack}
        personaPacks={[mockPack]}
        onSelectPack={vi.fn()}
        onOpenPersonaDrawer={vi.fn()}
      />
    );

    const stopButton = screen.getByTitle(/stop generation/i);
    expect(stopButton).toBeInTheDocument();
    fireEvent.click(stopButton);
    expect(handleStop).toHaveBeenCalled();
  });
});
