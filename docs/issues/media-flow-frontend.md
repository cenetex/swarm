# Issue: Media Generation Not Flowing to Frontend Chat

## Summary
When requesting image generation in the web admin chat, generated images are not appearing in the frontend UI. The LLM is responding with text ABOUT generating images but NOT actually calling the `generate_image` tool.

## Observed Behavior

### Critical Finding: LLM Not Calling Tools
Logs show:
```
[Chat] Final response with 0 media items, 0 pending jobs
```

The LLM is responding with enthusiastic text like "YOOOOO GENERATING IMAGES!!!" but:
- **0 tool calls** are being made
- **0 pending jobs** are returned
- The agent just describes what it would do instead of doing it

### Evidence from Logs
```
INFO {"level":"INFO","subsystem":"chat","event":"request_received","agentId":"agent-1-55e3","messageLength":23,"historyLength":105}
INFO [Chat] Skipping orphaned tool result: undefined
INFO [Chat] Skipping orphaned tool result: undefined  
INFO [Chat] Final response with 0 media items, 0 pending jobs
```

Notice: No tool execution logs, no `generate_image` calls, no job creation.

### Video Generation Also Broken
```
ERROR: Tool generate_video error: Error: Video generation failed to start
{
  "detail": "- version is required\n- Additional property model is not allowed\n- webhook_events_filter cannot be provided without webhook",
  "status": 422,
  "title": "Input validation failed"
}
```

## Root Cause Analysis

### 1. Async Job Model vs Sync Response
The web chat uses a **request/response model** where:
- User sends message → Handler returns response
- Image generation takes 30-60 seconds (async)
- Handler returns `pendingJobs` array with job IDs
- Frontend is supposed to poll for job completion

**Problem**: The frontend job polling logic may not be working correctly, OR the initial response doesn't include `pendingJobs` properly.

### 2. Telegram vs Web Chat Difference
- **Telegram**: Synchronous wait - handler waits for image, then sends to chat directly (works ✅)
- **Web Chat**: Async - returns job ID, frontend must poll via `/jobs/{jobId}` (broken ❌)

### 3. Video Generation API Mismatch
The Replicate API call is using wrong parameters:
- Sending `model` instead of `version`
- Including `webhook_events_filter` without a `webhook` URL

## Files to Investigate

### Frontend Polling Logic
- `packages/admin-ui/src/components/ChatPanel.tsx` - Lines 98-145: Job polling setup
- `packages/admin-ui/src/api/chat.ts` - `pollJobCompletion` function

### Backend Job Creation
- `packages/admin-api/src/handlers/chat.ts` - Lines 360-377: `generateImage` tool
- `packages/admin-api/src/services/media.ts` - `generateImageAsync`, `generateVideoAsync`

### Jobs Endpoint
- `packages/admin-api/src/handlers/jobs.ts` - Job status polling endpoint

## Logs Evidence

### Successful Telegram Image Generation (21:19:50 UTC)
```
INFO  Generating image with google/nano-banana-pro, refs: 1, prompt: A cute baby whale...
INFO  Public URL: https://media-staging.rati.chat/agents/agent-1-55e3/images/4233b3b5-...
INFO  [Telegram] Image generated successfully
INFO  [Telegram] Sending photo to chat -1003401362204
Duration: 39062ms
```

### Failed Video Generation (21:27:40 UTC)
```
ERROR Tool generate_video error: Video generation failed to start
- version is required
- Additional property model is not allowed
- webhook_events_filter cannot be provided without webhook
```

### Web Chat Handler
- No image/video tool calls logged in the last hour
- Only auth debug logs visible

## Tasks

### P0 - Fix Video Generation (Broken) ✅ FIXED
- [x] Update `packages/admin-api/src/services/media.ts` - `generateVideo` function
- [x] Use Replicate Models API (`/v1/models/{owner}/{name}/predictions`) instead of generic predictions endpoint
- [x] Only include `webhook_events_filter` when `webhook` URL is provided
- [x] Use `Bearer` auth token for Models API
- [x] Fix input param: `first_frame_image` instead of `image` for video models
- [ ] Add unit tests for Replicate API payload structure

### P1 - Fix Web Chat Image Flow
- [ ] Add structured logging to trace `generate_image` tool calls in chat handler
- [ ] Verify `pendingJobs` is returned in the chat response
- [ ] Debug frontend `pollJobCompletion` function
- [ ] Ensure `/jobs/{jobId}` endpoint returns correct status
- [ ] Add visual indicator when job is pending/processing

### P2 - Improve Observability
- [ ] Add structured logging for tool execution in chat handler
- [ ] Log when `pendingJobs` is populated
- [ ] Log job status transitions
- [ ] Add frontend console logging for job polling

## Reproduction Steps

### Web Chat (Broken)
1. Go to https://admin-staging.rati.chat
2. Select an agent
3. Type "generate an image of a sunset"
4. Observe: No image appears, no loading indicator

### Telegram (Working)
1. Message @YourAgentBot on Telegram
2. Ask "generate an image of a sunset"
3. Wait ~30-60 seconds
4. Image appears in chat

## Environment
- Stack: `SwarmStack-staging`
- API: `g5wetlu97i.execute-api.us-east-1.amazonaws.com`
- CDN: `media-staging.rati.chat`
- Model: `google/nano-banana-pro` (images), Replicate (videos)

## Related
- Log group: `/aws/lambda/SwarmStack-staging-AdminApiChatHandler374CF7F7-BqVhrni2NojN`
- Log group: `/aws/lambda/SwarmStack-staging-AdminApiTelegramWebhookHandler4-CnE3CZEem1aA`
