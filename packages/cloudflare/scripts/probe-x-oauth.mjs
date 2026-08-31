import {
  HostedXProviderError,
  probeHostedXConfiguration,
} from '../src/hosted-x.ts';

try {
  const publicUrl = process.env.SWARM_PUBLIC_URL?.trim() ?? '';
  if (!publicUrl) throw new Error('SWARM_PUBLIC_URL is required.');
  const callbackUrl = `${new URL(publicUrl).origin}/api/auth/x/callback`;
  await probeHostedXConfiguration(
    {
      SWARM_X_API_KEY: process.env.SWARM_X_API_KEY,
      SWARM_X_API_SECRET: process.env.SWARM_X_API_SECRET,
    },
    callbackUrl,
  );
  console.log(`X OAuth probe passed for ${callbackUrl}.`);
} catch (error) {
  if (error instanceof HostedXProviderError) {
    const status = error.status === 0 ? 'network error' : `HTTP ${error.status}`;
    console.error(`X OAuth probe failed: ${error.message} (${status}).`);
  } else {
    console.error(`X OAuth probe failed: ${error instanceof Error ? error.message : 'Unknown error.'}`);
  }
  process.exitCode = 1;
}
