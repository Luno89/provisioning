import type { ContinuityState } from './state-vector.js';

/**
 * Renders a Continuity State Vector into a compact, model-readable Markdown frame.
 */
export function renderContinuityNotice(state: ContinuityState): string {
  const sections: string[] = [
    'Earlier messages in this conversation were intelligently compacted to fit the context window.',
    '',
    '### Primary Goal & Objective',
    state.goal,
  ];

  if (state.cumulativeUserDirectives.length > 0) {
    sections.push(
      '',
      '### User Guidance & Cumulative Constraints (Always Honor)',
      ...state.cumulativeUserDirectives.map((d) => `- ${d}`),
    );
  }

  const allFiles = [
    ...state.filesCreated.map((f) => `- \`${f}\` *(newly created)*`),
    ...state.filesModified.map((f) => `- \`${f}\` *(modified)*`),
  ];
  if (allFiles.length > 0) {
    sections.push('', '### Working Set & Files Touched', ...allFiles);
  }

  if (state.negativeKnowledge.length > 0) {
    sections.push(
      '',
      '### Negative Knowledge & Failed Approaches (DO NOT REPEAT)',
      ...state.negativeKnowledge.map((k) => `- ${k}`),
    );
  }

  if (state.environmentFacts.length > 0) {
    sections.push(
      '',
      '### Discovered Environment Facts',
      ...state.environmentFacts.map((e) => `- ${e}`),
    );
  }

  if (state.acceptedProposals.length > 0) {
    sections.push(
      '',
      '### Already Accepted Items (Do not propose again)',
      ...state.acceptedProposals.map((p) => `- ${p}`),
    );
  }

  if (state.openProposals.length > 0) {
    sections.push(
      '',
      '### Active Proposals / Tasks',
      ...state.openProposals.map((p) => `- ${p}`),
    );
  }

  if (state.recentDiscoveries.length > 0) {
    sections.push(
      '',
      '### Key Findings From Tools',
      ...state.recentDiscoveries.map((d) => `- ${d}`),
    );
  }

  sections.push(
    '',
    'Carry on from here. The above summary captures your current progress, user constraints, and failure invariants. Continue directly with your work.',
  );

  return sections.join('\n');
}
