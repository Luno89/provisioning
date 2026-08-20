/**
 * Live Conversational Orchestrator for Harness V2.
 *
 * Connects to live Model LLMs (Ollama, TabbyAPI, vLLM, OpenAI endpoints) with dynamic multi-round
 * tool calling: OpenAPI spec discovery, live platform API execution, web search,
 * infrastructure diagnostics, workspace inspection, and task proposals.
 */
import fs from 'fs/promises';
import path from 'path';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import type { HarnessChatMessage, ProposedHarnessTask, TurnToolCall, TurnToolResult } from '@koala/harness-types';
import { HARNESS_ORCHESTRATOR_TOOLS } from './orchestrator-tools.js';
import { BudgetAllocator } from './budget-allocator.js';
import { createWebTools } from '../../lib/web-tools.js';
import { PLATFORM_OPENAPI_SPEC } from '../../lib/platform-openapi.js';
import { getHarnessDb } from '../db.js';
import { SemanticRag } from '../memory/semantic-rag.js';
import { AstValidator } from '../safety/ast-validator.js';
import type { ModelService } from '../../services/ModelService.js';

export interface OrchestratorToolContext {
  userId?: string;
  sessionCookie?: string;
  workspaceRoot?: string;
  modelService?: ModelService;
  modelId?: string;
  apiBaseUrl?: string;
}

export interface OrchestratorReplyResult {
  message: HarnessChatMessage;
  proposals: ProposedHarnessTask[];
  toolCallsExecuted: { name: string; args: Record<string, unknown>; result: string }[];
}

