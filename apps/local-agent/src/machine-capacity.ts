import os from 'node:os';
import type { MachineCapacity } from '@koala/engine-core';

export interface CapacityHost {
  cpus(): number;
  totalMemory(): number;
}

export const osCapacity: CapacityHost = {
  cpus: () => os.availableParallelism(),
  totalMemory: () => os.totalmem(),
};

export const machineCapacity = (host: CapacityHost = osCapacity): MachineCapacity => ({
  cpuCores: host.cpus(),
  memoryMiB: Math.floor(host.totalMemory() / 1024 / 1024),
});
