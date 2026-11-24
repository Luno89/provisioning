export function ignore(why: string): (failure?: unknown) => undefined {
  if (!why.trim()) throw new Error('say why the failure does not matter');
  return () => undefined;
}

export const LOST_CONNECTION: ReadonlySet<string> = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT',
  'UND_ERR_SOCKET', 'UND_ERR_CLOSED', 'UND_ERR_CONNECT_TIMEOUT',
]);

export const causeCode = (err: unknown): string | undefined => {
  const cause = (err as { cause?: { code?: unknown } } | undefined)?.cause;
  return typeof cause?.code === 'string' ? cause.code : undefined;
};

export const streamCutOff = (err: unknown): boolean =>
  err instanceof Error && err.name === 'TypeError' && err.message === 'terminated';

export type Failure = { kind: 'temporary'; reason: string } | { kind: 'final'; reason: string };

export const NAME_NOT_FOUND: ReadonlySet<string> = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

export const GONE_STATUSES: ReadonlySet<number> = new Set([404, 410]);

const CUT_OFF = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CLOSED']);
const UNREACHABLE = new Set(['EHOSTUNREACH', 'ENETUNREACH']);
const TOO_SLOW = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ECONNABORTED']);
const TEMPORARY_CODES: ReadonlySet<string> = new Set([...LOST_CONNECTION, ...TOO_SLOW, 'EAI_AGAIN']);
const S3_TEMPORARY = new Set(['SlowDown', 'ServiceUnavailable', 'InternalError', 'RequestTimeout', 'XMinioServerNotInitialized']);
const MONGO_TEMPORARY = new Set(['MongoNetworkError', 'MongoNetworkTimeoutError', 'MongoServerSelectionError', 'MongoNotConnectedError', 'MongoTopologyClosedError']);
const GRPC_UNAVAILABLE = 14;
const GRPC_DEADLINE_EXCEEDED = 4;
const GRPC_NOT_CONNECTED_YET = 'Failed to connect before the deadline';

const STILL_DOWN = 'DependencyStillDown';

export const stillDown = (reason: string): Error => Object.assign(new Error(reason), { name: STILL_DOWN });

const temporary = (reason: string): Failure => ({ kind: 'temporary', reason });
const final = (reason: string): Failure => ({ kind: 'final', reason });

const field = (value: unknown, name: string): unknown =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[name] : undefined;

const messageOf = (error: unknown): string => {
  const message = field(error, 'message');
  return typeof message === 'string' && message ? message : String(error);
};

const messagesDown = (error: unknown): string => {
  const seen = new Set<unknown>([error]);
  let said = messageOf(error);
  for (let cause = field(error, 'cause'); cause !== undefined && cause !== null && !seen.has(cause); cause = field(cause, 'cause')) {
    seen.add(cause);
    const message = messageOf(cause);
    if (!said.includes(message)) said = `${said}: ${message}`;
  }
  return said;
};

const nameOf = (error: unknown): string | undefined => {
  const name = field(error, 'name');
  return typeof name === 'string' ? name : undefined;
};

export const refusedByServer = (error: unknown): boolean => nameOf(error) === 'ResponseBodyError';

const httpStatusOf = (error: unknown): number | undefined => {
  const answer = field(error, 'cause');
  const candidates = [field(error, 'status'), field(field(error, 'response'), 'status'), field(error, 'statusCode'), answer instanceof Response ? answer.status : undefined];
  return candidates.find((value): value is number => typeof value === 'number' && value >= 100 && value <= 599);
};

const retryAfterOf = (error: unknown): string | undefined => {
  const given = field(error, 'retryAfter') ?? field(field(field(error, 'response'), 'headers'), 'retry-after');
  return typeof given === 'string' && given.trim() ? given.trim() : undefined;
};

const codeOf = (error: unknown): string | undefined => {
  const own = field(error, 'code');
  return typeof own === 'string' && own ? own : causeCode(error);
};

const socketNotThereYet = (error: unknown): string | undefined => {
  const connecting = [error, field(error, 'cause')].find((one) => field(one, 'code') === 'ENOENT' && field(one, 'syscall') === 'connect');
  const address = field(connecting, 'address');
  return connecting ? (typeof address === 'string' ? address : 'its socket') : undefined;
};

const grpcCodeOf = (error: unknown): number | undefined => {
  const own = field(error, 'code');
  if (typeof own === 'number') return own;
  const cause = field(field(error, 'cause'), 'code');
  return typeof cause === 'number' ? cause : undefined;
};

