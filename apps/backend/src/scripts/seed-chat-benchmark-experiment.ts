import { MongoDB } from '../lib/mongo-db.js';
import { v4 as uuidv4 } from 'uuid';
import type { Experiment } from '@koala/harness-types';

async function main() {
  const mongo = new MongoDB();
  await mongo.init();

  const existing = (await mongo.getExperiments()).filter(e => e.name === 'Chat Basic Q&A & Web Search Benchmark');
  for (const item of existing) {
    await mongo.deleteExperiment(item.id);
  }

  const now = new Date().toISOString();
  const experiment: Experiment = {
    id: existing[0]?.id ?? uuidv4(),
    ownerId: '2d5fe7e1-e7fc-4e88-8faf-8f08ba8b8991',
    name: 'Chat Basic Q&A & Web Search Benchmark',
    language: 'node',
    status: 'draft',
    results: [],
    repeats: 2,
    createdAt: now,
    updatedAt: now,
    variants: [
      {
        label: 'proposed-anti-synonym-defaults',
        overrides: {
          temperature: 0.7,
          frequency_penalty: 0.40,
          presence_penalty: 0.30,
          thoughtMonitorSensitivity: 'medium',
          ngramRepeatThreshold: 5,
          failurePredictionThreshold: 0.75,
          dry_multiplier: 0.8,
          dry_base: 1.75,
          dry_allowed_length: 2,
        },
      },
      {
        label: 'aggressive-anti-loop',
        overrides: {
          temperature: 0.3,
          frequency_penalty: 0.60,
          presence_penalty: 0.50,
          thoughtMonitorSensitivity: 'high',
          ngramRepeatThreshold: 3,
          failurePredictionThreshold: 0.70,
          dry_multiplier: 1.2,
          dry_base: 2.0,
          dry_allowed_length: 1,
        },
      },
      {
        label: 'legacy-baseline-no-penalties',
        overrides: {
          temperature: 0.7,
          frequency_penalty: 0.0,
          presence_penalty: 0.0,
          thoughtMonitorSensitivity: 'low',
          ngramRepeatThreshold: 8,
          failurePredictionThreshold: 0.95,
        },
      },
      {
        label: 'low-temp-tool-dispatch',
        overrides: {
          temperature: 0.2,
          frequency_penalty: 0.40,
          presence_penalty: 0.30,
          thoughtMonitorSensitivity: 'medium',
          ngramRepeatThreshold: 4,
          failurePredictionThreshold: 0.75,
        },
      },
    ],
    tasks: [
      {
        id: 'chat-t1',
        name: 't1-weather-query',
        prompt: 'Search the live web for the current weather forecast in Tokyo today. Write a concise summary of the temperature and conditions to /work/tokyo_weather.txt.',
        verifyCommand: 'test -s /work/tokyo_weather.txt && (grep -qi "tokyo" /work/tokyo_weather.txt || grep -qi "weather" /work/tokyo_weather.txt || grep -qi "temp" /work/tokyo_weather.txt)',
      },
      {
        id: 'chat-t2',
        name: 't2-web-search-tech',
        prompt: 'Search the live web for the latest major features released in TypeScript in 2026. Write key improvements to /work/typescript_features.txt.',
        verifyCommand: 'test -s /work/typescript_features.txt && (grep -qi "typescript" /work/typescript_features.txt || grep -qi "type" /work/typescript_features.txt)',
      },
      {
        id: 'chat-t3',
        name: 't3-capability-explanation',
        prompt: 'Explain your web search, web fetch, and leaf workspace capabilities to the user and write the explanation to /work/capabilities.txt.',
        verifyCommand: 'test -s /work/capabilities.txt',
      },
      {
        id: 'chat-t4',
        name: 't4-casual-greeting',
        prompt: 'Introduce yourself and ask how you can help. Write your response to /work/greeting.txt.',
        verifyCommand: 'test -s /work/greeting.txt',
      },
      {
        id: 'chat-t5',
        name: 't5-fetch-documentation',
        prompt: 'Fetch web page content from https://example.com and summarize the main heading and body text into /work/example_summary.txt.',
        verifyCommand: 'test -s /work/example_summary.txt && (grep -qi "example" /work/example_summary.txt || grep -qi "domain" /work/example_summary.txt)',
      },
    ],
  };

  await mongo.saveExperiment(experiment);
  console.log(`Successfully updated experiment suite with strict verification: "${experiment.name}" (${experiment.id})`);
  process.exit(0);
}

main().catch((err) => {
  console.error('Failed to seed chat benchmark experiment:', err);
  process.exit(1);
});
