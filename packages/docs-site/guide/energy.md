# Energy System

Each API key has an energy balance that is consumed when making requests. Energy automatically refills over time.

## Costs

| Request Type | Energy Cost |
|--------------|-------------|
| Text chat completion | 1 |
| Audio chat completion | 2 |

## Checking Your Balance

Energy status is included in the `/v1/models` response:

```bash
curl https://swarm.rati.chat/api/v1/models \
  -H "Authorization: Bearer sk-rati-xxxxx"
```

```json
{
  "data": [...],
  "energy": {
    "current": 8.5,
    "max": 10,
    "refill_rate": 1,
    "next_refill_minutes": 42
  }
}
```

Per-avatar energy costs are shown in the `/v1/models/{id}` response:

```json
{
  "energy": {
    "current": 8.5,
    "max": 10,
    "costs": {
      "text": 1,
      "audio": 2
    }
  }
}
```

## Fields

| Field | Description |
|-------|-------------|
| `current` | Current energy balance |
| `max` | Maximum energy capacity |
| `refill_rate` | Energy restored per refill interval |
| `next_refill_minutes` | Minutes until next refill |
| `costs` | Energy cost per request type |

## Insufficient Energy

If you don't have enough energy, requests return `402 Payment Required`:

```json
{
  "error": {
    "message": "Insufficient energy",
    "type": "insufficient_energy",
    "code": "insufficient_energy"
  }
}
```

Wait for energy to refill or contact the team for increased limits.
