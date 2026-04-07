// V2 bootstrap — single entry point that wires the new server pieces (WS,
// dispatcher, v2 router) into an existing Express app + HTTP server.
//
// The legacy `src/dashboard/server.ts` calls this once at startup, passing
// in the things it already has (express app, http server, sqlite db,
// grvt client, grid engine). All the new functionality is added without
// touching the legacy code paths.
//
// To opt out (for tests, or if the v2 surface should be disabled): just
// don't call mountV2().

import type { Express } from 'express';
import type { Server as HttpServer } from 'node:http';
import type { EventEmitter } from 'node:events';
import type Database from 'sqlite3';

import { GrvtWebSocketServer } from './ws-server.js';
import { WsDispatcher } from './ws-dispatcher.js';
import { createV2Router } from './v2-router.js';
import { childLogger } from './logger.js';

const log = childLogger('v2-bootstrap');

interface GrvtClient {
  getInstruments(): Promise<unknown[]>;
  getBalance(): Promise<unknown>;
  getTicker(instrument: string): Promise<unknown>;
  getPosition(instrument: string): Promise<unknown>;
  getOpenOrders(instrument?: string): Promise<unknown[]>;
}

export interface MountV2Options {
  app: Express;
  httpServer: HttpServer;
  db: Database.Database;
  grvtClient: GrvtClient;
  engine: EventEmitter;
  apiKey: string;
}

export interface V2Handles {
  wsServer: GrvtWebSocketServer;
  dispatcher: WsDispatcher;
  shutdown: () => Promise<void>;
}

export function mountV2(opts: MountV2Options): V2Handles {
  // Mount the v2 REST router
  opts.app.use('/api/v2', createV2Router({
    db: opts.db,
    grvtClient: opts.grvtClient,
    apiKey: opts.apiKey
  }));
  log.info('mounted v2 REST router at /api/v2');

  // Mount the WebSocket server on the same HTTP server
  const wsServer = new GrvtWebSocketServer(opts.httpServer, opts.apiKey);

  // Wire the engine events + DB polling to the bus
  const dispatcher = new WsDispatcher({
    engine: opts.engine,
    db: opts.db
  });
  dispatcher.start();

  log.info('v2 server fully mounted (REST + WebSocket + dispatcher)');

  return {
    wsServer,
    dispatcher,
    shutdown: async () => {
      log.info('v2 shutdown starting');
      dispatcher.stop();
      await wsServer.close();
      log.info('v2 shutdown complete');
    }
  };
}
