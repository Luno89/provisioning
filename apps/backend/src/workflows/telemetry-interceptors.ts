import type { Headers } from '@temporalio/common';
import type {
  ActivityInput, ContinueAsNewInput, LocalActivityInput, Next, StartChildWorkflowExecutionInput, WorkflowExecuteInput,
  WorkflowInboundCallsInterceptor, WorkflowInterceptors, WorkflowOutboundCallsInterceptor,
} from '@temporalio/workflow';

export const TRACE_HEADERS = ['traceparent', 'tracestate'] as const;

export const traceHeadersOf = (headers: Headers | undefined): Headers =>
  Object.fromEntries(TRACE_HEADERS.filter((name) => headers?.[name]).map((name) => [name, headers![name]!]));

export const withTrace = (headers: Headers | undefined, trace: Headers): Headers => ({ ...(headers ?? {}), ...trace });

class CarryTraceInbound implements WorkflowInboundCallsInterceptor {
  constructor(private readonly keep: (headers: Headers) => void) {}

  execute(input: WorkflowExecuteInput, next: Next<WorkflowInboundCallsInterceptor, 'execute'>): Promise<unknown> {
    this.keep(traceHeadersOf(input.headers));
    return next(input);
  }
}

class CarryTraceOutbound implements WorkflowOutboundCallsInterceptor {
  constructor(private readonly trace: () => Headers) {}

  scheduleActivity(input: ActivityInput, next: Next<WorkflowOutboundCallsInterceptor, 'scheduleActivity'>): Promise<unknown> {
    return next({ ...input, headers: withTrace(input.headers, this.trace()) });
  }

  scheduleLocalActivity(input: LocalActivityInput, next: Next<WorkflowOutboundCallsInterceptor, 'scheduleLocalActivity'>): Promise<unknown> {
    return next({ ...input, headers: withTrace(input.headers, this.trace()) });
  }

  startChildWorkflowExecution(input: StartChildWorkflowExecutionInput, next: Next<WorkflowOutboundCallsInterceptor, 'startChildWorkflowExecution'>): Promise<[Promise<string>, Promise<unknown>]> {
    return next({ ...input, headers: withTrace(input.headers, this.trace()) });
  }

  continueAsNew(input: ContinueAsNewInput, next: Next<WorkflowOutboundCallsInterceptor, 'continueAsNew'>): Promise<never> {
    return next({ ...input, headers: withTrace(input.headers, this.trace()) });
  }
}

export const interceptors = (): WorkflowInterceptors => {
  let trace: Headers = {};
  return {
    inbound: [new CarryTraceInbound((headers) => { trace = headers; })],
    outbound: [new CarryTraceOutbound(() => trace)],
  };
};
