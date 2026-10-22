import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ChatComposer from './ChatComposer.js';

const mockPack = { id: 'koala', name: 'Koala', label: 'KOALA', desc: 'General Builder' };

const base = {
  onSend: vi.fn(),
  onStop: vi.fn(),
  isStreaming: false,
  activePack: mockPack,
  onOpenPersonaDrawer: vi.fn(),
};

describe('ChatComposer — Modern floating capsule input', () => {
  it('renders placeholder, textarea input, and sends on Enter key', () => {
    const handleSend = vi.fn();
    render(<ChatComposer {...base} onSend={handleSend} />);

    const textarea = screen.getByPlaceholderText(/message koala/i);
    expect(textarea).toBeInTheDocument();

    fireEvent.change(textarea, { target: { value: 'List all pods' } });
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

  it('keeps a typed draft instead of clearing it if Enter is pressed while a reply is still streaming', () => {
    const handleSend = vi.fn();
    render(<ChatComposer {...base} isStreaming onSend={handleSend} />);

    const textarea = screen.getByPlaceholderText(/message koala/i);
    fireEvent.change(textarea, { target: { value: 'a follow-up question' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });

    expect(handleSend).not.toHaveBeenCalled();
    expect(textarea).toHaveValue('a follow-up question');
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

    const control = screen.getByTitle(/pick who answers/i);
    expect(control).toHaveTextContent('Koala');
    expect(control).toHaveTextContent('17 tools');

    fireEvent.click(control);
    expect(onOpenPersonaDrawer).toHaveBeenCalled();
  });

  it('does not claim a tool count it was not given', () => {
    render(<ChatComposer {...base} />);
    expect(screen.getByTitle(/pick who answers/i)).not.toHaveTextContent(/tools/);
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

describe('ChatComposer — attachments', () => {
  it('picks files with the paperclip, shows each uploading, and waits for them before sending', () => {
    const onAttach = vi.fn();
    const onSend = vi.fn();
    const { rerender } = render(<ChatComposer {...base} onSend={onSend} onAttach={onAttach} attachments={[{ key: 'k1', name: 'brief.pdf', state: 'uploading', share: 0.4 }]} />);
    const file = new File(['x'], 'brief.pdf');
    fireEvent.change(screen.getByLabelText('Files to attach'), { target: { files: [file] } });
    expect(onAttach).toHaveBeenCalledWith([{ path: 'brief.pdf', file }]);
    expect(screen.getByText('40%')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send message' })).toBeDisabled();

    rerender(<ChatComposer {...base} onSend={onSend} onAttach={onAttach} attachments={[{ key: 'k1', name: 'brief.pdf', state: 'ready', share: 1 }]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    expect(onSend).toHaveBeenCalledWith('');
  });

  it('says why an attachment did not go, and lets it be removed', () => {
    const onRemoveAttachment = vi.fn();
    render(<ChatComposer {...base} onAttach={vi.fn()} onRemoveAttachment={onRemoveAttachment} attachments={[{ key: 'k1', name: 'big.zip', state: 'failed', share: 0, why: 'This project has no file server yet.' }]} />);
    expect(screen.getByTitle('Not attached: This project has no file server yet.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove big.zip' }));
    expect(onRemoveAttachment).toHaveBeenCalledWith('k1');
  });
});

