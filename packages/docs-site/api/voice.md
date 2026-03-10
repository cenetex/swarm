# Voice Audio

Avatars with voice capabilities can generate spoken audio responses alongside text.

## Check Voice Support

Query the models endpoint and check `capabilities.voice`:

```bash
curl https://swarm.rati.chat/api/v1/models \
  -H "Authorization: Bearer sk-rati-xxxxx"
```

If `capabilities.voice` is `true`, the avatar supports audio generation.

## Request Audio

Add `"include_audio": true` to your chat completion request:

```bash
curl https://swarm.rati.chat/api/v1/chat/completions \
  -H "Authorization: Bearer sk-rati-xxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "avatar:rati",
    "messages": [{"role": "user", "content": "Say hello!"}],
    "include_audio": true
  }'
```

## Response

The `audio` field appears in the message when voice is generated:

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "Hello! How can I help you today?",
      "audio": {
        "url": "https://cdn.rati.chat/voice/abc123.wav",
        "format": "wav",
        "duration_ms": 2500
      }
    }
  }]
}
```

| Field | Description |
|-------|-------------|
| `url` | Temporary signed URL to the audio file (valid ~1 hour) |
| `format` | Audio format (typically `wav`) |
| `duration_ms` | Duration of the audio in milliseconds |

## Energy Cost

Audio responses cost **2 energy** per request (vs 1 for text-only).

## Limitations

- Streaming (`stream: true`) cannot be combined with `include_audio: true`
- Audio URLs are temporary and expire after approximately 1 hour
- Not all avatars have voice configured — check `capabilities.voice` first
