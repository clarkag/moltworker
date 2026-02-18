import type { Sandbox, Process } from '@cloudflare/sandbox';
import type { MoltbotEnv } from '../types';
import { MOLTBOT_PORT, STARTUP_TIMEOUT_MS } from '../config';
import { buildEnvVars } from './env';
import { ensureRcloneConfig } from './r2';

function withTimeout<T>(label: string, p: Promise<T>, timeoutMs: number): Promise<T> {
  // Attach a no-op rejection handler so that if the timeout wins the race first,
  // p's eventual rejection doesn't become an unhandled promise rejection (which
  // Cloudflare Workers surface as "Exception Thrown" in wrangler logs).
  p.catch(() => {});
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
}

/**
 * Find an existing OpenClaw gateway process
 *
 * @param sandbox - The sandbox instance
 * @returns The process if found and running/starting, null otherwise
 */
export async function findExistingMoltbotProcess(sandbox: Sandbox): Promise<Process | null> {
  try {
    // Sandbox control-plane calls can occasionally hang; never let that take down
    // the request path. If we can't list quickly, treat as "unknown" and let the
    // caller fall back to a loading page / retry.
    const processes = await withTimeout('sandbox.listProcesses', sandbox.listProcesses(), 2500);
    for (const proc of processes) {
      // Match gateway process (openclaw gateway or legacy clawdbot gateway)
      // Don't match CLI commands like "openclaw devices list"
      const isGatewayProcess =
        proc.command.includes('start-openclaw.sh') ||
        proc.command.includes('openclaw gateway') ||
        // Legacy: match old startup script during transition
        proc.command.includes('start-moltbot.sh') ||
        proc.command.includes('clawdbot gateway');
      const isCliCommand =
        proc.command.includes('openclaw devices') ||
        proc.command.includes('openclaw --version') ||
        proc.command.includes('openclaw onboard') ||
        proc.command.includes('clawdbot devices') ||
        proc.command.includes('clawdbot --version');

      if (isGatewayProcess && !isCliCommand) {
        if (proc.status === 'starting' || proc.status === 'running') {
          return proc;
        }
      }
    }
  } catch (e) {
    console.log('Could not list processes:', e);
  }
  return null;
}

/**
 * Ensure the OpenClaw gateway is running
 *
 * This will:
 * 1. Mount R2 storage if configured
 * 2. Check for an existing gateway process
 * 3. Wait for it to be ready, or start a new one
 *
 * @param sandbox - The sandbox instance
 * @param env - Worker environment bindings
 * @returns The running gateway process
 */
