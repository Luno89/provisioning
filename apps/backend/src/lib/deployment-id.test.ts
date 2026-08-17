import { describe, it, expect } from 'vitest';
import { deriveDeploymentId, deploymentIdFor } from './deployment-id.js';

/**
 * The id that decides which Terraform state a deploy writes to.
 *
 * ── THE OBSERVED FAILURE ──
 * It was `dep.deploymentId || Math.random()...`. Three deploy workflows started within 90ms, all
 * read a record with no id, and each invented one — producing four state files for one deployment.
 * Every deploy afterwards ran against an empty state and failed with
 * `namespaces "github-mcp" already exists`, forever.
 */

describe('deriving instead of minting', () => {
  it('gives concurrent deploys the same answer', () => {
    /**
     * The whole fix. Three workflows computing this simultaneously agree without coordinating,
     * so there is nothing left to race for.
     */
    const a = deriveDeploymentId('github-mcp');
    const b = deriveDeploymentId('github-mcp');
    expect(a).toBe(b);
  });

  it('gives different deployments different ids', () => {
    // They share a cluster; colliding would have two apps writing one state.
    expect(deriveDeploymentId('github-mcp')).not.toBe(deriveDeploymentId('weather-api'));
  });

  it('is safe in a stack name and a filename', () => {
    /**
     * It becomes part of a Terraform stack name and a file on disk. Deployment names legal in
     * Kubernetes include characters that are awkward in both.
     */
    const id = deriveDeploymentId('Weather API (staging)/v2');
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('keeps the width the random version used', () => {
    // Anything downstream that assumed eight characters keeps working.
    expect(deriveDeploymentId('anything')).toHaveLength(8);
  });
});

describe('choosing an id for a deploy', () => {
  it('ALWAYS keeps an id that was already stored', () => {
    /**
     * A migration decision, not a stylistic one. Every deployment already running has a state file
     * keyed by whatever random id it was given; deriving a fresh one would point them all at empty
     * states and have them try to recreate themselves — the exact failure being fixed, inflicted
     * on everything at once.
     */
    expect(deploymentIdFor('zr1d09s7', 'github-mcp')).toBe('zr1d09s7');
    // Even when the stored one looks nothing like a derived id.
    expect(deploymentIdFor('default', 'github-mcp')).toBe('default');
  });

  it('derives when there is nothing stored', () => {
    expect(deploymentIdFor(undefined, 'github-mcp')).toBe(deriveDeploymentId('github-mcp'));
    expect(deploymentIdFor('', 'github-mcp')).toBe(deriveDeploymentId('github-mcp'));
  });

  it('closes the window the race lived in', () => {
    /**
     * The race was only ever possible while the id was ABSENT. Two callers arriving at that moment
     * together used to get different answers; now they cannot.
     */
    const first = deploymentIdFor(undefined, 'github-mcp');
    const second = deploymentIdFor(undefined, 'github-mcp');
    const third = deploymentIdFor(undefined, 'github-mcp');
    expect(new Set([first, second, third]).size).toBe(1);
  });
});
