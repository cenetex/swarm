# Creating a New Agent

1. Copy this `.template` folder and rename it to your agent's ID
2. Edit `config.yaml` with your agent's settings
3. Write your agent's personality in `persona.md`
4. Add your secrets to AWS Secrets Manager
5. Deploy with: `pnpm deploy:agent <agent-id>`

## Required Secrets

Create a secret in AWS Secrets Manager with the path `swarm/<agent-id>/secrets` containing:

```json
{
  "TELEGRAM_BOT_TOKEN": "your-telegram-bot-token",
  "OPENROUTER_API_KEY": "your-openrouter-key"
}
```

For Twitter agents, also include:
```json
{
  "TWITTER_API_KEY": "...",
  "TWITTER_API_SECRET": "...",
  "TWITTER_ACCESS_TOKEN": "...",
  "TWITTER_ACCESS_SECRET": "..."
}
```

## Testing Locally

You can test your persona with:
```bash
pnpm test:persona <agent-id>
```

## Deployment

Deploy a single agent:
```bash
pnpm deploy:agent <agent-id>
```

Deploy all agents:
```bash
pnpm deploy:all
```
