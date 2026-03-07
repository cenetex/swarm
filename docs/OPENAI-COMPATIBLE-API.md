# OpenAI-Compatible Chat API

The Swarm platform provides an OpenAI-compatible API that allows external applications to chat with avatars using the familiar `/v1/chat/completions` format.

## Base URL

```
https://swarm.rati.chat/api/v1
```

(Or your custom API domain)

## Authentication

All requests require an API key in the `Authorization` header:

```bash
Authorization: Bearer sk-your-api-key-here
```

### Creating API Keys

#### Avatar-Scoped Key (Recommended)
Create an API key that only works with a specific avatar:

```bash
curl -X POST https://swarm.rati.chat/api/avatars/{avatarId}/api-keys \
  -H "Content-Type: application/json" \
  -H "Cookie: swarm_session=..." \
  -d '{"name": "My Integration"}'
```

Response:
```json
{
  "apiKey": "sk-abc123...",
  "keyPrefix": "sk-abc123...",
  "message": "API key created. Save this key - it will not be shown again."
}
```

#### Wildcard Key (Admin Only)
Create an API key that can access all avatars:

```bash
curl -X POST https://swarm.rati.chat/api/api-keys \
  -H "Content-Type: application/json" \
  -H "Cookie: swarm_session=..." \
  -d '{"name": "Admin Integration"}'
```

**⚠️ Warning:** Save your API key immediately! It will only be shown once.

---

## Endpoints

### List Available Avatars

```bash
GET /v1/models
```

Lists all avatars available to your API key.

**Response:**
```json
{
  "object": "list",
  "data": [
    {
      "id": "avatar:my-bot",
      "object": "model",
      "created": 1706644800,
      "owned_by": "swarm",
      "permission": [],
      "root": "my-bot",
      "parent": null,
      "capabilities": {
        "voice": true
      },
      "avatar": {
        "name": "My Bot",
        "description": "A helpful assistant",
        "profile_image": "https://cdn.rati.chat/avatars/my-bot/profile.png"
      }
    }
  ]
}
```

The `capabilities.voice` field indicates whether the avatar has voice generation enabled. If `true`, you can use `include_audio: true` in chat requests.

---

### Get Model Details

```bash
GET /v1/models/{model_id}
```

Get detailed information about a specific avatar, including profile images, platform presence, and capabilities.

**Response:**
```json
{
  "id": "avatar:my-bot",
  "object": "model",
  "created": 1706644800,
  "owned_by": "swarm",
  "permission": [],
  "root": "my-bot",
  "parent": null,
  "capabilities": {
    "voice": true
  },
  "avatar": {
    "id": "my-bot",
    "name": "My Bot",
    "description": "A helpful assistant",
    "profile_image": "https://cdn.rati.chat/avatars/my-bot/profile.png",
    "character_reference": "https://cdn.rati.chat/avatars/my-bot/character.png",
    "platforms": {
      "telegram": {
        "username": "mybot",
        "home_channel": "https://t.me/mybotchat"
      },
      "twitter": {
        "username": "mybot"
      },
      "discord": null
    },
    "voice": {
      "style": "voice-clone"
    },
    "sticker_pack": {
      "name": "mybot_stickers",
      "title": "My Bot Stickers",
      "count": 12
    }
  }
}
```

---

### Chat Completions

```bash
POST /v1/chat/completions
```

Generate a chat completion from an avatar.

