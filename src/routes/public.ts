import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { MOLTBOT_PORT } from '../config';
import { kickMoltbotGateway, findExistingMoltbotProcess } from '../gateway';

/**
 * Public routes - NO Cloudflare Access authentication required
 *
 * These routes are mounted BEFORE the auth middleware is applied.
 * Includes: health checks, static assets, and public API endpoints.
 */
const publicRoutes = new Hono<AppEnv>();

// GET /sandbox-health - Health check endpoint
publicRoutes.get('/sandbox-health', (c) => {
  return c.json({
    status: 'ok',
    service: 'moltbot-sandbox',
    gateway_port: MOLTBOT_PORT,
  });
});

// GET /logo.png - Serve logo from ASSETS binding
publicRoutes.get('/logo.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /logo-small.png - Serve small logo from ASSETS binding
publicRoutes.get('/logo-small.png', (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

// GET /api/status - Public health check for gateway status (no auth required)
publicRoutes.get('/api/status', async (c) => {
  const sandbox = c.get('sandbox');
  const PORT = 18789;

  const probeGateway = async (timeoutMs: number): Promise<boolean> => {
    // Probe the gateway directly. This avoids relying solely on listProcesses(),
    // which can be transiently slow/unavailable and would otherwise cause the UI
    // to show "Starting container..." forever even when the gateway is up.
    try {
      const url = `http://localhost:${PORT}/`;
      const resp = await Promise.race([
        sandbox.containerFetch(new Request(url), PORT),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('probe timeout')), timeoutMs),
        ),
      ]);
      // Any HTTP response means something is listening on the port.
      return !!resp;
    } catch {
      return false;
    }
  };

  try {
    const process = await findExistingMoltbotProcess(sandbox);
    if (!process) {
      // If we couldn't find a process (or listProcesses timed out), still try a
      // quick direct probe in case the gateway is already up.
      if (await probeGateway(1200)) {
        return c.json({ ok: true, status: 'running', processId: null });
      }

      // Kick off boot in the background so the loading page's poll can
      // eventually flip to "running" without requiring a separate request.
      c.executionCtx.waitUntil(
        kickMoltbotGateway(sandbox, c.env),
      );
      return c.json({ ok: false, status: 'not_running' });
    }

    // Process exists, check if it's actually responding
    // Try to reach the gateway with a short timeout
    try {
      await process.waitForPort(PORT, { mode: 'tcp', timeout: 5000 });
      return c.json({ ok: true, status: 'running', processId: process.id });
    } catch {
      // Port check might fail transiently; probe HTTP once before declaring not_responding.
      if (await probeGateway(1500)) {
        return c.json({ ok: true, status: 'running', processId: process.id });
      }

      // Process exists but isn't responding yet; re-kick boot in case the
      // container/gateway got into a stuck transitional state.
      c.executionCtx.waitUntil(
        kickMoltbotGateway(sandbox, c.env),
      );
      return c.json({ ok: false, status: 'not_responding', processId: process.id });
    }
  } catch (err) {
    return c.json({
      ok: false,
      status: 'error',
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

// GET /_admin/assets/* - Admin UI static assets (CSS, JS need to load for login redirect)
// Assets are built to dist/client with base "/_admin/"
publicRoutes.get('/_admin/assets/*', async (c) => {
  const url = new URL(c.req.url);
  // Rewrite /_admin/assets/* to /assets/* for the ASSETS binding
  const assetPath = url.pathname.replace('/_admin/assets/', '/assets/');
  const assetUrl = new URL(assetPath, url.origin);
  return c.env.ASSETS.fetch(new Request(assetUrl.toString(), c.req.raw));
});

export { publicRoutes };
