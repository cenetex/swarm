# Authentication

All API requests require an API key passed in the `Authorization` header.

```
Authorization: Bearer sk-rati-xxxxx
```

## API Key Types

### Avatar-Scoped Key (Recommended)

Scoped to a single avatar. Create one per integration.

```bash
curl -X POST https://swarm.rati.chat/api/avatars/{avatarId}/api-keys \
  -H "Content-Type: application/json" \
  -H "Cookie: swarm_session=..." \
  -d '{"name": "My Integration"}'
```

**Response:**
```json
{
  "apiKey": "sk-rati-abc123...",
  "keyPrefix": "sk-rati-abc1...",
  "message": "API key created. Save this key - it will not be shown again."
}
```

### Wildcard Key (Admin Only)

Access all avatars. Use sparingly.

```bash
curl -X POST https://swarm.rati.chat/api/api-keys \
  -H "Content-Type: application/json" \
  -H "Cookie: swarm_session=..." \
  -d '{"name": "Admin Integration"}'
```

::: warning
Save your API key immediately. It is only shown once and cannot be retrieved later.
:::

## Key Management

### List Keys

```bash
curl https://swarm.rati.chat/api/avatars/{avatarId}/api-keys \
  -H "Cookie: swarm_session=..."
```

### Revoke a Key

```bash
curl -X DELETE https://swarm.rati.chat/api/avatars/{avatarId}/api-keys/{keyPrefix} \
  -H "Cookie: swarm_session=..."
```

## Best Practices

1. **Use avatar-scoped keys** — Only create wildcard keys when absolutely necessary
2. **Rotate keys regularly** — Create new keys and revoke old ones periodically
3. **Store keys securely** — Use environment variables or secret managers, never hardcode
4. **Handle 401 errors** — Implement key rotation logic in your integration
