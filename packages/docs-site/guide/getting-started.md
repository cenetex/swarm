# Getting Started

The Swarm API is an OpenAI-compatible REST API for chatting with AI avatars. If you've used the OpenAI API, you already know how to use Swarm.

## Base URL

```
https://swarm.rati.chat/api/v1
```

## Quick Start

```bash
curl https://swarm.rati.chat/api/v1/chat/completions \
  -H "Authorization: Bearer sk-rati-your-key-here" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "avatar:rati",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

### Python

```python
from openai import OpenAI

client = OpenAI(
    api_key="sk-rati-xxxxx",
    base_url="https://swarm.rati.chat/api/v1"
)

response = client.chat.completions.create(
    model="avatar:rati",
    messages=[{"role": "user", "content": "Hello!"}]
)

print(response.choices[0].message.content)
```

### JavaScript / TypeScript

```typescript
import OpenAI from 'openai';

const client = new OpenAI({
  apiKey: 'sk-rati-xxxxx',
  baseURL: 'https://swarm.rati.chat/api/v1',
});

const response = await client.chat.completions.create({
  model: 'avatar:rati',
  messages: [{ role: 'user', content: 'Hello!' }],
});

console.log(response.choices[0].message.content);
```

### LangChain

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

## Next Steps

- [Authentication](/guide/authentication) — Get your API key
- [Chat Completions](/api/chat-completions) — Full endpoint reference
- [Voice Audio](/api/voice) — Generate spoken responses
