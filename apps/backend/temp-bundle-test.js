#!/usr/bin/env node
// Temp debug bundle
import path from 'path';
import { bundleWorkflowCode } from '@temporalio/worker';

async function main() {
  process.chdir('/home/luno/Code/provisioning/apps/backend');
  
  console.log('Working dir:', process.cwd());
  console.log('cwd:', process.cwd());

  try {
    const workflowCode = await bundleWorkflowCode({
      workflowsPath: path.resolve('src/workflows'),
      options: {
        isolateExecutionTimeoutMs: 60000,
        reuseV8Context: true,
      },
    });

    console.log('SUCCESS bundle size:', workflowCode?.code?.length || '?');
    
    // Check what is exported
    const code = workflowCode.code;
    const hasCluster = code.includes('ClusterProvisionWorkflow');
    console.log('Has ClusterProvisionWorkflow:', hasCluster);
  } catch (err) {
    console.error('ERROR:', err.message);
    if (err.output) {
      console.error('Webpack output:', err.output.toString().slice(-3000));
    }
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