export function statusFailure(status: number, retryAfter?: string): Failure {
  if (status === 429) return temporary(`it is busy and answered 429${retryAfter ? `, asking to be asked again after ${retryAfter}` : ''}`);
  if (status >= 500) return temporary(`it answered ${status}${retryAfter ? `, asking to be asked again after ${retryAfter}` : ''}`);
  if (GONE_STATUSES.has(status)) return final(`it says what was asked for is gone (${status})`);
  return final(`it refused the request (${status})`);
}

export const temporaryStatus = (status: number): boolean => status === 429 || status >= 500;

function codeFailure(code: string): Failure | undefined {
  if (code === 'ECONNREFUSED') return temporary(`it refused the connection (${code})`);
  if (CUT_OFF.has(code)) return temporary(`the connection to it was cut off (${code})`);
  if (UNREACHABLE.has(code)) return temporary(`its network cannot be reached (${code})`);
  if (TOO_SLOW.has(code)) return temporary(`it did not answer in time (${code})`);
  if (code === 'EAI_AGAIN') return temporary(`its name could not be looked up just now (${code})`);
  if (TEMPORARY_CODES.has(code)) return temporary(`the connection to it was lost (${code})`);
  if (NAME_NOT_FOUND.has(code)) return final(`its name does not resolve (${code})`);
  if (S3_TEMPORARY.has(code)) return temporary(`it answered ${code}`);
  return undefined;
}

export function failureOf(error: unknown): Failure {
  if (nameOf(error) === 'DependencyDownError') return temporary(String(field(error, 'reason') ?? messageOf(error)));
  if (nameOf(error) === STILL_DOWN) return temporary(messageOf(error));
  if (refusedByServer(error)) return final(`it refused: ${messageOf(error)}`);
  const status = httpStatusOf(error);
  if (status !== undefined) return statusFailure(status, retryAfterOf(error));
  const socket = socketNotThereYet(error);
  if (socket) return temporary(`nothing listens on ${socket} yet (ENOENT)`);
  const code = codeOf(error);
  const byCode = code ? codeFailure(code) : undefined;
  if (byCode) return byCode;
  const grpc = grpcCodeOf(error);
  if (grpc === GRPC_UNAVAILABLE) return temporary(`it is unavailable: ${messageOf(error)}`);
  if (grpc === GRPC_DEADLINE_EXCEEDED) return temporary(`it did not answer in time: ${messageOf(error)}`);
  if (messageOf(error) === GRPC_NOT_CONNECTED_YET) return temporary(`its connection did not open yet: ${messageOf(error)}`);
  const name = nameOf(error);
  if (name && MONGO_TEMPORARY.has(name)) return temporary(`it cannot be reached: ${messageOf(error)}`);
  if (name === 'TransportError') return temporary(`it cannot be reached: ${messageOf(error)}`);
  if (name === 'TimeoutError') return temporary('it did not answer in time');
  if (streamCutOff(error)) return temporary('the connection to it was cut off while it answered');
  if (error instanceof TypeError && FETCH_NETWORK_FAILED.has(error.message) && code === undefined) return temporary(`the connection to it failed (${error.message})`);
  const cluster = clusterUnreachable(error);
  if (cluster) return temporary(`the cluster cannot be reached: ${cluster}`);
  return final(messagesDown(error));
}

const TOKEN_NOT_KNOWN: ReadonlySet<unknown> = new Set(['invalid_token', 'invalid_grant']);

export function tokenAlreadyGone(error: unknown): boolean {
  const status = httpStatusOf(error);
  return (status !== undefined && GONE_STATUSES.has(status)) || TOKEN_NOT_KNOWN.has(field(error, 'error'));
}

const FETCH_NETWORK_FAILED: ReadonlySet<string> = new Set(['fetch failed', 'Failed to fetch']);

const CLUSTER_UNREACHABLE = /was refused - did you specify the right host or port|Unable to connect to the server|connection refused/i;

function clusterUnreachable(error: unknown): string | undefined {
  const said = [field(error, 'stderr'), field(field(error, 'result'), 'stderr')].find((one): one is string => typeof one === 'string' && one.trim() !== '');
  return said?.split('\n').map((line) => line.trim()).find((line) => CLUSTER_UNREACHABLE.test(line));
}

export const WAITING_RETRY = { initialInterval: '5s', backoffCoefficient: 2, maximumInterval: '1m' } as const;
