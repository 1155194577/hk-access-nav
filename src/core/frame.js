/**
 * Prepare a camera frame before it leaves the phone.
 *
 * Three reasons this exists, in order of how much they matter:
 *
 *  1. **Privacy.** A phone photo carries EXIF, and EXIF carries GPS. Re-encoding
 *     the frame drops it, so the vision vendor never receives the user's
 *     coordinates. `docs/BACKEND.md` §3.3 states the same rule for the server
 *     side; this is the client half of it.
 *  2. **Accuracy.** A full-resolution capture that arrives sideways (EXIF
 *     orientation, which is how Android usually reports it) gets answered with
 *     "I cannot tell" — the model is looking at a rotated street. Resizing to the
 *     long edge below lets the native resize apply the orientation and gives the
 *     model the scale it reads best.
 *  3. **Latency.** A 3 MB base64 payload is a much slower round trip than a
 *     150 KB one, and this call happens while someone waits at a kerb.
 *
 * If the manipulator fails for any reason the raw capture is used instead: a
 * usable-but-imperfect frame beats a button that does nothing.
 */

import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

/** Long edge of the frame sent to the model. */
export const VISION_FRAME_MAX_PX = 1024;

/** JPEG quality of the frame sent to the model (the capture quality is separate). */
export const VISION_FRAME_QUALITY = 0.7;

/**
 * @param {{uri?: string, base64?: string}} photo result of `takePictureAsync`
 * @param {{maxPx?: number, compress?: number}} [opts]
 * @returns {Promise<{base64: string, mime: string, resized: boolean, width: number|null, height: number|null}|null>}
 */
export async function prepareFrameForVision(photo, opts = {}) {
  const maxPx = opts.maxPx ?? VISION_FRAME_MAX_PX;
  const compress = opts.compress ?? VISION_FRAME_QUALITY;

  const raw =
    photo?.base64 != null
      ? { base64: photo.base64, mime: 'image/jpeg', resized: false, width: null, height: null }
      : null;

  const uri = photo?.uri;
  if (!uri) return raw;

  try {
    const context = ImageManipulator.manipulate(uri);

    // Resize only downwards: `renderAsync` is what reveals the real dimensions,
    // and enlarging a small capture would add bytes without adding detail.
    const original = await context.renderAsync();
    const longest = Math.max(original.width ?? 0, original.height ?? 0);
    const needsResize = longest > maxPx;

    if (needsResize) {
      context.reset();
      if ((original.width ?? 0) >= (original.height ?? 0)) context.resize({ width: maxPx });
      else context.resize({ height: maxPx });
    }

    const rendered = needsResize ? await context.renderAsync() : original;
    const saved = await rendered.saveAsync({
      base64: true,
      compress,
      format: SaveFormat.JPEG,
    });

    if (saved?.base64) {
      return {
        base64: saved.base64,
        mime: 'image/jpeg',
        resized: true,
        width: saved.width ?? rendered.width ?? null,
        height: saved.height ?? rendered.height ?? null,
      };
    }
  } catch {
    // Fall through to the raw capture.
  }

  return raw;
}
