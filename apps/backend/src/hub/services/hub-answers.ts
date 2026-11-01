import { ignore } from '@koala/engine-core/failures';

export async function refusalOf(response: Response): Promise<{ error?: string }> {
  const body: unknown = await response.json().catch(ignore('a refusal whose body is not JSON is still reported by its status'));
  const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  return typeof error === 'string' ? { error } : {};
}
