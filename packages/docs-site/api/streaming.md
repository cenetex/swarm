# Streaming

Set `stream: true` to receive responses in OpenAI-compatible Server-Sent Events (SSE) format.

```
POST /v1/chat/completions
```

```json
{
  "model": "avatar:rati",
  "messages": [{"role": "user", "content": "Hello!"}],
  "stream": true
}
```

::: warning
Streaming cannot be combined with `include_audio: true`. If both are set, the API returns a 400 error.
:::

::: info
Because the API runs on AWS Lambda behind API Gateway, the full response is generated first and then delivered as SSE-formatted chunks in a single HTTP response. Latency to first byte is the same as a non-streaming request, but the response format is compatible with SSE parsers.
:::

## Chunk Format

Each SSE event is a `data:` line containing a `chat.completion.chunk` object:

```
data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1706644800,"model":"avatar:rati","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1706644800,"model":"avatar:rati","choices":[{"index":0,"delta":{"content":"Hello! How can I help you today?"},"finish_reason":null}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","created":1706644800,"model":"avatar:rati","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":15,"completion_tokens":10,"total_tokens":25}}

data: [DONE]
```

### Chunk Sequence

1. **Role chunk** — `delta.role` set to `"assistant"` with empty content
2. **Content chunk(s)** — `delta.content` with the response text
3. **Final chunk** — empty `delta`, `finish_reason: "stop"`, and `usage` object
4. **Done sentinel** — `data: [DONE]` signals the stream is complete

## Examples

### Python

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-rati-xxxxx",
    base_url="https://swarm.rati.chat/api/v1"
)

stream = client.chat.completions.create(
    model="avatar:rati",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True
)

for chunk in stream:
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="")
```

### JavaScript

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'sk-rati-xxxxx',
  baseURL: 'https://swarm.rati.chat/api/v1',
});

const stream = await client.chat.completions.create({
  model: 'avatar:rati',
  messages: [{ role: 'user', content: 'Hello!' }],
  stream: true,
});

for await (const chunk of stream) {
  const content = chunk.choices[0]?.delta?.content;
  if (content) process.stdout.write(content);
}
```

## Error Handling

If an error occurs during generation, the error message is emitted as a content delta chunk followed by the `[DONE]` sentinel, with HTTP status 200 (since SSE headers are already sent).
