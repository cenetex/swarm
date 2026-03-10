# Error Codes

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

## Error Reference

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `missing_api_key` | 401 | No `Authorization` header provided |
| `invalid_api_key` | 401 | API key not found or disabled |
| `unauthorized_avatar` | 403 | API key not authorized for the requested avatar |
| `avatar_not_found` | 404 | Avatar ID doesn't exist |
| `insufficient_energy` | 402 | Not enough energy to process request |
| `unsupported_stream_audio` | 400 | `stream: true` and `include_audio: true` cannot be combined |
| `invalid_request_error` | 400 | Malformed request body |
| `server_error` | 500 | Internal server error |

## Handling Errors

### Authentication Errors (401)

Check that your API key is correct and included in the `Authorization` header:

```
Authorization: Bearer sk-rati-xxxxx
```

### Permission Errors (403)

Your API key may be scoped to a specific avatar. Use the correct `model` parameter or create a wildcard key.

### Energy Errors (402)

Wait for energy to refill. Check your balance via `GET /v1/models`.

### Rate Limit Errors (429)

Implement exponential backoff. Rate limit headers indicate when to retry:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1706644860
```
