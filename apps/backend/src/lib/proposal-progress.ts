import type { ProposalProgress, ProposalStarted } from '@koala/harness-types';
import { serverState, type McpServerRecord } from './mcp-servers.js';

export interface ImageNow {
  state: 'ready' | 'building' | 'failed' | 'unbuilt';
  detail?: string | undefined;
}

export function serverProgress(started: ProposalStarted, server: McpServerRecord | undefined, images: Readonly<Record<string, ImageNow | undefined>>): ProposalProgress {
  const steps: ProposalProgress['steps'] = [];
  const name = started.server?.name ?? 'the server';
  if (started.server?.added) steps.push({ label: `Added ${name}`, state: 'done' });
  if (!server) {
    steps.push({ label: `${name} is no longer in your catalogue`, state: 'failed' });
  } else {
    const state = serverState(server);
    if (state.state === 'captured') {
      steps.push({ label: 'Captured its tools', state: 'done', detail: `${server.captured?.tools.length ?? 0}, ${state.tools} offered` });
    } else if (state.state === 'failed') {
      steps.push({ label: 'Capturing its tools', state: 'failed', detail: state.why });
    } else {
      steps.push({ label: 'Capturing its tools', state: 'running' });
    }
  }
  for (const slug of started.images ?? []) {
    const image = images[slug];
    if (image?.state === 'ready') steps.push({ label: `${slug}'s image is built`, state: 'done' });
    else if (image?.state === 'failed') steps.push({ label: `Building ${slug}'s image`, state: 'failed', ...(image.detail ? { detail: image.detail } : {}) });
    else steps.push({ label: `Building ${slug}'s image`, state: 'running' });
  }
  const done = steps.every((step) => step.state === 'done');
  const holders = started.images?.length ? ` for ${started.images.join(', ')}` : '';
  return {
    steps,
    done,
    ...(done && server ? { ready: `${server.name} is ready${holders}` } : {}),
    ...(server ? { server: { id: server.id, name: server.name } } : {}),
  };
}
