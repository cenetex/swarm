# Voice Message Mode Spec

## Summary
Enable agents to understand inbound voice messages and respond with voice messages. This spans:
1) Hearing: accept platform audio, use audio-capable LLMs when available, otherwise transcribe to text.
2) Speaking: generate a voice profile (Stable Audio -> Voice Clone) and synthesize speech for replies.

This spec focuses on Telegram first, but the MCP and pipeline should be platform-agnostic.

## Goals
- Inbound voice: extract audio from Telegram updates and produce agent-understandable content.
- Outbound voice: generate voice audio and send as Telegram voice message.
- MCP: define a toolset that covers transcription, voice profile creation, and TTS.
- Track assets/jobs in DynamoDB and S3 (or existing media storage).

## Non-goals
- UI polish for voice studio (only a functional flow).
- High-fidelity voice editing features (fine-tuning, multi-speaker, etc.).
- Supporting all platforms initially.

## User Flows
### Inbound voice (Telegram)
1. User sends a voice message to the bot.
2. Telegram webhook extracts audio file info.
3. Audio file is downloaded and stored in S3 (AudioAsset).
4. If the agent's current OpenRouter model supports audio input, the audio is sent to the LLM.
5. Otherwise, run transcription and pass transcript text to the LLM.
6. Agent responds with text or voice depending on voice mode settings.

### Outbound voice (Telegram)
1. Agent decides to send a voice reply.
2. System generates speech from text using a VoiceProfile.
3. Voice audio is stored and sent as a Telegram voice message.

### Voice profile creation
1. User requests voice mode setup in Admin UI.
2. System generates a seed audio clip via Stable Audio.
3. Voice clone uses the seed clip to create a VoiceProfile.
4. User previews the voice and sets it as active for the agent.

## Architecture
### Components
- MCP tools: voice creation, transcription, TTS, send voice message.
- Audio pipeline: asset storage, job execution, retrieval.
- Platform adapters: Telegram parsing + sending voice.
- Admin UI: configure voice mode and set active voice profile.

### High-level flow (inbound)
Telegram update -> Telegram adapter -> AudioAsset -> (audio-capable LLM or transcription) -> LLM -> response

### High-level flow (outbound)
LLM response -> generate_voice_message -> AudioAsset -> Telegram sendVoice

## Data Model
### AudioAsset (new)
- assetId: string
- agentId: string
- source: 'telegram' | 'upload' | 'stable-audio' | 'tts'
- format: 'ogg' | 'mp3' | 'wav'
- durationMs: number
- url: string
- createdAt: number

### VoiceProfile (new)
- voiceId: string
- agentId: string
- status: 'creating' | 'ready' | 'failed'
- provider: 'stable-audio' | 'voice-clone'
- seedAssetId: string
- cloneAssetId?: string
- config?: { speed?: number; pitch?: number; format?: string }
- createdAt: number
- updatedAt: number

### VoiceConfig (new agent config)
- enabled: boolean
- defaultVoiceId?: string
- ttsProvider?: 'voice-clone'
- speed?: number
- pitch?: number
- format?: 'ogg' | 'mp3' | 'wav'

### AudioJob (reuse media jobs)
- jobId: string
- type: 'stable_audio' | 'voice_clone' | 'tts'
- status: 'pending' | 'processing' | 'completed' | 'failed'
- input: { prompt?: string; text?: string; voiceId?: string; seedAssetId?: string }
- outputAssetId?: string

## MCP Design
Create a new tool set in `packages/mcp-server/src/tools/voice.ts`.

### Tool: transcribe_audio
Purpose: Convert audio to text for LLM context.
Input:
- assetId?: string
- url?: string
- platformFileId?: string
- language?: string
- model?: string
Output:
- text: string
- language?: string
- confidence?: number
- segments?: Array<{ startMs: number; endMs: number; text: string }>

### Tool: create_voice_seed
Purpose: Generate a seed audio clip using Stable Audio.
Input:
- prompt: string
- durationMs: number
- styleTags?: string[]
- negativeTags?: string[]
Output:
- assetId: string
- url: string

### Tool: clone_voice_from_seed
Purpose: Create a voice clone from a seed audio asset.
Input:
- seedAssetId: string
- name?: string
Output:
- voiceId: string
- status: 'creating' | 'ready' | 'failed'
- previewAssetId?: string

### Tool: create_voice_profile
Purpose: Orchestrate seed + clone and return a VoiceProfile.
Input:
- seedPrompt?: string
- seedAssetId?: string
- voiceName?: string
Output:
- voiceId: string
- status: 'creating' | 'ready' | 'failed'

### Tool: set_active_voice_profile
Purpose: Set the default voice for an agent.
Input:
- voiceId: string
Output:
- success: boolean

### Tool: generate_voice_message
Purpose: Generate speech audio from text.
Input:
- text: string
- voiceId?: string
- format?: 'ogg' | 'mp3' | 'wav'
- speed?: number
- pitch?: number
- emotion?: string
- maxDurationMs?: number
Output:
- assetId: string
- url: string
- durationMs: number

### Tool: send_voice_message
Purpose: Send voice audio to a platform.
Input:
- conversationId: string
- assetId?: string
- url?: string
- caption?: string
- replyToMessageId?: string
Output:
- success: boolean

## OpenRouter Audio Support
Add model capability detection:
- Store model modality metadata (text vs audio).
- Gate audio inputs based on model capabilities.
- If not supported, always transcribe.

## Telegram Integration (Gap Analysis)
### Current state
- Telegram MCP tools do not handle voice/audio.
- Telegram adapter does not parse `message.voice` or `message.audio`.
- Response actions do not include `send_voice`.

### Required changes
Inbound:
- Parse Telegram `voice` and `audio` into `MessageContent.media` with `type: 'audio'`.
- Download file from Telegram API and store in S3 (create AudioAsset).
- Pass AudioAsset or transcription into the LLM pipeline.

Outbound:
- Add `send_voice` or extend `send_media` to support audio.
- Use Telegram `sendVoice` or `sendAudio` in the adapter.

MCP:
- Add `send_voice_message` tool with Telegram platform binding.
- Provide transcription and TTS tools in MCP.

## Admin UI Changes
- Add a Voice Mode section to agent configuration.
- Workflow to create seed and clone voice.
- Voice preview playback.
- Toggle for voice replies per agent.

## Infrastructure
- S3 bucket for audio assets (reuse media bucket if possible).
- DynamoDB tables for VoiceProfile and AudioAsset (can share Admin table with prefixes).
- Media jobs queue for audio generation.

## Observability
- Log structured events: audio_received, transcription_started, transcription_completed, tts_started, tts_completed.
- Track job status in admin UI.

## Rollout
Phase 1:
- Telegram inbound audio extraction + transcription fallback.
- Text-only replies.

Phase 2:
- Voice profile creation and TTS.
- Telegram outbound voice messages.

Phase 3:
- Audio-capable OpenRouter models and end-to-end audio flow.

## Open Questions
- Which OpenRouter models are allowed for audio input in prod?
- Which transcription provider and cost caps?
- Voice cloning provider constraints and acceptable latency?
