import express from 'express';
import { Server as SocketServer } from 'socket.io';
import { TemporalBridge } from './services/TemporalBridge.js';
/**
 * APPLICATION BOOTSTRAP
 *
 * The side-channel `TemporalBridge` is used by mutating API routes to route
 * through the long-lived Temporal workflow persistence engine.  All other
 * reads stay on the Local DB so they don't block until the workflow ends.
 */
export declare function bootstrap(): Promise<{
    app: express.Application;
    io: SocketServer;
    temporalBridge?: TemporalBridge;
}>;
//# sourceMappingURL=index.d.ts.map