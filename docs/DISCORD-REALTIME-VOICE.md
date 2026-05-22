# Discord Realtime Voice

Discord is the first supported live voice-call surface for avatars. Telegram and
X/Twitter remain async voice surfaces in this repo: Telegram bots can send voice
messages, and X can publish media links, but neither current integration lets a
bot-token avatar join and speak in a live call.

## User Flow

1. A Discord avatar must be active and have `platforms.discord.enabled=true`.
2. Voice must be opted in for that avatar:

   ```json
   {
     "platforms": {
       "discord": {
         "enabled": true,
         "mode": "bot",
         "voice": {
           "enabled": true,
           "autoJoinOnMention": true,
           "maxSessionSeconds": 600
         }
       }
     }
   }
   ```

3. A human joins a Discord voice channel.
4. The human mentions the avatar bot in a guild text channel the avatar can read.
5. The Discord gateway checks that the sender is currently in voice, then starts
   a short-lived Fargate task for that voice session.

The practical "call" gesture is therefore: join voice, then mention or reply to
the avatar in text.

## Architecture

- `discord-gateway-shared.ts` stays as the always-on control plane.
- The gateway subscribes to `GUILD_VOICE_STATES` and keeps an in-memory
  guild/user to voice-channel map.
- On a qualifying mention, the gateway launches the `DiscordVoiceWorker` Fargate
  task via ECS `RunTask`.
- The worker opens its own minimal Discord Gateway connection, joins the target
  voice channel, plays an avatar greeting audio asset when media storage and
  voice config are available, then listens for bounded user speech turns.
- User speech is captured from Discord voice receive, wrapped as Ogg/Opus,
  transcribed with the avatar's OpenAI key, passed through the avatar LLM prompt,
  generated as cloned voice audio, and played back into the same voice channel.

This keeps idle cost bounded to the existing gateway task. Voice sessions spend
Fargate only while a call is active.

## Controls

Avatar config:

- `platforms.discord.voice.enabled`: opt in to live voice.
- `platforms.discord.voice.autoJoinOnMention`: join when mentioned by a user in
  voice. Defaults to `true` only when voice is enabled.
- `platforms.discord.voice.maxSessionSeconds`: upper bound for a worker session.
- `platforms.discord.voice.allowedVoiceChannelIds`: optional allow-list of voice
  channel IDs.

Gateway environment:

- `DISCORD_VOICE_WORKER_ENABLED=true`
- `DISCORD_VOICE_WORKER_CLUSTER_ARN`
- `DISCORD_VOICE_WORKER_TASK_DEFINITION_ARN`
- `DISCORD_VOICE_WORKER_SUBNET_IDS`
- `DISCORD_VOICE_WORKER_SECURITY_GROUP_IDS`
- `DISCORD_VOICE_WORKER_CONTAINER_NAME`

Worker environment is set by the gateway at launch and includes the avatar,
guild, text-channel, voice-channel, trigger message, trigger user, state table,
secret prefix, and media settings. Bot tokens are never passed through ECS task
overrides; the worker loads them from Secrets Manager.

Worker duplex tuning:

- `DISCORD_VOICE_IDLE_SECONDS`: end the session after no handled speech or
  playback, default `90`.
- `DISCORD_VOICE_TURN_SILENCE_MS`: silence duration that closes a user turn,
  default `1200`.
- `DISCORD_VOICE_MAX_TURN_MS`: hard cap for one captured speech turn, default
  `12000`.
- `DISCORD_VOICE_MAX_TURN_BYTES`: hard cap for one Ogg/Opus capture, default
  `2000000`.
- `DISCORD_VOICE_TRANSCRIBE_MODEL`: OpenAI transcription model, default
  `whisper-1`.

## Current Boundary

This slice implements bounded live speech-to-speech turns. It is not yet a
sample-level realtime model session: speech is processed turn-by-turn after
silence, and playback is serialized so the worker does not listen while it is
speaking. The next layer is interruptible playback and lower-latency streaming
recognition/model output.
