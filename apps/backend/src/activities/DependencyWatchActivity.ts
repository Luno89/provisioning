import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApplicationFailure } from '@temporalio/common';
import { claimSettingsFrom, createDatabase, MailService, operatorsAmong, publicFetch } from '../platform/index.js';
import { hostSettings } from './host-settings.js';
import { DependencyWatch, inventoryFileFor } from '../instances/index.js';

const CHARTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../data/instance-charts');

export async function DependencyWatchActivity(): Promise<{ findings: number; due: number }> {
  const settings = hostSettings();
  const { role } = settings;
  if (!settings.root || !settings.publicUrl) throw ApplicationFailure.nonRetryable('only root watches the dependencies of the releases it runs', 'NotRoot');
  const { imageTag } = settings.root;
  const rootUrl = settings.publicUrl;
  const db = createDatabase({ mongo: settings.mongo, dataKey: settings.keys.data });
  await db.init();
  try {
    const mail = new MailService({ way: settings.mail, emailOf: async (id) => (await db.accounts.getUserById(id))?.email });
    const watch = new DependencyWatch({
      store: db.instances,
      inventoryOf: async (tag) => {
        const file = inventoryFileFor(CHARTS_DIR, tag);
        if (!file) return undefined;
        try {
          return JSON.parse(await readFile(file, 'utf8')) as unknown;
        } catch {
          return undefined;
        }
      },
      currentRelease: imageTag,
      fetchImpl: publicFetch,
      tell: async (message) => {
        const operators = operatorsAmong(await db.accounts.getUsers(), claimSettingsFrom(role));
        for (const operator of operators) {
          await mail.toOwner(operator.id, message).catch((error: Error) => console.warn(`[dependencies] could not email ${operator.id} "${message.subject}": ${error.message}`));
        }
      },
      rootUrl,
    });
    const { findings } = await watch.check();
    return { findings: findings.length, due: findings.filter((finding) => finding.state === 'due').length };
  } finally {
    await db.close();
  }
}