export async function ensureMoltbotGateway(sandbox: Sandbox, env: MoltbotEnv): Promise<Process> {
  const isNetworkLost = (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    return msg.includes('Network connection lost') || msg.toLowerCase().includes('connection lost');
  };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // The Sandbox/DO can transiently drop connections (especially after deploy/DO reset).
  // Retry once on "Network connection lost" to avoid getting stuck on an endless spinner.
  const maxAttempts = 2;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Configure rclone for R2 persistence (non-blocking if not configured).
      // The startup script uses rclone to restore data from R2 on boot.
      await withTimeout('ensureRcloneConfig', ensureRcloneConfig(sandbox, env), 15000);

      // Check if gateway is already running or starting
      const existingProcess = await findExistingMoltbotProcess(sandbox);
      if (existingProcess) {
        console.log(
          'Found existing gateway process:',
          existingProcess.id,
          'status:',
          existingProcess.status,
        );

        // Always use full startup timeout - a process can be "running" but not ready yet
        // (e.g., just started by another concurrent request). Using a shorter timeout
        // causes race conditions where we kill processes that are still initializing.
        try {
          console.log('Waiting for gateway on port', MOLTBOT_PORT, 'timeout:', STARTUP_TIMEOUT_MS);
          await existingProcess.waitForPort(MOLTBOT_PORT, {
            mode: 'tcp',
            timeout: STARTUP_TIMEOUT_MS,
          });
          console.log('Gateway is reachable');
          return existingProcess;
          // eslint-disable-next-line no-unused-vars
        } catch (_e) {
          // Timeout waiting for port - process is likely dead or stuck, kill and restart
          console.log(
            'Existing process not reachable after full timeout, killing and restarting...',
          );
          try {
            await existingProcess.kill();
          } catch (killError) {
            console.log('Failed to kill process:', killError);
          }
        }
      }

      // Start a new OpenClaw gateway
      console.log('Starting new OpenClaw gateway...');
      const envVars = buildEnvVars(env);
      const command = '/usr/local/bin/start-openclaw.sh';

      console.log('Starting process with command:', command);
      console.log('Environment vars being passed:', Object.keys(envVars));

      let process: Process;
      try {
        process = await withTimeout(
          'sandbox.startProcess(start-openclaw.sh)',
          sandbox.startProcess(command, {
          env: Object.keys(envVars).length > 0 ? envVars : undefined,
          }),
          20000,
        );
        console.log('Process started with id:', process.id, 'status:', process.status);
      } catch (startErr) {
        console.error('Failed to start process:', startErr);
        throw startErr;
      }

      // Wait for the gateway to be ready
      try {
        console.log('[Gateway] Waiting for OpenClaw gateway to be ready on port', MOLTBOT_PORT);
        await process.waitForPort(MOLTBOT_PORT, { mode: 'tcp', timeout: STARTUP_TIMEOUT_MS });
        console.log('[Gateway] OpenClaw gateway is ready!');

        const logs = await process.getLogs();
        if (logs.stdout) console.log('[Gateway] stdout:', logs.stdout);
        if (logs.stderr) console.log('[Gateway] stderr:', logs.stderr);
      } catch (e) {
        console.error('[Gateway] waitForPort failed:', e);
        try {
          const logs = await process.getLogs();
          console.error('[Gateway] startup failed. Stderr:', logs.stderr);
          console.error('[Gateway] startup failed. Stdout:', logs.stdout);
          throw new Error(
            `OpenClaw gateway failed to start. Stderr: ${logs.stderr || '(empty)'}`,
            { cause: e },
          );
        } catch (logErr) {
          console.error('[Gateway] Failed to get logs:', logErr);
          throw e;
        }
      }

      // Verify gateway is actually responding
      console.log('[Gateway] Verifying gateway health...');

      return process;
    } catch (e) {
      lastErr = e;
      if (attempt < maxAttempts && isNetworkLost(e)) {
        console.warn(
          '[Gateway] Transient network loss talking to Sandbox/DO; retrying startup (attempt',
          attempt + 1,
          'of',
          maxAttempts,
          ')',
        );
        await sleep(500);
        continue;
      }
      throw e;
    }
  }

  // Should be unreachable, but keep TS happy.
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/**
 * Kick off gateway startup if needed (FAST).
 *
 * This is intended for routes like "/" and "/api/status" where we want to
 * *trigger* startup but not block on `waitForPort(...)` (which can take minutes).
 *
 * Important: `executionCtx.waitUntil(...)` tasks can be cancelled if they run too
 * long after the request ends. Keeping this function fast avoids the "endless
 * spinner" failure mode where startup never completes because the background task
 * is repeatedly cancelled.
 */
export async function kickMoltbotGateway(sandbox: Sandbox, env: MoltbotEnv): Promise<void> {
  try {
    // IMPORTANT: avoid sandbox.listProcesses (can hang) and avoid slow setup.
    // Just best-effort start the process; the script exits quickly if gateway
    // is already running.
    const envVars = buildEnvVars(env);
    const command = '/usr/local/bin/start-openclaw.sh';
    await withTimeout(
      'sandbox.startProcess(start-openclaw.sh)',
      sandbox.startProcess(command, {
        env: Object.keys(envVars).length > 0 ? envVars : undefined,
      }),
      // 15s: startProcess can take 10-15s on a freshly-reset container.
      // Too short a timeout causes the process to never get kicked.
      15000,
    );
  } catch (e) {
    // Swallow errors: callers use this for best-effort boot kicking.
    console.warn('[Gateway] kickMoltbotGateway failed (best-effort):', e);
  }
}
