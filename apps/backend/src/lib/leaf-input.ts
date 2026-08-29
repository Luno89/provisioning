import { usablePaths } from './leaf-artifacts.js';
import { usableAcceptance } from './acceptance.js';
import { isLeafColumn, type Leaf } from './leaves.js';

export const LEAF_INPUT_FIELDS = [
  'title', 'body', 'column', 'blocking', 'expects', 'mcp', 'verifyCommand',
] as const;

export function normaliseLeafInput(raw: Record<string, unknown>): Partial<Leaf> {
  const out: Partial<Leaf> = {};

  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  if (title) out.title = title.slice(0, 200);

  const body = typeof raw.body === 'string' ? raw.body.trim() : '';
  if (body) out.body = body.slice(0, 4000);

  if (isLeafColumn(raw.column)) out.column = raw.column;

  if (raw.blocking === false) out.blocking = false;

  const expects = usablePaths(Array.isArray(raw.expects) ? raw.expects.map(String) : []);
  if (expects.length) out.expects = expects;

  const mcp = Array.isArray(raw.mcp)
    ? [...new Set(raw.mcp.map((m: unknown) => String(m).trim()).filter(Boolean))].slice(0, 8)
    : [];
  if (mcp.length) out.mcp = mcp;

  const verify = usableAcceptance(raw.verifyCommand);
  if (verify) out.verifyCommand = verify;

  return out;
}
