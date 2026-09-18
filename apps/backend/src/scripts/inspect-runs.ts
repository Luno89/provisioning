import { createDatabase } from '../lib/db-interface.js';

async function main() {
  const db = createDatabase();
  await db.init();
  const mongoDb = db as any;
  if (!mongoDb.evalRuns) {
    console.log('No evalRuns collection found.');
    return;
  }

  const docs = await mongoDb.evalRuns.find({}).sort({ startedAt: -1 }).limit(1).toArray();
  console.log(`Found ${docs.length} eval runs:`);

  for (const doc of docs) {
    console.log('\n-----------------------------------------------------------');
    console.log(`Run ID: ${doc._id}`);
    console.log(`Owner: ${doc.ownerId}, State: ${doc.state}`);
    console.log(`Started: ${doc.startedAt}, FinishedAt: ${doc.finishedAt}`);
    console.log(`Progress: ${doc.finished}/${doc.total} cases, Repeats: ${doc.repeats}`);
    console.log(`Model Label: ${doc.modelLabel}`);
    console.log(`Model ID: ${doc.modelId}`);
    if (doc.outcomes && doc.outcomes[0]) {
      console.log('Outcome[0] keys:', Object.keys(doc.outcomes[0]));
      console.log('Outcome[0]:', JSON.stringify(doc.outcomes[0], null, 2));
    }
      console.log('Outcomes summary:');
      for (const o of doc.outcomes) {
        const mark = o.passed === o.attempts ? '✓' : o.passed === 0 ? '✕' : '~';
        console.log(`  ${mark} ${o.name}: ${o.passed}/${o.attempts} passed`);
        if (o.complaints && o.complaints.length > 0) {
          for (const c of o.complaints) {
            console.log(`      complaint: ${c}`);
          }
        }
      }
  }
}

main().catch(console.error).finally(() => process.exit(0));
