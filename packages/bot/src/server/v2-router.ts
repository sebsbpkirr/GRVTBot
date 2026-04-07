// V2 REST router. New endpoints for the Ultra Dashboard.
//
// These do NOT replace the legacy /api/* endpoints in src/dashboard/server.ts
// — those keep working unchanged. v2 lives at /api/v2/* and is the surface
// the new React dashboard talks to.
//
// Auth: every v2 endpoint requires the X-Api-Key header (matching
// process.env.DASHBOARD_API_KEY). The legacy basic-auth endpoints stay as-is
// for backward compat with the current HTML dashboard.
//
// Caching: hot endpoints (instruments, balance, prices) go through the
// shared TtlCache so dashboard polls don't hammer GRVT.

import { Router, type Request, type Response, type NextFunction } from 'express';
import type Database from 'sqlite3';
import { childLogger } from './logger.js';
import { cache } from './cache.js';

const log = childLogger('v2-router');

// ─── Types ─────────────────────────────────────────────────────────────
interface GrvtClient {
  getInstruments(): Promise<unknown[]>;
  getBalance(): Promise<unknown>;
  getTicker(instrument: string): Promise<unknown>;
  getPosition(instrument: string): Promise<unknown>;
  getOpenOrders(instrument?: string): Promise<unknown[]>;
}

export interface V2RouterDeps {
  db: Database.Database;
  grvtClient: GrvtClient;
  apiKey: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────
function dbAll<T = unknown>(db: Database.Database, sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve((rows as T[]) ?? []);
    });
  });
}

function dbGet<T = unknown>(db: Database.Database, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row as T | undefined);
    });
  });
}

// ─── Auth middleware ───────────────────────────────────────────────────
function makeAuthMiddleware(apiKey: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const provided = req.header('x-api-key');
    if (provided !== apiKey) {
      log.warn({ ip: req.ip, path: req.path }, 'rejected unauthenticated v2 request');
      return res.status(401).json({ error: 'unauthorized', hint: 'set X-Api-Key header' });
    }
    next();
    return;
  };
}

