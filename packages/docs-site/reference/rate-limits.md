# Rate Limits

Rate limits are applied per API key.

## Default Limits

| Limit | Value |
|-------|-------|
| Requests per minute | 100 |
| Requests per day | 1,000 |

Custom limits can be configured per API key.

## Rate Limit Headers

Rate limit information is included in response headers:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1706644860
```

| Header | Description |
|--------|-------------|
| `X-RateLimit-Limit` | Maximum requests per window |
| `X-RateLimit-Remaining` | Requests remaining in current window |
| `X-RateLimit-Reset` | Unix timestamp when the window resets |

## Handling Rate Limits

When you hit a rate limit, the API returns `429 Too Many Requests`. Implement exponential backoff:

```python
import time
from openai import OpenAI, RateLimitError

client = OpenAI(
    api_key="sk-rati-xxxxx",
    base_url="https://swarm.rati.chat/api/v1"
)

def chat_with_retry(messages, max_retries=3):
    for attempt in range(max_retries):
        try:
            return client.chat.completions.create(
                model="avatar:rati",
                messages=messages
            )
        except RateLimitError:
            wait = 2 ** attempt
            time.sleep(wait)
    raise Exception("Max retries exceeded")
```
