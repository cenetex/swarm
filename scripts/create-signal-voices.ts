/**
 * Create voices for Signal Space Miner station avatars.
 * Run: ADMIN_TABLE=SwarmAdmin-staging MEDIA_BUCKET=swarm-media-staging-022118847419 \
 *      CDN_URL=https://dodxbiygmi95j.cloudfront.net npx tsx scripts/create-signal-voices.ts
 */

import { createMyVoice, hasVoice } from '../packages/admin-api/src/services/media/voice.js';

const stations = [
  {
    avatarId: 'signal-prospect',
    description: 'Deep gravelly baritone, like a tired dock foreman. Slight rasp from years near the furnaces. Blunt, clipped delivery. Industrial, no-nonsense.',
  },
  {
    avatarId: 'signal-kepler',
    description: 'Bright mid-range tenor with infectious enthusiasm. Like a young engineer who genuinely loves their work. Quick tempo, upward inflections. Warm and welcoming.',
  },
  {
    avatarId: 'signal-helios',
    description: 'Measured alto with academic precision. Calm, unhurried, every word deliberate. Like a university professor explaining crystal structures. Slightly formal.',
  },
];

async function main() {
  for (const station of stations) {
    console.log(`\n=== ${station.avatarId} ===`);

    const existing = await hasVoice(station.avatarId);
    if (existing.hasVoice) {
      console.log(`  Already has voice: ${existing.voiceId}`);
      console.log(`  Reference: ${existing.referenceUrl}`);
      continue;
    }

    console.log(`  Creating voice: "${station.description.slice(0, 60)}..."`);
    try {
      const result = await createMyVoice({
        avatarId: station.avatarId,
        description: station.description,
        updatedBy: 'signal-setup',
      });
      console.log(`  Voice ID: ${result.voiceId}`);
      console.log(`  Preview: ${result.previewUrl}`);
      if (result.introUrl) console.log(`  Intro: ${result.introUrl}`);
    } catch (err: any) {
      console.error(`  Failed: ${err.message}`);
    }
  }
}

main().catch(console.error);
