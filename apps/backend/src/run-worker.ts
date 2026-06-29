#!/usr/bin/env node
import './worker.ts';
import { WorkerService, WorkerState } from './services/WorkerService.js';
import bootstrap from './index.js';
import { LocalDB } from './lib/db.js';
import { temporalBridge } from './services/TemporalBridge.js';
import { AppService } from './services/AppService.js';

void bootstrap(() => {
  console.log('Worker entry point loaded');
});
