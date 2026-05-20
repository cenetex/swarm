/**
 * Background Removal Algorithm
 *
 * Handles image processing for stickers:
 * - Gray checkerboard patterns (fake transparency from AI models)
 * - Solid dark backgrounds (black/near-black)
 * - Preserves bright white outlines (sticker edges)
 *
 * Key idea:
 * - Background pixels are either: low-chroma gray-ish OR very dark (low luma)
 * - The sticker interior is higher-chroma (colored)
 * - The white outline is low-chroma but bright; we preserve it via luma threshold
 * - We also preserve pixels adjacent to colored content (the outline border)
 */

// Lazy load sharp to avoid import failures on platforms without native binaries
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sharpModule: any = null;

async function getSharp() {
  if (!sharpModule) {
    try {
      sharpModule = (await import('sharp')).default;
    } catch {
      throw new Error('sharp module not available - image processing is not supported in this environment');
    }
  }
  return sharpModule;
}

function rgbChroma(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max - min;
}

function isGrayish(r: number, g: number, b: number, variance: number = 18): boolean {
  return Math.abs(r - g) <= variance && Math.abs(g - b) <= variance && Math.abs(r - b) <= variance;
}

function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export async function removeCheckerboardBackground(imageBuffer: Buffer): Promise<Buffer> {
  const sharp = await getSharp();
  const image = sharp(imageBuffer);
  const { data, info } = await image.ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const pixels = new Uint8Array(data);

  console.log('Removing background via edge flood fill (gray + dark)', { width, height, channels });

  const pixelCount = width * height;
  const coloredThreshold = 22; // foreground seed (slightly lower to catch more colors)
  const grayChromaThreshold = 20; // background candidate
  const grayVariance = 25; // increased tolerance for gray detection
  const darkLumaThreshold = 45; // pixels darker than this are background candidates

  // Precompute colored mask (high chroma pixels).
  const isColored = new Uint8Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    const idx = i * channels;
    const r = pixels[idx];
    const g = pixels[idx + 1];
    const b = pixels[idx + 2];
    if (rgbChroma(r, g, b) >= coloredThreshold) {
      isColored[i] = 1;
    }
  }

  // Helper: is this pixel adjacent to colored content?
  const isAdjacentToColored = (x: number, y: number): boolean => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        if (isColored[ny * width + nx] === 1) return true;
      }
    }
    return false;
  };

  // Helper: is this pixel a barrier that should STOP flood fill (white outline)?
  const isBarrierPixel = (r: number, g: number, b: number): boolean => {
    const pixelLuma = luma(r, g, b);
    // Any bright-ish pixel is a barrier (white outline)
    // Lower threshold to catch slightly gray outlines too
    return pixelLuma >= 180;
  };

  // Helper: is this pixel a removable background pixel?
  // This is only used to decide IF we can traverse, not whether to remove
  const isBackgroundPixel = (r: number, g: number, b: number): boolean => {
    const pixelLuma = luma(r, g, b);
    const pixelChroma = rgbChroma(r, g, b);

    // Barrier pixels are NOT background - they stop the flood
    if (isBarrierPixel(r, g, b)) return false;

    // Colored pixels (high chroma) are NOT background
    if (pixelChroma >= coloredThreshold) return false;

    // Dark pixels (black/near-black background) are removable
    if (pixelLuma <= darkLumaThreshold && pixelChroma <= grayChromaThreshold) return true;

    // Gray-ish pixels (checkerboard) are removable
    if (isGrayish(r, g, b, grayVariance) && pixelChroma <= grayChromaThreshold) return true;

    return false;
  };

  // Detect dominant edge color (for non-black/gray colored backgrounds)
  const edgeSamples: Array<[number, number, number]> = [];
  const sampleStep = 5; // Sample every Nth edge pixel
  for (let x = 0; x < width; x += sampleStep) {
    const topIdx = x * channels;
    const bottomIdx = ((height - 1) * width + x) * channels;
    edgeSamples.push([pixels[topIdx], pixels[topIdx + 1], pixels[topIdx + 2]]);
    edgeSamples.push([pixels[bottomIdx], pixels[bottomIdx + 1], pixels[bottomIdx + 2]]);
  }
  for (let y = 0; y < height; y += sampleStep) {
    const leftIdx = (y * width) * channels;
    const rightIdx = (y * width + width - 1) * channels;
    edgeSamples.push([pixels[leftIdx], pixels[leftIdx + 1], pixels[leftIdx + 2]]);
    edgeSamples.push([pixels[rightIdx], pixels[rightIdx + 1], pixels[rightIdx + 2]]);
  }

  // Calculate average edge color
  let sumR = 0, sumG = 0, sumB = 0;
  for (const [r, g, b] of edgeSamples) {
    sumR += r; sumG += g; sumB += b;
  }
  const avgR = sumR / edgeSamples.length;
  const avgG = sumG / edgeSamples.length;
  const avgB = sumB / edgeSamples.length;
  const edgeLuma = luma(avgR, avgG, avgB);

  // Check if edge is uniformly colored (low variance = likely background)
  let variance = 0;
  for (const [r, g, b] of edgeSamples) {
    variance += Math.pow(r - avgR, 2) + Math.pow(g - avgG, 2) + Math.pow(b - avgB, 2);
  }
  variance /= edgeSamples.length;
  const isUniformEdge = variance < 800; // Low variance = uniform background color

  console.log('Edge color analysis', {
    avgR: Math.round(avgR), avgG: Math.round(avgG), avgB: Math.round(avgB),
    edgeLuma: Math.round(edgeLuma), variance: Math.round(variance), isUniformEdge
  });

  // Check if pixel matches the detected edge background color
  const colorTolerance = 60; // How close to edge color to be considered background
  const matchesEdgeBackground = (r: number, g: number, b: number): boolean => {
    if (!isUniformEdge) return false;
    // Don't allow traversal through barrier pixels
    if (isBarrierPixel(r, g, b)) return false;
    const dist = Math.abs(r - avgR) + Math.abs(g - avgG) + Math.abs(b - avgB);
    return dist < colorTolerance;
  };

  // Flood fill background from edges.
  const outputPixels = Buffer.from(pixels);
  const visited = new Uint8Array(pixelCount);
  const queue: Array<[number, number]> = [];

  for (let x = 0; x < width; x++) {
    queue.push([x, 0], [x, height - 1]);
  }
  for (let y = 1; y < height - 1; y++) {
    queue.push([0, y], [width - 1, y]);
  }

  let removedCount = 0;
  let barrierHits = 0;

  let queueIndex = 0;
  while (queueIndex < queue.length) {
    const [x, y] = queue[queueIndex++]!;
    const key = y * width + x;
    if (visited[key] === 1) continue;
    visited[key] = 1;

    const idx = key * channels;
    const r = pixels[idx];
    const g = pixels[idx + 1];
    const b = pixels[idx + 2];

    // FIRST CHECK: Is this a barrier pixel (white outline)?
    // If so, STOP flood here completely - do not traverse OR remove
    if (isBarrierPixel(r, g, b)) {
      barrierHits++;
      continue;
    }

    // Check if this is a background pixel (dark/gray OR matches uniform edge color)
    const isRemovableBackground = isBackgroundPixel(r, g, b) || matchesEdgeBackground(r, g, b);
    if (!isRemovableBackground) continue;

    // Additional safety: refuse to flood into pixels adjacent to colored content
    if (isAdjacentToColored(x, y)) continue;

    if (outputPixels[idx + 3] !== 0) {
      outputPixels[idx + 3] = 0;
      removedCount++;
    }

    for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
      const nkey = ny * width + nx;
      if (visited[nkey] === 0) queue.push([nx, ny]);
    }
  }

  console.log('Background removal complete', {
    totalPixels: pixelCount,
    removedPixels: removedCount,
    barrierHits,
    coloredThreshold,
    grayChromaThreshold,
    grayVariance,
    darkLumaThreshold,
  });

  // Convert back to PNG
  const sharpInstance = await getSharp();
  return sharpInstance(outputPixels, {
    raw: {
      width,
      height,
      channels: channels as 4,
    },
  })
    .png()
    .toBuffer();
}
