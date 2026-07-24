import { createCloudflareHostedPlatform } from './platform.js';
import type { CloudflareHostedBindings } from './bindings.js';
import { parseHostingStatus } from '@swarm/core';

type ScheduledController = {
  scheduledTime: number;
  cron: string;
};

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
}

export default {
  async fetch(request: Request, env: CloudflareHostedBindings): Promise<Response> {
    const url = new URL(request.url);
    const platform = createCloudflareHostedPlatform(env);
    if (url.pathname === '/health') {
      return json({
        status: 'ok',
        backend: platform.descriptor.kind,
        mode: platform.descriptor.mode,
        capabilities: platform.descriptor.capabilities,
        environment: env.SWARM_ENV ?? 'development',
      });
    }
    if (url.pathname === '/api/hosting/status') {
      return json(parseHostingStatus({
        mode: 'local',
        local: {
          available: false,
          running: false,
          label: 'This device',
          detail: 'Local mode runs from the native app and is not managed by this hosted Worker.',
        },
        hosted: {
          available: false,
          configured: false,
          label: 'Hosted 24/7',
          priceUsdMonthly: 9,
          provider: platform.descriptor.kind,
          architecture: 'cloudflare-worker-scaffold',
          status: 'not-configured',
          entitlement: 'none',
          detail: 'Hosted checkout, encrypted user secrets, coordination, and runtime provisioning are not connected.',
        },
      }));
    }
    return json({ error: 'Cloudflare hosted Swarm route not implemented yet' }, { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: CloudflareHostedBindings): Promise<void> {
    const platform = createCloudflareHostedPlatform(env);
    await platform.queues.send('default', {
      type: 'swarm.cron.tick',
      payload: {
        cron: controller.cron,
        scheduledTime: controller.scheduledTime,
      },
    });
  },
};
