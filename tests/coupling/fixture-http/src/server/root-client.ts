export class RootClient {
  constructor(private readonly root: { url: string }, private readonly fetchImpl: typeof fetch = fetch) {}

  async notes(id: string): Promise<unknown> {
    const answer = await this.fetchImpl(`${this.root.url}/api/items/${id}/notes`, { headers: { accept: 'application/json' } });
    return answer.json();
  }

  async decide(id: string, kind: 'cut-over' | 'discard'): Promise<void> {
    const url = `${this.root.url}/api/items/${id}/${kind}`;
    await this.fetchImpl(url, { method: 'POST' });
  }

  async elsewhere(): Promise<void> {
    await this.fetchImpl('https://example.com/api/items/1');
  }
}
