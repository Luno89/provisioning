import type { MongoClient } from 'mongodb';
import type { DependencyReporter } from './dependencies.js';

export function reportMongoReach(client: Pick<MongoClient, 'on'>, reporter: DependencyReporter): void {
  client.on('serverHeartbeatFailed', (event) => reporter.failed('mongo', event.failure));
  client.on('serverHeartbeatSucceeded', () => reporter.answered('mongo'));
}