// ─── Error wrapper ─────────────────────────────────────────────────────
type AsyncHandler = (req: Request, res: Response) => Promise<unknown>;
function asyncHandler(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

// ─── The router ────────────────────────────────────────────────────────
export function createV2Router(deps: V2RouterDeps): Router {
  const { db, grvtClient, apiKey } = deps;
  const router = Router();

  // All endpoints below require API key
  router.use(makeAuthMiddleware(apiKey));

  // ── GET /api/v2/bots ──────────────────────────────────────────────
  // List all bots with the fields the dashboard cares about.
  router.get('/bots', asyncHandler(async (_req, res) => {
    const rows = await dbAll(db, `
      SELECT id, pair, direction, leverage, lower_price, upper_price, num_grids,
             investment_usdt, grid_profit_usdt, trend_pnl_usdt, total_pnl_usdt,
             status, position_size, avg_entry_price, liquidation_price,
             created_at, updated_at
      FROM grid_bots
      ORDER BY created_at DESC
    `);
    res.json({ bots: rows });
    return;
  }));

  // ── GET /api/v2/bots/:id ──────────────────────────────────────────
  router.get('/bots/:id', asyncHandler(async (req, res) => {
    const id = parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid bot id' });
    const bot = await dbGet(db, `SELECT * FROM grid_bots WHERE id = ?`, [id]);
    if (!bot) return res.status(404).json({ error: 'bot not found' });
    res.json({ bot });
    return;
  }));

  // ── GET /api/v2/bots/:id/grid-state ───────────────────────────────
  // The combined payload the GridChart needs in one round-trip:
  // grid levels + active orders + current price + position. Saves the
  // dashboard from making 4 separate requests on every refresh.
  router.get('/bots/:id/grid-state', asyncHandler(async (req, res) => {
    const id = parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid bot id' });

    const bot = await dbGet<{ pair: string; status: string }>(
      db,
      `SELECT pair, status FROM grid_bots WHERE id = ?`,
      [id]
    );
    if (!bot) return res.status(404).json({ error: 'bot not found' });

    // Pull the level rows from the local DB. Grid levels are the source
    // of truth for what the bot WANTS to be doing. The orders array is what
    // GRVT actually has.
    const levels = await dbAll(db, `
      SELECT id, level_index, price, side, quantity, is_filled, pending_replace, order_id
      FROM grid_levels
      WHERE bot_id = ?
      ORDER BY level_index
    `, [id]);

    // Live data from GRVT (cached 2s).
    const [ticker, position, openOrders] = await Promise.all([
      cache.getOrFetch(`ticker:${bot.pair}`, 2_000, () => grvtClient.getTicker(bot.pair)),
      cache.getOrFetch(`position:${bot.pair}`, 2_000, () => grvtClient.getPosition(bot.pair)),
      cache.getOrFetch(`openOrders:${bot.pair}`, 2_000, () => grvtClient.getOpenOrders(bot.pair))
    ]);

    res.json({
      botId: id,
      pair: bot.pair,
      status: bot.status,
      levels,
      ticker,
      position,
      openOrders,
      ts: Date.now()
    });
    return;
  }));

  // ── GET /api/v2/instruments ───────────────────────────────────────
  // Cached 60s — instruments don't change minute-to-minute.
  router.get('/instruments', asyncHandler(async (_req, res) => {
    const data = await cache.getOrFetch('instruments', 60_000, () => grvtClient.getInstruments());
    res.json({ instruments: data });
    return;
  }));

  // ── GET /api/v2/balance ───────────────────────────────────────────
  // Cached 2s.
  router.get('/balance', asyncHandler(async (_req, res) => {
    const data = await cache.getOrFetch('balance', 2_000, () => grvtClient.getBalance());
    res.json({ balance: data });
    return;
  }));

  // ── GET /api/v2/bots/:id/trades ───────────────────────────────────
  router.get('/bots/:id/trades', asyncHandler(async (req, res) => {
    const id = parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid bot id' });
    const limit = Math.min(parseInt((req.query.limit as string) ?? '100', 10) || 100, 1000);
    const trades = await dbAll(db, `
      SELECT id, side, quantity, price, fee, round_trip_profit, created_at
      FROM trades
      WHERE bot_id = ?
      ORDER BY id DESC
      LIMIT ?
    `, [id, limit]);
    res.json({ trades });
    return;
  }));

  // ── GET /api/v2/bots/:id/snapshots ────────────────────────────────
  router.get('/bots/:id/snapshots', asyncHandler(async (req, res) => {
    const id = parseInt(String(req.params.id ?? ''), 10);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid bot id' });
    const snapshots = await dbAll(db, `
      SELECT * FROM daily_snapshots WHERE bot_id = ? ORDER BY date DESC LIMIT 365
    `, [id]);
    res.json({ snapshots });
    return;
  }));

  // ── GET /api/v2/bots/:id/roundtrips ───────────────────────────────
  // Used for the win-rate stat and the fills feed.
  router.get('/bots/:id/roundtrips', asyncHandler(async (req, res) => {
    void parseInt(String(req.params.id ?? ''), 10);  // accept but ignore for v0
    // paired_roundtrips doesn't have bot_id yet (Phase B migration). For now
    // return all of them — we only have one bot anyway.
    const roundtrips = await dbAll(db, `
      SELECT id, buy_fill_id, sell_fill_id, buy_price, sell_price, size, profit, created_at
      FROM paired_roundtrips
      ORDER BY id DESC
      LIMIT 1000
    `);
    const total = await dbGet<{ c: number; sum: number }>(db, `
      SELECT COUNT(*) as c, COALESCE(SUM(profit), 0) as sum FROM paired_roundtrips
    `);
    res.json({ roundtrips, count: total?.c ?? 0, totalProfit: total?.sum ?? 0 });
    return;
  }));

  // ── GET /api/v2/health ────────────────────────────────────────────
  // Detailed health for the dashboard. Different shape from /api/health
  // (which is for systemd / external monitors).
  router.get('/health', asyncHandler(async (_req, res) => {
    const botCount = await dbGet<{ c: number }>(db, `SELECT COUNT(*) as c FROM grid_bots WHERE status = 'running'`);
    res.json({
      status: 'ok',
      uptime: Math.floor(process.uptime()),
      runningBots: botCount?.c ?? 0,
      cacheSize: cache.size(),
      memory: {
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
      },
      ts: Date.now()
    });
    return;
  }));

  // Error handler — turn anything thrown by an asyncHandler into JSON
  router.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error({ err: err.message, stack: err.stack }, 'v2 endpoint error');
    res.status(500).json({ error: 'internal_error', message: err.message });
  });

  return router;
}
