import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { afterTest, dropDoing, keepDoing, RUN_PID, runsDir, testName, type TaskShape } from '../lib/test-runs.js';

const run = process.env[RUN_PID];
const dir = runsDir();
const now = (): number => Math.round(performance.timeOrigin + performance.now());

if (run) {
  const say = (task: TaskShape, doing: string): void => keepDoing(dir, run, { file: (task.file ?? task).id, doing, since: now() });
  beforeAll(({}, file) => say(file as TaskShape, 'beforeAll'));
  beforeEach((context) => say(context.task as TaskShape, testName(context.task as TaskShape)));
  afterEach((context) => say(context.task as TaskShape, afterTest(context.task as TaskShape)));
  afterAll(() => dropDoing(dir, run));
}
