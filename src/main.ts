import clipsData from './clips.json';

type Clip = { id: number; name: string };

interface Slot {
  el: HTMLDivElement;
  blur: HTMLDivElement;
  sharp: HTMLDivElement;
}

const CDN = (import.meta.env.VITE_CDN_BASE as string).replace(/\/$/, '');
const PRELOAD_AHEAD = 5;
const TRANSITION_MS = 600;

const slots: [Slot, Slot] = [
  {
    el: document.getElementById('slot-a') as HTMLDivElement,
    blur: document.getElementById('blur-a') as HTMLDivElement,
    sharp: document.getElementById('sharp-a') as HTMLDivElement,
  },
  {
    el: document.getElementById('slot-b') as HTMLDivElement,
    blur: document.getElementById('blur-b') as HTMLDivElement,
    sharp: document.getElementById('sharp-b') as HTMLDivElement,
  },
];

const timerEl = document.getElementById('timer') as HTMLDivElement;
const dayEl = document.getElementById('day') as HTMLDivElement;

// Fisher-Yates shuffle — different order each session
const clips: Clip[] = [...clipsData.clips];
for (let i = clips.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [clips[i], clips[j]] = [clips[j], clips[i]];
}

let clipIndex = 0;
let frontIdx = 0;

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
    img.src = posterUrl(clips[(fromIndex + i) % clips.length].name);
  }
}

// Populate a slot — blur always covers, sharp uses cover for landscape or contain for square/portrait
function fillSlot(slot: Slot, url: string, imgW: number, imgH: number): void {
  const vpRatio = window.innerWidth / window.innerHeight;
  const imgRatio = imgW / imgH;
  // If the image is as wide (or wider) than the viewport ratio → cover fills edge to edge.
  // A 5% tolerance handles minor rounding in source video dimensions.
  const bgSize = imgRatio >= vpRatio * 0.95 ? 'cover' : 'contain';
  slot.blur.style.backgroundImage = `url("${url}")`;
  slot.sharp.style.backgroundImage = `url("${url}")`;
  slot.sharp.style.backgroundSize = bgSize;
}

function crossfade(clip: Clip): void {
  const backIdx = frontIdx === 0 ? 1 : 0;
  const back = slots[backIdx];
  const front = slots[frontIdx];

  function apply(img: HTMLImageElement): void {
    fillSlot(back, img.src, img.naturalWidth, img.naturalHeight);
    // Force reflow so the opacity transition fires from the current value
    void back.el.getBoundingClientRect();
    back.el.style.opacity = '1';
    front.el.style.opacity = '0';
    dayEl.textContent = `day ${clip.name}`;
    setTimeout(() => { frontIdx = backIdx; }, TRANSITION_MS);
  }

  const loader = new Image();
  loader.onload = () => apply(loader);
  loader.onerror = () => {
    const fb = new Image();
    fb.onload = () => apply(fb);
    fb.src = fallbackUrl(clip.name);
  };
  loader.src = posterUrl(clip.name);
}

// Show first clip immediately (slot-a starts at opacity 1)
const firstClip = clips[clipIndex++];
const firstLoader = new Image();
firstLoader.onload = () => fillSlot(slots[0], firstLoader.src, firstLoader.naturalWidth, firstLoader.naturalHeight);
firstLoader.onerror = () => {
  const fb = new Image();
  fb.onload = () => fillSlot(slots[0], fb.src, fb.naturalWidth, fb.naturalHeight);
  fb.src = fallbackUrl(firstClip.name);
};
firstLoader.src = posterUrl(firstClip.name);
dayEl.textContent = `day ${firstClip.name}`;
preloadAhead(0);

// One tick per second drives both the clock and the image swap
let elapsed = 0;
setInterval(() => {
  elapsed++;
  timerEl.textContent = formatTime(elapsed);

  const clip = clips[clipIndex % clips.length];
  clipIndex++;

  crossfade(clip);
  preloadAhead(clipIndex);
}, 1000);