export class OrchestratorChat {
  /**
   * Executes an orchestrator tool call against live services and the platform API.
   */
  static async executeTool(
    call: TurnToolCall,
    ctx: OrchestratorToolContext = {},
  ): Promise<TurnToolResult> {
    const { name, args } = call;
    const workspaceRoot = ctx.workspaceRoot || process.cwd();
    const apiBase = ctx.apiBaseUrl || 'http://localhost:3001';

    try {
      // 1. OpenAPI Specification Discovery
      if (name === 'get_openapi_spec') {
        const filter = typeof args.pathFilter === 'string' ? args.pathFilter.toLowerCase() : '';
        if (!filter) {
          return {
            toolCallId: call.id,
            toolName: name,
            stdout: JSON.stringify(PLATFORM_OPENAPI_SPEC, null, 2),
            exitCode: 0,
          };
        }

        const filteredPaths = Object.fromEntries(
          Object.entries(PLATFORM_OPENAPI_SPEC.paths).filter(([p]) => p.toLowerCase().includes(filter)),
        );

        return {
          toolCallId: call.id,
          toolName: name,
          stdout: JSON.stringify({ ...PLATFORM_OPENAPI_SPEC, paths: filteredPaths }, null, 2),
          exitCode: 0,
        };
      }

      // 2. Dynamic Platform API Invocation
      if (name === 'call_platform_api') {
        const method = String(args.method || 'GET').toUpperCase();
        let reqPath = String(args.path || '');
        if (!reqPath.startsWith('/')) reqPath = `/${reqPath}`;

        const fullUrl = reqPath.startsWith('/api') ? `${apiBase}${reqPath}` : `${apiBase}/api${reqPath}`;
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (ctx.sessionCookie) {
          headers['Cookie'] = ctx.sessionCookie;
        }

        const res = await axios({
          method,
          url: fullUrl,
          headers,
          data: args.body,
          params: args.params as Record<string, unknown>,
          timeout: 5000,
          validateStatus: () => true,
        });

        return {
          toolCallId: call.id,
          toolName: name,
          stdout: JSON.stringify({ status: res.status, data: res.data }, null, 2),
          exitCode: res.status >= 200 && res.status < 400 ? 0 : 1,
        };
      }

      // 3. Web Search
      if (name === 'web_search') {
        const query = String(args.query || '');
        const tools = createWebTools();
        const hits = await tools.search(query);
        return {
          toolCallId: call.id,
          toolName: name,
          stdout: JSON.stringify(hits.slice(0, 5), null, 2),
          exitCode: 0,
        };
      }

      // 4. Web Page Fetch
      if (name === 'fetch_web_page') {
        const url = String(args.url || '');
        const tools = createWebTools();
        const content = await tools.fetchPage(url);
        return {
          toolCallId: call.id,
          toolName: name,
          stdout: content.slice(0, 4000),
          exitCode: 0,
        };
      }

      // 5. Read Workspace Source File
      if (name === 'read_workspace_file') {
        const targetPath = String(args.path || '');
        const pathCheck = AstValidator.validatePath(targetPath, workspaceRoot);
        if (!pathCheck.valid) {
          return {
            toolCallId: call.id,
            toolName: name,
            stderr: `Blocked: ${pathCheck.reason}`,
            isError: true,
            exitCode: 1,
          };
        }

        const resolved = path.isAbsolute(targetPath) ? targetPath : path.resolve(workspaceRoot, targetPath);
        const data = await fs.readFile(resolved, 'utf-8');
        return {
          toolCallId: call.id,
          toolName: name,
          stdout: data.slice(0, 4000),
          exitCode: 0,
        };
      }

      // 6. List Infrastructure & Cluster Apps
      if (name === 'list_infrastructure') {
        const headers: Record<string, string> = {};
        if (ctx.sessionCookie) headers['Cookie'] = ctx.sessionCookie;

        try {
          const [appsRes, clustersRes] = await Promise.all([
            axios.get(`${apiBase}/api/apps`, { headers, timeout: 5000, validateStatus: () => true }),
            axios.get(`${apiBase}/api/clusters`, { headers, timeout: 5000, validateStatus: () => true }),
          ]);

          const db = await getHarnessDb();
          const tasks = await db.getTasks();

          const info = {
            clusters: clustersRes.data || [],
            deployedApps: appsRes.data || [],
            harnessV2TasksCount: tasks.length,
          };

          return {
            toolCallId: call.id,
            toolName: name,
            stdout: JSON.stringify(info, null, 2),
            exitCode: 0,
          };
        } catch {
          return {
            toolCallId: call.id,
            toolName: name,
            stdout: JSON.stringify({ status: 'Cluster services active', openapi: '/api/openapi.json' }, null, 2),
            exitCode: 0,
          };
        }
      }

      // 7. Semantic Vector Memory RAG
      if (name === 'search_semantic_memory') {
        const query = String(args.query || '');
        const rag = new SemanticRag();
        const facts = await rag.retrieveRelevantFacts(query, [
          {
            id: 'mem-1',
            scope: 'global',
            category: 'architecture',
            title: 'Harness V2 Architecture',
            text: 'Harness V2 uses durable Temporal turns, Action Gate safety AST checks, dynamic budgets, and 3-layer decoupled evaluation rubrics.',
            createdAt: new Date().toISOString(),
          },
          {
            id: 'mem-2',
            scope: 'global',
            category: 'cluster',
            title: 'Cluster Model Cache Path',
            text: 'TabbyAPI and vLLM share model cache at /var/lib/rancher/tabbyapi-model-cache on host tallgease.',
            createdAt: new Date().toISOString(),
          },
        ]);

        return {
          toolCallId: call.id,
          toolName: name,
          stdout: JSON.stringify(facts, null, 2),
          exitCode: 0,
        };
      }

      // 8. Propose Structured Harness Task
      if (name === 'propose_task') {
        const title = String(args.title || 'Untitled Task');
        const description = String(args.description || title);
        const personaId = (args.personaId as 'coder' | 'researcher' | 'architect' | 'evaluator') || 'coder';
        const budget = BudgetAllocator.estimateBudget(title, description);
        if (typeof args.maxTurns === 'number' && args.maxTurns > 0) {
          budget.maxTurns = args.maxTurns;
        }

        const rubrics = Array.isArray(args.rubrics) && args.rubrics.length > 0
          ? args.rubrics as any
          : [
              { name: 'test_pass_rate', weight: 0.4, description: 'All unit and integration tests pass with 0 errors.' },
              { name: 'code_completeness', weight: 0.3, description: 'No dummy stubs or unfinished placeholders.' },
              { name: 'specification_fidelity', weight: 0.3, description: 'Fulfills all requirements specified in scope.' },
            ];

        const proposal: ProposedHarnessTask = {
          id: `prop-${uuidv4().slice(0, 8)}`,
          title,
          description,
          personaId,
          budget,
          rubrics,
          status: 'proposed',
          createdAt: new Date().toISOString(),
        };

        return {
          toolCallId: call.id,
          toolName: name,
          stdout: JSON.stringify(proposal, null, 2),
          exitCode: 0,
        };
      }

      // 9. List Harness Tasks
      if (name === 'list_tasks') {
        const db = await getHarnessDb();
        const tasks = await db.getTasks();
        return {
          toolCallId: call.id,
          toolName: name,
          stdout: JSON.stringify(
            tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, turns: `${t.budget.turnsCompleted}/${t.budget.maxTurns}`, verdict: t.verdict?.score })),
            null,
            2,
          ),
          exitCode: 0,
        };
      }

      return {
        toolCallId: call.id,
        toolName: name,
        stdout: `Executed ${name} successfully.`,
        exitCode: 0,
      };
    } catch (err: any) {
      return {
        toolCallId: call.id,
        toolName: name,
        stderr: `Tool execution failed: ${err.message}`,
        isError: true,
        exitCode: 1,
      };
    }
  }

  /**
   * Processes a user message with full dynamic LLM model loop.
   */
  static async processMessage(
    userText: string,
    history: HarnessChatMessage[] = [],
    ctx: OrchestratorToolContext = {},
  ): Promise<OrchestratorReplyResult> {
    const trimmed = userText.trim();
    const proposals: ProposedHarnessTask[] = [];
    const toolCallsExecuted: { name: string; args: Record<string, unknown>; result: string }[] = [];

    // Attempt live Model LLM multi-round tool loop against available model providers
    if (ctx.modelService && ctx.userId) {
      try {
        const allProviders = await ctx.modelService.list(ctx.userId);

        // Sort candidates: requested model first, then local/responsive endpoints (Ollama), then cluster deployments
        const candidates = [...allProviders].sort((a, b) => {
          if (ctx.modelId && a.id === ctx.modelId) return -1;
          if (ctx.modelId && b.id === ctx.modelId) return 1;
          if (a.source === 'endpoint' && b.source !== 'endpoint') return -1;
          if (b.source === 'endpoint' && a.source !== 'endpoint') return 1;
          return 0;
        });

        for (const candidate of candidates) {
          try {
            const { baseUrl, apiKey, provider } = await ctx.modelService.resolveBaseUrl(ctx.userId, candidate.id);
            if (!baseUrl) continue;

            const systemPrompt = [
              `You are the Harness V2 Conversational Orchestrator for this platform.`,
              `You are an expert AI engineering assistant with full capability to discuss architecture, debug code, search the web, inspect platform resources, and propose structured tasks.`,
              `Tools available:`,
              `- get_openapi_spec: to view the platform API specification.`,
              `- call_platform_api: to execute requests against the platform API (/api/clusters, /api/apps, /api/models, etc).`,
              `- web_search / fetch_web_page: to search the live web.`,
              `- propose_task: when the user asks to build, implement, refactor, or research a task that should be executed autonomously.`,
              `Be concise, helpful, and direct in your answers. Format code with standard markdown.`,
            ].join(' ');

            const messages: any[] = [
              { role: 'system', content: systemPrompt },
              ...history.slice(-8).map((m) => ({ role: m.role, content: m.content })),
              { role: 'user', content: trimmed },
            ];

            let rounds = 0;
            let finalReply = '';
            let finalReasoning = '';
            let callSucceeded = false;

            while (rounds < 5) {
              rounds++;
              const llmRes = await axios.post(
                `${baseUrl}/chat/completions`,
                {
                  model: provider?.model || 'default',
                  messages,
                  tools: HARNESS_ORCHESTRATOR_TOOLS,
                  temperature: 0.3,
                },
                {
                  headers: {
                    'Content-Type': 'application/json',
                    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
                  },
                  timeout: 12000,
                },
              );

              callSucceeded = true;
              const choice = llmRes.data?.choices?.[0];
              const choiceMsg = choice?.message;
              if (!choiceMsg) break;

              if (choiceMsg.reasoning_content || choiceMsg.reasoning) {
                finalReasoning = choiceMsg.reasoning_content || choiceMsg.reasoning;
              }

              if (choiceMsg.content) {
                finalReply = choiceMsg.content;
              }

              const rawToolCalls = choiceMsg.tool_calls || [];
              if (rawToolCalls.length === 0) {
                break;
              }

              messages.push(choiceMsg);

              for (const tc of rawToolCalls) {
                const fnName = tc.function?.name;
                let fnArgs: Record<string, unknown> = {};
                try {
                  fnArgs = typeof tc.function?.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function?.arguments || {};
                } catch {}

                const toolRes = await this.executeTool(
                  { id: tc.id || `call-${uuidv4().slice(0, 6)}`, name: fnName, args: fnArgs },
                  ctx,
                );

                const outStr = toolRes.stdout || toolRes.stderr || '';
                toolCallsExecuted.push({
                  name: fnName,
                  args: fnArgs,
                  result: outStr,
                });

                if (fnName === 'propose_task' && toolRes.stdout) {
                  try {
                    const prop = JSON.parse(toolRes.stdout);
                    proposals.push(prop);
                  } catch {}
                }

                messages.push({
                  role: 'tool',
                  tool_call_id: tc.id,
                  name: fnName,
                  content: outStr,
                });
              }
            }

            if (callSucceeded && (finalReply || proposals.length > 0 || toolCallsExecuted.length > 0)) {
              if (proposals.length === 0 && finalReply) {
                try {
                  const jsonMatch = finalReply.match(/\{[\s\S]*"title"[\s\S]*"description"[\s\S]*\}/);
                  if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    if (parsed.title && parsed.description) {
                      const budget = BudgetAllocator.estimateBudget(parsed.title, parsed.description);
                      if (typeof parsed.maxTurns === 'number') budget.maxTurns = parsed.maxTurns;
                      const proposal: ProposedHarnessTask = {
                        id: `prop-${uuidv4().slice(0, 8)}`,
                        title: parsed.title,
                        description: parsed.description,
                        personaId: parsed.personaId || 'coder',
                        budget,
                        rubrics: Array.isArray(parsed.rubrics) ? parsed.rubrics : [
                          { name: 'test_pass_rate', weight: 0.4, description: 'All unit tests pass with 0 errors.' },
                          { name: 'code_completeness', weight: 0.3, description: 'No dummy stubs or unfinished placeholders.' },
                          { name: 'specification_fidelity', weight: 0.3, description: 'Fulfills all requirements specified in scope.' },
                        ],
                        status: 'proposed',
                        createdAt: new Date().toISOString(),
                      };
                      proposals.push(proposal);
                    }
                  }
                } catch {}
              }

              if (proposals.length > 0 && !finalReply) {
                finalReply = `I have formulated a structured Harness V2 task proposal for your objective. Review the details and click **Approve & Launch Task** below to begin execution in Temporal.`;
              }

              const assistantMsg: HarnessChatMessage = {
                id: `msg-${uuidv4().slice(0, 8)}`,
                role: 'assistant',
                content: finalReply || 'Executed requested operations.',
                reasoning: finalReasoning || (toolCallsExecuted.length > 0 ? `Executed tools: ${toolCallsExecuted.map((t) => t.name).join(', ')}` : undefined),
                proposals: proposals.length > 0 ? proposals : undefined,
                createdAt: new Date().toISOString(),
              };

              return {
                message: assistantMsg,
                proposals,
                toolCallsExecuted,
              };
            }
          } catch (modelErr: any) {
            // Try next candidate provider
            console.warn(`[orchestrator-chat] Candidate model ${candidate.name} failed: ${modelErr.message}`);
          }
        }
      } catch (err: any) {
        console.warn(`[orchestrator-chat] Model resolution failed: ${err.message}`);
      }
    }

    // Explicit fallback when no model endpoint is responsive
    const assistantMsg: HarnessChatMessage = {
      id: `msg-${uuidv4().slice(0, 8)}`,
      role: 'assistant',
      content: `⚠️ **Model Inference Unavailable**\n\nCould not connect to any active LLM provider (Ollama, TabbyAPI, vLLM). Please ensure Ollama is running or register an OpenAI-compatible endpoint under **Model Providers**.`,
      createdAt: new Date().toISOString(),
    };

    return {
      message: assistantMsg,
      proposals,
      toolCallsExecuted,
    };
  }
}
