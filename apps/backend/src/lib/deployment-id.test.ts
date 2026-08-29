import { describe, it, expect } from 'vitest';
import { deriveDeploymentId, deploymentIdFor } from './deployment-id.js';

describe('deriving instead of minting', () => {
  it('gives concurrent deploys the same answer', () => {
    const a = deriveDeploymentId('github-mcp');
    const b = deriveDeploymentId('github-mcp');
    expect(a).toBe(b);
  });

  it('gives different deployments different ids', () => {
    expect(deriveDeploymentId('github-mcp')).not.toBe(deriveDeploymentId('weather-api'));
  });

  it('is safe in a stack name and a filename', () => {
    const id = deriveDeploymentId('Weather API (staging)/v2');
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('keeps the width the random version used', () => {
    expect(deriveDeploymentId('anything')).toHaveLength(8);
  });
});

describe('choosing an id for a deploy', () => {
  it('ALWAYS keeps an id that was already stored', () => {
    expect(deploymentIdFor('zr1d09s7', 'github-mcp')).toBe('zr1d09s7');
    expect(deploymentIdFor('default', 'github-mcp')).toBe('default');
  });

  it('derives when there is nothing stored', () => {
    expect(deploymentIdFor(undefined, 'github-mcp')).toBe(deriveDeploymentId('github-mcp'));
    expect(deploymentIdFor('', 'github-mcp')).toBe(deriveDeploymentId('github-mcp'));
  });

  it('closes the window the race lived in', () => {
    const first = deploymentIdFor(undefined, 'github-mcp');
    const second = deploymentIdFor(undefined, 'github-mcp');
    const third = deploymentIdFor(undefined, 'github-mcp');
    expect(new Set([first, second, third]).size).toBe(1);
  });
});
