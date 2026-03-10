# Models

Avatars are exposed as "models" in the OpenAI-compatible format.

## List Models

```
GET /v1/models
```

Returns all avatars available to your API key.

### Response

```json
{
  "object": "list",
  "data": [
    {
      "id": "avatar:rati",
      "object": "model",
      "created": 1706644800,
      "owned_by": "swarm",
      "capabilities": { "voice": true },
      "avatar": {
        "name": "Rati",
        "description": "A helpful AI assistant",
        "profile_image": "https://cdn.rati.chat/avatars/rati/profile.png"
      }
    }
  ],
  "energy": {
    "current": 8.5,
    "max": 10,
    "refill_rate": 1,
    "next_refill_minutes": 42
  }
}
```

The `capabilities.voice` field indicates whether the avatar supports voice audio responses.

## Get Model Details

```
GET /v1/models/{model_id}
```

Get detailed information about a specific avatar including platform presence and capabilities.

### Response

```json
{
  "id": "avatar:rati",
  "object": "model",
  "created": 1706644800,
  "owned_by": "swarm",
  "capabilities": { "voice": true },
  "avatar": {
    "id": "rati",
    "name": "Rati",
    "description": "A helpful AI assistant",
    "profile_image": "https://cdn.rati.chat/avatars/rati/profile.png",
    "character_reference": "https://cdn.rati.chat/avatars/rati/character.png",
    "platforms": {
      "telegram": {
        "username": "ratibot",
        "home_channel": "https://t.me/ratichat"
      },
      "twitter": { "username": "rati_ai" },
      "discord": null
    },
    "voice": { "style": "voice-clone" },
    "sticker_pack": {
      "name": "rati_stickers",
      "title": "Rati Stickers",
      "count": 12
    }
  },
  "energy": {
    "current": 8.5,
    "max": 10,
    "costs": { "text": 1, "audio": 2 }
  }
}
```

### Example

```bash
curl https://swarm.rati.chat/api/v1/models/avatar:rati \
  -H "Authorization: Bearer sk-rati-xxxxx"
```
