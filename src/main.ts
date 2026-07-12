import clipsData from './clips.json';
import { RippleStage } from './ripple';

type Clip = { id: number; name: string };

const CDN = (import.meta.env.VITE_CDN_BASE as string).replace(/\/$/, '');
const PRELOAD_AHEAD = 5;

const stage = new RippleStage(document.getElementById('gl') as HTMLCanvasElement);
const timerEl = document.getElementById('timer') as HTMLDivElement;
const dayEl = document.getElementById('day') as HTMLDivElement;

// Fisher-Yates shuffle — different order each session
const clips: Clip[] = [...clipsData.clips];
for (let i = clips.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [clips[i], clips[j]] = [clips[j], clips[i]];
}

let clipIndex = 0;

function posterUrl(name: string): string {
  return `${CDN}/${name}-hd.jpg`;
}

function fallbackUrl(name: string): string {
  return `${CDN}/${name}.jpg`;
}

function formatTime(secs: number): string {
  return String(secs).padStart(4, '0');
}

function preloadAhead(fromIndex: number): void {
  for (let i = 1; i <= PRELOAD_AHEAD; i++) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = posterUrl(clips[(fromIndex + i) % clips.length].name);
  }
}

// Decode a URL into an ImageBitmap off the main thread (flipped to match GL's
// texture orientation), so the per-second swap never blocks on JPEG decoding.
async function loadBitmap(url: string): Promise<ImageBitmap> {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  return createImageBitmap(blob, { imageOrientation: 'flipY' });
}

// Load a clip's poster (with non-HD fallback) and hand it to the ripple stage,
// which crossfades while the water surface keeps rippling underneath.
async function showClip(clip: Clip): Promise<void> {
  let bmp: ImageBitmap;
  try {
    bmp = await loadBitmap(posterUrl(clip.name));
  } catch {
    try {
      bmp = await loadBitmap(fallbackUrl(clip.name));
    } catch {
      return;
    }
  }
  stage.setImage(bmp);
  bmp.close();
  // Jump to opacity 0 (transition off), set the new day, then release so it
  // transitions back to its resting opacity.
  dayEl.classList.add('swap');
  dayEl.textContent = `day ${clip.name}`;
  void dayEl.offsetWidth; // commit the 0-opacity state before transitioning
  dayEl.classList.remove('swap');
}

// Show the first clip immediately.
showClip(clips[clipIndex++]);
preloadAhead(0);

// One tick per second drives both the clock and the image swap.
let elapsed = 0;
setInterval(() => {
  elapsed++;
  timerEl.textContent = formatTime(elapsed);

  showClip(clips[clipIndex % clips.length]);
  clipIndex++;
  preloadAhead(clipIndex);
}, 1000);
