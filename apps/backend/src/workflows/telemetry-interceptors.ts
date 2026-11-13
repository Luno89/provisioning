import type { Headers } from '@temporalio/common';
import type {
  ActivityInput, ContinueAsNewInput, LocalActivityInput, Next, StartChildWorkflowExecutionInput, WorkflowExecuteInput,
  WorkflowInboundCallsInterceptor, WorkflowInterceptors, WorkflowOutboundCallsInterceptor,
} from '@temporalio/workflow';
import { WORK_HEADER, workOfPayload, workPayload } from '@koala/engine-core/work-header';


export const TRACE_HEADERS = ['traceparent', 'tracestate'] as const;
const CARRIED_HEADERS: readonly string[] = [...TRACE_HEADERS, WORK_HEADER];

export const traceHeadersOf = (headers: Headers | undefined): Headers =>
  Object.fromEntries(CARRIED_HEADERS.filter((name) => headers?.[name]).map((name) => [name, headers![name]!]));

export const withTrace = (headers: Headers | undefined, trace: Headers): Headers => ({ ...(headers ?? {}), ...trace });

interface Carrier {
  headers: Headers;
}

const CARRIER = Symbol.for('koala.carried-headers');

const carrierHere = (): Carrier | undefined => (globalThis as Record<symbol, Carrier | undefined>)[CARRIER];

export function nameProject(project: string | undefined): void {
  const carrier = carrierHere();
  if (!project || !carrier) return;
  carrier.headers = { ...carrier.headers, [WORK_HEADER]: workPayload({ ...workOfPayload(carrier.headers[WORK_HEADER]), project }) };
}

class CarryTraceInbound implements WorkflowInboundCallsInterceptor {
  constructor(private readonly carrier: Carrier) {}

  execute(input: WorkflowExecuteInput, next: Next<WorkflowInboundCallsInterceptor, 'execute'>): Promise<unknown> {
    this.carrier.headers = traceHeadersOf(input.headers);
    return next(input);
  }
}

class CarryTraceOutbound implements WorkflowOutboundCallsInterceptor {
  constructor(private readonly carrier: Carrier) {}

  scheduleActivity(input: ActivityInput, next: Next<WorkflowOutboundCallsInterceptor, 'scheduleActivity'>): Promise<unknown> {
    return next({ ...input, headers: withTrace(input.headers, this.carrier.headers) });
  }

  scheduleLocalActivity(input: LocalActivityInput, next: Next<WorkflowOutboundCallsInterceptor, 'scheduleLocalActivity'>): Promise<unknown> {
    return next({ ...input, headers: withTrace(input.headers, this.carrier.headers) });
  }

  startChildWorkflowExecution(input: StartChildWorkflowExecutionInput, next: Next<WorkflowOutboundCallsInterceptor, 'startChildWorkflowExecution'>): Promise<[Promise<string>, Promise<unknown>]> {
    return next({ ...input, headers: withTrace(input.headers, this.carrier.headers) });
  }

  continueAsNew(input: ContinueAsNewInput, next: Next<WorkflowOutboundCallsInterceptor, 'continueAsNew'>): Promise<never> {
    return next({ ...input, headers: withTrace(input.headers, this.carrier.headers) });
  }
}

export const interceptors = (): WorkflowInterceptors => {
  const carrier: Carrier = { headers: {} };
  (globalThis as Record<symbol, Carrier | undefined>)[CARRIER] = carrier;
  return {
    inbound: [new CarryTraceInbound(carrier)],
    outbound: [new CarryTraceOutbound(carrier)],
  };
};
