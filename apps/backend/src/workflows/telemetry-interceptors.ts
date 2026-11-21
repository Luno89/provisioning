import type { Headers } from '@temporalio/common';
import type {
  ActivityInput, ContinueAsNewInput, LocalActivityInput, Next, StartChildWorkflowExecutionInput, WorkflowExecuteInput,
  WorkflowInboundCallsInterceptor, WorkflowInterceptors, WorkflowOutboundCallsInterceptor,
} from '@temporalio/workflow';
import { patched, upsertSearchAttributes } from '@temporalio/workflow';
import { PROJECT_ATTRIBUTE, withProjectAttribute } from '@koala/engine-core/workflow-owner';
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

export const PROJECT_NAMED_LATE = 'koala-project-named-late';

export function nameProject(project: string | undefined): void {
  const carrier = carrierHere();
  if (!project || !carrier) return;
  carrier.headers = { ...carrier.headers, [WORK_HEADER]: workPayload({ ...workOfPayload(carrier.headers[WORK_HEADER]), project }) };
  if (patched(PROJECT_NAMED_LATE)) upsertSearchAttributes([{ key: PROJECT_ATTRIBUTE, value: project }]);
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
    const project = workOfPayload(this.carrier.headers[WORK_HEADER])?.project;
    const options = project ? { ...input.options, typedSearchAttributes: withProjectAttribute(input.options.typedSearchAttributes, project) } : input.options;
    return next({ ...input, headers: withTrace(input.headers, this.carrier.headers), options });
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
