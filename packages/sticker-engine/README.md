# @swarm/sticker-engine

Unified sticker processing engine for Telegram and web formats.

Handles image processing, background removal, resizing, and S3 storage for stickers across multiple platforms.

## Features

- **Background Removal**: Edge flood-fill algorithm removes checkerboard and dark backgrounds
- **Telegram Format**: 512px PNG with transparency, <512KB file size
- **Web Format**: Flexible sizing with PNG/WebP/SVG output options
- **Color Analysis**: Utilities for analyzing image color properties (chroma, luma, grayness detection)
- **S3 Storage**: Upload stickers and manage sticker set manifests
- **Emoji Selection**: Automatic emoji mapping based on prompt keywords

## Installation

```bash
pnpm install @swarm/sticker-engine
```

## Usage

### Telegram Stickers

```typescript
import { processForTelegram } from '@swarm/sticker-engine';

const buffer = fs.readFileSync('image.png');
const processed = await processForTelegram(buffer);
// { buffer: Buffer, width: 512, height: 384 }
```

### Web Format

```typescript
import { processForWeb } from '@swarm/sticker-engine';

const buffer = fs.readFileSync('image.png');
const processed = await processForWeb(buffer, 'image/png', {
  width: 256,
  format: 'webp',
  removeBackground: true,
});
```

### Emoji Selection

```typescript
import { selectStickerEmoji } from '@swarm/sticker-engine';

const emoji = selectStickerEmoji('fire and flames');
// '🔥'
```

### S3 Storage

```typescript
import { uploadStickerToS3, getStickerSetManifest } from '@swarm/sticker-engine';

const result = await uploadStickerToS3(buffer, 'my-bucket', 'avatar-id', {
  emoji: '🔥',
  prompt: 'fire sticker',
  setName: 'my_set',
});
// { s3Key: string, id: string, url: string }
```

## Architecture

```
packages/sticker-engine/
├── src/
│   ├── core/
│   │   ├── background-removal.ts   # Flood-fill algorithm
│   │   └── index.ts
│   ├── formats/
│   │   ├── telegram.ts             # 512px PNG format
│   │   ├── web.ts                  # Flexible format handler
│   │   └── index.ts
│   ├── emoji.ts                    # Emoji selection
│   ├── s3-storage.ts               # S3 upload & manifest
│   ├── types.ts                    # Core types
│   └── index.ts                    # Main entry point
└── README.md
```

## Tests

```bash
pnpm test
```

Tests cover the color analysis utilities and background removal algorithm.
