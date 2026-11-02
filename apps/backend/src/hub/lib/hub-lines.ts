import type { RelayOp } from './hub-board.js';
import type { HubRole } from './hub.js';

export interface DescribedCall {
  id: string;
  projectId: string;
  op: RelayOp;
  args: Record<string, unknown>;
  as: { personId: string; email: string; role: HubRole };
  upload?: { type: string; size?: number | undefined } | undefined;
}

export const describedCall = (call: DescribedCall & { upload?: { type: string; size?: number | undefined; stream?: unknown } | undefined }): DescribedCall => {
  const { upload, ...rest } = call;
  return { ...rest, ...(upload ? { upload: { type: upload.type, ...(upload.size !== undefined ? { size: upload.size } : {}) } } : {}) };
};
