import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildGraph, isTest } from './graph.js';
import { socketChannels } from './socket-edges.js';

const ROOT = join(import.meta.dirname, 'fixture-socket');
const graph = buildGraph({ projects: [{ tsconfig: join(ROOT, 'tsconfig.json'), owns: () => true, channels: socketChannels }], root: ROOT, calledFrom: (file) => !isTest(file) });
const unit = (id: string) => `${graph.units[id]!.file}#${graph.units[id]!.name}`;
const socketEdges = graph.edges.filter((edge) => edge.through === 'socket').map((edge) => `${unit(edge.from)} → ${edge.to.map(unit).join(' | ')}`).sort();

describe('socket.io edges', () => {
  it('join what one side sends to the handler that hears it, through interfaces, constants and wrappers', () => {
    expect(socketEdges).toEqual([
      'src/client/hooks.ts#sayHello → src/server/wiring.ts#(anonymous)',
      'src/server/devices.ts#Machines.wake → src/device/agent.ts#(anonymous)',
      'src/server/notify.ts#(anonymous) → src/client/hooks.ts#(anonymous)',
    ]);
  });

  it('name every send nobody hears and every listener nobody sends to, never socket.io\'s own events', () => {
    expect(graph.unmatched.map((end) => `${end.side} ${end.name} ${end.site.file}`).sort()).toEqual([
      'sends device:awake src/device/agent.ts',
      'sends unheard src/server/wiring.ts',
    ]);
  });
});
