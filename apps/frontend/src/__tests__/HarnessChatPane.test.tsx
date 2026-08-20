import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import HarnessChatPane from '../components/harness-v2/HarnessChatPane';

vi.mock('axios');
const mockedAxios = vi.mocked(axios, true);

describe('HarnessChatPane (React Testing Framework)', () => {
  const mockApiBase = 'http://localhost:3001/api';
  const mockOnSelectTask = vi.fn();

  const mockConversations = [
    {
      id: 'hconv-1',
      title: 'Initial Planning Session',
      messages: [
        {
          id: 'msg-1',
          role: 'assistant',
          content: 'Hello! I am your Harness V2 Orchestrator.',
          createdAt: new Date().toISOString(),
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  ];

  const mockModels = [
    { id: 'ollama-qwen2.5-coder:7b', name: 'Ollama: qwen2.5-coder:7b', model: 'qwen2.5-coder:7b' },
    { id: 'Tabbyapi-Production', name: 'Tabbyapi-Production', model: 'turboderp/Qwen3.8-27B-exl3' },
  ];

  beforeEach(() => {
    vi.clearAllMocks();

    mockedAxios.get.mockImplementation((url: string) => {
      if (url.endsWith('/harness-v2/conversations')) {
        return Promise.resolve({ data: { success: true, conversations: mockConversations } } as any);
      }
      if (url.includes('/harness-v2/conversations/hconv-1')) {
        return Promise.resolve({ data: { success: true, conversation: mockConversations[0] } } as any);
      }
      if (url.endsWith('/models')) {
        return Promise.resolve({ data: mockModels } as any);
      }
      return Promise.resolve({ data: {} } as any);
    });

    mockedAxios.post.mockImplementation((url: string) => {
      if (url.includes('/messages')) {
        return Promise.resolve({
          data: {
            success: true,
            userMessage: { id: 'msg-u', role: 'user', content: 'Test prompt', createdAt: new Date().toISOString() },
            assistantMessage: {
              id: 'msg-a',
              role: 'assistant',
              content: 'Here is the plan and proposal.',
              reasoning: 'Deliberating architecture.',
              proposals: [
                {
                  id: 'prop-101',
                  title: 'Implement Rate Limiter',
                  description: 'Add token bucket limiter middleware',
                  personaId: 'coder',
                  budget: { maxTurns: 15, turnsCompleted: 0, maxTokens: 80000, tokensUsed: 0, allowAdaptiveExtension: true },
                  rubrics: [
                    { name: 'test_pass_rate', weight: 0.6, description: 'All unit tests pass' },
                    { name: 'code_quality', weight: 0.4, description: 'No dummy stubs' },
                  ],
                  status: 'proposed',
                  createdAt: new Date().toISOString(),
                },
              ],
              createdAt: new Date().toISOString(),
            },
          },
        } as any);
      }
      if (url.includes('/accept')) {
        return Promise.resolve({
          data: {
            success: true,
            task: { id: 'task-777', title: 'Implement Rate Limiter', status: 'running' },
          },
        } as any);
      }
      if (url.endsWith('/harness-v2/conversations')) {
        return Promise.resolve({
          data: {
            success: true,
            conversation: {
              id: 'hconv-2',
              title: 'New Planning Session',
              messages: [{ id: 'msg-new', role: 'assistant', content: 'Fresh session', createdAt: new Date().toISOString() }],
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          },
        } as any);
      }
      return Promise.resolve({ data: { success: true } } as any);
    });
  });

  it('renders initial session, conversation title, and fetches available models', async () => {
    render(<HarnessChatPane apiBase={mockApiBase} onSelectTask={mockOnSelectTask} />);

    await waitFor(() => {
      expect(screen.getAllByText('Initial Planning Session').length).toBeGreaterThan(0);
      expect(screen.getByText('Hello! I am your Harness V2 Orchestrator.')).toBeInTheDocument();
    });

    expect(mockedAxios.get).toHaveBeenCalledWith(
      `${mockApiBase}/harness-v2/conversations`,
      { withCredentials: true }
    );
    expect(mockedAxios.get).toHaveBeenCalledWith(
      `${mockApiBase}/models`,
      { withCredentials: true }
    );
  });

  it('submits chat message with selected model and dispatches POST request with credentials', async () => {
    render(<HarnessChatPane apiBase={mockApiBase} onSelectTask={mockOnSelectTask} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Ask anything/i)).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText(/Ask anything/i);
    const sendButton = screen.getByRole('button', { name: /Send/i });

    fireEvent.change(input, { target: { value: 'Implement token bucket rate limiter' } });
    expect(input).toHaveValue('Implement token bucket rate limiter');

    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(mockedAxios.post).toHaveBeenCalledWith(
        `${mockApiBase}/harness-v2/conversations/hconv-1/messages`,
        {
          content: 'Implement token bucket rate limiter',
          modelId: 'ollama-qwen2.5-coder:7b',
        },
        { withCredentials: true }
      );
    });
  });

  it('renders proposed task card and dispatches proposal acceptance on button click', async () => {
    const convWithProposal = {
      ...mockConversations[0],
      messages: [
        ...mockConversations[0].messages,
        {
          id: 'msg-prop',
          role: 'assistant',
          content: 'Here is the proposal.',
          proposals: [
            {
              id: 'prop-101',
              title: 'Implement Rate Limiter',
              description: 'Add token bucket limiter middleware',
              personaId: 'coder',
              budget: { maxTurns: 15, turnsCompleted: 0, maxTokens: 80000, tokensUsed: 0, allowAdaptiveExtension: true },
              rubrics: [
                { name: 'test_pass_rate', weight: 0.6, description: 'All unit tests pass' },
                { name: 'code_quality', weight: 0.4, description: 'No dummy stubs' },
              ],
              status: 'proposed' as const,
              createdAt: new Date().toISOString(),
            },
          ],
          createdAt: new Date().toISOString(),
        },
      ],
    };

    mockedAxios.get.mockImplementation((url: string) => {
      if (url.includes('/harness-v2/conversations/hconv-1')) {
        return Promise.resolve({ data: { success: true, conversation: convWithProposal } } as any);
      }
      if (url.endsWith('/harness-v2/conversations')) {
        return Promise.resolve({ data: { success: true, conversations: [convWithProposal] } } as any);
      }
      if (url.endsWith('/models')) {
        return Promise.resolve({ data: mockModels } as any);
      }
      return Promise.resolve({ data: {} } as any);
    });

    render(<HarnessChatPane apiBase={mockApiBase} onSelectTask={mockOnSelectTask} />);

    await waitFor(() => {
      expect(screen.getByText('Implement Rate Limiter')).toBeInTheDocument();
      expect(screen.getByText(/Add token bucket limiter middleware/i)).toBeInTheDocument();
      expect(screen.getByText('15 turns')).toBeInTheDocument();
      expect(screen.getByText('60%')).toBeInTheDocument();
      expect(screen.getByText('40%')).toBeInTheDocument();
    });

    const approveButton = screen.getByRole('button', { name: /Approve & Launch Task in Temporal/i });
    expect(approveButton).toBeInTheDocument();

    fireEvent.click(approveButton);

    await waitFor(() => {
      expect(mockedAxios.post).toHaveBeenCalledWith(
        `${mockApiBase}/harness-v2/conversations/hconv-1/proposals/prop-101/accept`,
        {},
        { withCredentials: true }
      );
      expect(mockOnSelectTask).toHaveBeenCalledWith('task-777');
    });
  });

  it('creates a new session when the New Session button is clicked', async () => {
    render(<HarnessChatPane apiBase={mockApiBase} onSelectTask={mockOnSelectTask} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /New/i })).toBeInTheDocument();
    });

    const newButton = screen.getByRole('button', { name: /New/i });
    fireEvent.click(newButton);

    await waitFor(() => {
      expect(mockedAxios.post).toHaveBeenCalledWith(
        `${mockApiBase}/harness-v2/conversations`,
        {},
        { withCredentials: true }
      );
    });
  });
});
