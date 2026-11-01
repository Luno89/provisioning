export function proxyActivities<T>(options: { taskQueue?: string } = {}): T {
  return options as T;
}

export class Worker {
  static create(options: { activities: object }): Worker {
    return new Worker(options.activities);
  }

  private constructor(readonly activities: object) {}
}
