import type { ProjectMetadata } from './types.js';
import type { WorkspaceSpec } from './workspace-spec.js';
import type { WorkspaceImageSpec } from './workspace-image-seeds.js';
import { capableImage } from './workspace-image-catalogue.js';

/**
 * A local device has real filesystem/network access, so it defaults to requiring a human's
 * sign-off on every command — 'auto' has to be chosen deliberately, per project.
 */
export function approvalModeFor(project: Pick<ProjectMetadata, 'executionApproval'> | undefined): 'plan' | 'auto' {
  return project?.executionApproval === 'auto' ? 'auto' : 'plan';
}

/**
 * Deliberately NOT `personaWorkspace()` — that function always folds in K8s-only concepts (the
 * registry proxy, Gitea checkout egress, binding-derived namespace rules) that mean nothing on a
 * bare host or a local container and would show up as false "reachable" hints in the local prompt
 * descriptions. A local device gets only its resolved image; egress hints live on
 * `LocalMachineWorkspaceOptions` instead of `WorkspaceSpec.egress`, since they're hostname-shaped
 * (`LocalEgressRule`), not the K8s CIDR/namespace shape `WorkspaceSpec.egress` expects.
 */
export function buildLocalSandboxSpec(
  ids: { leafId: string; ownerId: string },
  images: readonly WorkspaceImageSpec[],
  language: string | undefined,
): WorkspaceSpec {
  return {
    leafId: ids.leafId,
    ownerId: ids.ownerId,
    image: capableImage(images, language),
  };
}
