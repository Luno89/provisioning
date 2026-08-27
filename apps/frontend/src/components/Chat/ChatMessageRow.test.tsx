import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import ChatMessageRow from './ChatMessageRow.js';

describe('ChatMessageRow — User and Assistant turn rendering', () => {
  it('renders user message with You label and content', () => {
    render(<ChatMessageRow message={{ role: 'user', content: 'What is the cluster status?' }} />);
    expect(screen.getByText('You')).toBeInTheDocument();
    expect(screen.getByText('What is the cluster status?')).toBeInTheDocument();
  });

  it('renders assistant message with thinking disclosure and markdown', () => {
    render(
      <ChatMessageRow
        packLabel="KOALA"
        message={{
          role: 'assistant',
          content: 'Here is the **status** of the fleet.',
          reasoning: 'Checking node readiness across k3d clusters.',
        }}
      />
    );

    expect(screen.getByText('KOALA')).toBeInTheDocument();
    expect(screen.getByText(/Thought Process & Analysis/i)).toBeInTheDocument();
    expect(screen.getByText('Checking node readiness across k3d clusters.')).toBeInTheDocument();
    expect(screen.getByText('status')).toBeInTheDocument();
  });

  it('extracts <think> tags from content and puts them into the thinking disclosure', () => {
    render(
      <ChatMessageRow
        packLabel="KOALA"
        message={{
          role: 'assistant',
          content: '<think>Inspecting namespace system pods.</think>All pods are healthy.',
        }}
      />
    );

    expect(screen.getByText(/Thought Process & Analysis/i)).toBeInTheDocument();
    expect(screen.getByText('Inspecting namespace system pods.')).toBeInTheDocument();
    expect(screen.getByText('All pods are healthy.')).toBeInTheDocument();
  });
});
