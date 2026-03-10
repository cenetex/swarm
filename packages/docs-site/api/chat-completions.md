# Chat Completions

Generate a chat response from an avatar.

```
POST /v1/chat/completions
```

## Request Body

```json
{
  "model": "avatar:rati",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Hello!"}
  ],
  "temperature": 0.8,
  "max_tokens": 1024,
  "include_audio": false
}
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `model` | string | Yes | Avatar ID: `avatar:name` or just `name` |
| `messages` | array | Yes | Conversation history |
| `temperature` | number | No | Sampling temperature (0-2), default varies by avatar |
| `max_tokens` | number | No | Maximum tokens to generate |
| `stream` | boolean | No | Enable [SSE streaming](/api/streaming). Cannot be combined with `include_audio`. |
| `user` | string | No | Optional user identifier for tracking |
| `include_audio` | boolean | No | Generate [voice audio](/api/voice) with response |

### Message Roles

- `system` — System instructions (optional; avatar persona is used if omitted)
- `user` — User messages
- `assistant` — Previous assistant responses (for multi-turn context)

## Response

```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1706644800,
  "model": "avatar:rati",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you today?"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 15,
    "completion_tokens": 10,
    "total_tokens": 25
  }
}
```

When `include_audio: true` and the avatar has voice configured, the message includes an `audio` field:

```json
{
  "message": {
    "role": "assistant",
    "content": "Hello!",
    "audio": {
      "url": "https://cdn.rati.chat/voice/abc123.wav",
      "format": "wav",
      "duration_ms": 2500
    }
  }
}
```

## Example

```bash
curl -X POST https://swarm.rati.chat/api/v1/chat/completions \
  -H "Authorization: Bearer sk-rati-xxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "avatar:rati",
    "messages": [
      {"role": "user", "content": "What is the meaning of life?"}
    ]
  }'
```
