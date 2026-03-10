# SDK Examples

The Swarm API is OpenAI-compatible. Any OpenAI SDK or client works out of the box.

## Python

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-rati-xxxxx",
    base_url="https://swarm.rati.chat/api/v1"
)

# Simple chat
response = client.chat.completions.create(
    model="avatar:rati",
    messages=[{"role": "user", "content": "Hello!"}]
)
print(response.choices[0].message.content)

# Multi-turn conversation
messages = [
    {"role": "user", "content": "My name is Alice."},
]
response = client.chat.completions.create(model="avatar:rati", messages=messages)
messages.append({"role": "assistant", "content": response.choices[0].message.content})
messages.append({"role": "user", "content": "What's my name?"})
response = client.chat.completions.create(model="avatar:rati", messages=messages)
print(response.choices[0].message.content)

# List available avatars
models = client.models.list()
for model in models.data:
    print(f"{model.id}: {model.root}")
```

## JavaScript / TypeScript

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'sk-rati-xxxxx',
  baseURL: 'https://swarm.rati.chat/api/v1',
});

// Simple chat
const response = await client.chat.completions.create({
  model: 'avatar:rati',
  messages: [{ role: 'user', content: 'Hello!' }],
});
console.log(response.choices[0].message.content);

// Streaming
const stream = await client.chat.completions.create({
  model: 'avatar:rati',
  messages: [{ role: 'user', content: 'Tell me a story' }],
  stream: true,
});

for await (const chunk of stream) {
  const content = chunk.choices[0]?.delta?.content;
  if (content) process.stdout.write(content);
}
```

## LangChain

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    api_key="sk-rati-xxxxx",
    base_url="https://swarm.rati.chat/api/v1",
    model="avatar:rati"
)

response = llm.invoke("Hello!")
print(response.content)
```

## cURL

```bash
# Chat completion
curl https://swarm.rati.chat/api/v1/chat/completions \
  -H "Authorization: Bearer sk-rati-xxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "avatar:rati",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# List models
curl https://swarm.rati.chat/api/v1/models \
  -H "Authorization: Bearer sk-rati-xxxxx"

# Chat with voice
curl https://swarm.rati.chat/api/v1/chat/completions \
  -H "Authorization: Bearer sk-rati-xxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "avatar:rati",
    "messages": [{"role": "user", "content": "Say hello!"}],
    "include_audio": true
  }'
```
