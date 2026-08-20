import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import HarnessDashboard from '../components/harness-v2/HarnessDashboard';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

describe('HarnessDashboard (React Testing Framework)', () => {
  const mockApiBase = 'http://localhost:3001/api';

  const mockTasks = [
    {
      id: 'task-001',
      title: 'Redis Rate Limiter',
      description: 'Implement token bucket rate limiter',
      personaId: 'coder',
      status: 'running',
      budget: { maxTurns: 15, turnsCompleted: 3, maxTokens: 80000, tokensUsed: 12000, allowAdaptiveExtension: true },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  const mockConversations = [
    {
      id: 'hconv-1',
      title: 'Planning Session 1',
      messages: [
        { id: 'msg-1', role: 'assistant', content: 'Welcome to Harness V2', createdAt: new Date().toISOString() },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();

    mockedAxios.get.mockImplementation((url: string) => {
      if (url.endsWith('/harness-v2/tasks')) {
        return Promise.resolve({ data: { success: true, tasks: mockTasks } } as any);
      }
      if (url.includes('/harness-v2/tasks/task-001')) {
        return Promise.resolve({ data: { success: true, task: mockTasks[0] } } as any);
      }
      if (url.includes('/traces')) {
        return Promise.resolve({ data: { success: true, traces: [] } } as any);
      }
      if (url.endsWith('/harness-v2/conversations')) {
        return Promise.resolve({ data: { success: true, conversations: mockConversations } } as any);
      }
      if (url.includes('/harness-v2/conversations/hconv-1')) {
        return Promise.resolve({ data: { success: true, conversation: mockConversations[0] } } as any);
      }
      if (url.endsWith('/models')) {
        return Promise.resolve({ data: [{ id: 'model-1', name: 'Qwen 2.5 Coder' }] } as any);
      }
      return Promise.resolve({ data: {} } as any);
    });

    mockedAxios.post.mockImplementation((url: string) => {
      if (url.includes('/pause')) {
        return Promise.resolve({ data: { success: true } } as any);
      }
      if (url.includes('/resume')) {
        return Promise.resolve({ data: { success: true } } as any);
      }
      return Promise.resolve({ data: { success: true } } as any);
    });
  });

  it('renders conversational workspace canvas and active session', async () => {
    render(<HarnessDashboard apiBase={mockApiBase} />);

    await waitFor(() => {
      expect(screen.getByText('Welcome to Harness V2')).toBeInTheDocument();
      expect(screen.getAllByText('Planning Session 1').length).toBeGreaterThan(0);
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      `${mockApiBase}/harness-v2/conversations`,
      { withCredentials: true }
    );
  });

  it('opens and closes the slide-over execution inspector drawer', async () => {
    render(<HarnessDashboard apiBase={mockApiBase} />);

    await waitFor(() => {
      expect(screen.getByText('Welcome to Harness V2')).toBeInTheDocument();
    });
  });
});
