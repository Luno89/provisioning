export type HintChoice = 'read-only' | 'safe-write' | 'destructive';

export interface McpToolHint {
  ownerId: string;
  server: string;
  tool: string;
  choice: HintChoice;
  updatedAt: string;
}

export const hintKey = (ownerId: string, server: string, tool: string): string => `${ownerId}:${server}:${tool}`;