**Request Body:**
```json
{
  "model": "avatar:my-bot",
  "messages": [
    {"role": "system", "content": "You are a helpful assistant."},
    {"role": "user", "content": "Hello!"}
  ],
  "temperature": 0.8,
  "max_tokens": 1024,
  "include_audio": true
}
```

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `model` | string | Yes | Avatar ID, either as `avatar:my-bot` or just `my-bot` |
| `messages` | array | Yes | Array of message objects with `role` and `content` |
| `temperature` | number | No | Sampling temperature (0-2), default varies by avatar |
| `max_tokens` | number | No | Maximum tokens to generate |
| `stream` | boolean | No | Enable SSE streaming (see [Streaming](#streaming) below). Cannot be combined with `include_audio`. |
| `user` | string | No | Optional user identifier for tracking |
| `include_audio` | boolean | No | Generate voice audio for the response (requires avatar with voice configured) |

**Message Roles:**
- `system` - System instructions (optional, avatar persona is used if not provided)
- `user` - User messages
- `assistant` - Previous assistant responses (for context)

**Response:**
```json
{
  "id": "chatcmpl-abc123",
  "object": "chat.completion",
  "created": 1706644800,
  "model": "avatar:my-bot",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Hello! How can I help you today?",
        "audio": {
          "url": "https://cdn.rati.chat/voice/abc123.wav",
          "format": "wav",
          "duration_ms": 2500
        }
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

The `audio` field is only present when:
1. `include_audio: true` was specified in the request
2. The avatar has voice generation configured and enabled

---

### Streaming

Set `stream: true` to receive the response in OpenAI-compatible Server-Sent Events (SSE) format. This is useful for clients that expect the standard OpenAI streaming protocol (e.g., the OpenAI SDKs with `stream=True`).

**Note:** Because the API runs on AWS Lambda behind API Gateway, the full response is generated first and then delivered as SSE-formatted chunks in a single HTTP response. This means latency to first byte is the same as a non-streaming request, but the response format is compatible with SSE parsers.

**Streaming cannot be combined with `include_audio: true`.** If both are set, the API returns a 400 error.

**SSE Chunk Format:**

Each SSE event is a `data:` line containing a JSON `chat.completion.chunk` object:

```
data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1706644800,"model":"avatar:my-bot","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1706644800,"model":"avatar:my-bot","choices":[{"index":0,"delta":{"content":"Hello! How can I help you today?"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1706644800,"model":"avatar:my-bot","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":15,"completion_tokens":10,"total_tokens":25}}

data: [DONE]
```

**Chunk sequence:**
1. **Role chunk** - `delta.role` set to `"assistant"` with empty content
2. **Content chunk(s)** - `delta.content` with the response text
3. **Final chunk** - empty `delta`, `finish_reason: "stop"`, and `usage` object
4. **Done sentinel** - `data: [DONE]` signals the stream is complete

**Streaming Example (Python):**

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-your-key",
    base_url="https://swarm.rati.chat/api/v1"
)

stream = client.chat.completions.create(
    model="avatar:my-bot",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)

for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

**Streaming Example (JavaScript):**

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'sk-your-key',
  baseURL: 'https://swarm.rati.chat/api/v1',
});

const stream = await client.chat.completions.create({
  model: 'avatar:my-bot',
  messages: [{ role: 'user', content: 'Hello!' }],
  stream: true,
});

for await (const chunk of stream) {
  const content = chunk.choices[0]?.delta?.content;
  if (content) process.stdout.write(content);
}
```

**Error handling in streaming:** If an error occurs during generation, the error message is emitted as a content delta chunk followed by the `[DONE]` sentinel, with HTTP status 200 (since SSE headers are already sent).

---

## Example Usage

### cURL

```bash
curl -X POST https://swarm.rati.chat/api/v1/chat/completions \
  -H "Authorization: Bearer sk-your-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "avatar:my-bot",
    "messages": [
      {"role": "user", "content": "What is the meaning of life?"}
    ]
  }'
```

### Python (OpenAI SDK)

The official OpenAI Python SDK works seamlessly:

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-your-key",
    base_url="https://swarm.rati.chat/api/v1"
)

response = client.chat.completions.create(
    model="avatar:my-bot",
    messages=[
        {"role": "user", "content": "Hello!"}
    ]
)

print(response.choices[0].message.content)
```

### JavaScript/TypeScript (OpenAI SDK)

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'sk-your-key',
  baseURL: 'https://swarm.rati.chat/api/v1',
});

const response = await client.chat.completions.create({
  model: 'avatar:my-bot',
  messages: [
    { role: 'user', content: 'Hello!' }
  ],
});

console.log(response.choices[0].message.content);
```

### LangChain

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    api_key="sk-your-key",
    base_url="https://swarm.rati.chat/api/v1",
    model="avatar:my-bot"
)

response = llm.invoke("Hello!")
print(response.content)
```

---

## Error Responses

Errors follow the OpenAI format:

```json
{
  "error": {
    "message": "Invalid API key",
    "type": "authentication_error",
    "code": "invalid_api_key"
  }
}
```

**Common Error Codes:**

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `missing_api_key` | 401 | No Authorization header provided |
| `invalid_api_key` | 401 | API key not found or disabled |
| `unauthorized_avatar` | 403 | API key not authorized for requested avatar |
| `avatar_not_found` | 404 | Avatar ID doesn't exist |
| `unsupported_stream_audio` | 400 | `stream: true` and `include_audio: true` cannot be combined |

---

## Rate Limits

Rate limits are applied per API key:

- **Default:** 100 requests/minute, 1000 requests/day
- **Custom limits:** Can be configured per API key

Rate limit headers are included in responses:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1706644860
```

---

## Limitations

1. **Streaming is buffered** - `stream: true` returns SSE-formatted chunks, but the response is buffered by Lambda/API Gateway (not true token-by-token streaming)
2. **No function calling** - Tools/function calling is not exposed through this API
3. **No image generation** - Media generation tools are not available
4. **Token counting is approximate** - Usage stats use character-based estimation

---

## Best Practices

1. **Use avatar-scoped keys** - Only create wildcard keys when absolutely necessary
2. **Rotate keys regularly** - Create new keys and disable old ones periodically
3. **Store keys securely** - Use environment variables or secret managers
4. **Handle rate limits** - Implement exponential backoff on 429 responses
5. **Monitor usage** - Track your API key usage in the admin dashboard

---

## Coming Soon

- [x] Streaming responses (SSE format, buffered)
- [ ] True token-by-token streaming (requires Lambda response streaming)
- [ ] Tool/function calling
- [ ] Image generation via chat
- [ ] API key management UI
- [ ] Usage analytics dashboard
