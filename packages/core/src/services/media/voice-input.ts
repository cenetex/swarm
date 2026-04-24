/**
 * Voice TTS model input adapter.
 *
 * Different Replicate voice-clone models use different input schemas. This
 * tiny helper keeps call sites agnostic — pass text + reference URL, get the
 * right shape back.
 *
 * Supported models (2026-04):
 * - `x-lance/f5-tts`       — SOTA open-source clone. Keys: `gen_text`, `ref_audio`.
 * - `lucataco/xtts-v2`    — legacy, kept for rollback. Keys: `text`, `speaker`, `language`.
 *
 * Falls back to the XTTS-v2 shape for unknown models to match prior behavior.
 */

export interface VoiceCloneInput {
  /** Text the model should speak. */
  text: string;
  /** Publicly fetchable reference audio URL (signed or CDN). */
  referenceUrl: string;
  /** BCP-47 language tag. XTTS-v2 respects this; F5-TTS auto-detects. */
  language?: string;
  /** Optional transcript of the reference audio. F5-TTS quality bump; XTTS-v2 ignores. */
  referenceText?: string;
  /** Optional post-process. XTTS-v2 exposes this; F5-TTS has its own default. */
  cleanupVoice?: boolean;
}

export function buildVoiceCloneInput(
  model: string,
  input: VoiceCloneInput
): Record<string, unknown> {
  const { text, referenceUrl, language = 'en', referenceText, cleanupVoice } = input;
  const normalized = model.toLowerCase();

  // F5-TTS family (x-lance/f5-tts and any community forks)
  if (normalized.includes('f5-tts') || normalized.includes('f5_tts')) {
    const payload: Record<string, unknown> = {
      gen_text: text,
      ref_audio: referenceUrl,
    };
    if (referenceText) payload.ref_text = referenceText;
    return payload;
  }

  // Default / XTTS-v2 shape (back-compat)
  const payload: Record<string, unknown> = {
    text,
    speaker: referenceUrl,
    language,
  };
  if (cleanupVoice !== undefined) payload.cleanup_voice = cleanupVoice;
  return payload;
}
