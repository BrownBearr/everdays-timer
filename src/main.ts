import clipsData from './clips.json';

type Clip = { id: number; name: string };

const CDN = (import.meta.env.VITE_CDN_BASE as string).replace(/\/$/, '');
const PRELOAD_AHEAD = 5;
const TRANSITION_MS = 600;

const bgA = document.getElementById('bg-a') as HTMLDivElement;
const bgB = document.getElementById('bg-b') as HTMLDivElement;
const timerEl = document.getElementById('timer') as HTMLDivElement;
const dayEl = document.getElementById('day') as HTMLDivElement;

// Fisher-Yates shuffle — different order each session
const clips: Clip[] = [...clipsData.clips];
for (let i = clips.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [clips[i], clips[j]] = [clips[j], clips[i]];
}

let clipIndex = 0;
let frontIsA = true;

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

function applyImage(back: HTMLDivElement, front: HTMLDivElement, url: string, dayName: string): void {
  back.style.backgroundImage = `url("${url}")`;
  void back.getBoundingClientRect();
  back.style.opacity = '1';
  front.style.opacity = '0';
  dayEl.textContent = `day ${dayName}`;
  setTimeout(() => { frontIsA = !frontIsA; }, TRANSITION_MS);
}

function crossfade(clip: Clip): void {
  const back = frontIsA ? bgB : bgA;
  const front = frontIsA ? bgA : bgB;

  const loader = new Image();
  loader.onload = () => applyImage(back, front, loader.src, clip.name);
  loader.onerror = () => {
    // HD poster not uploaded yet — fall back to the 400px thumbnail
    const fallback = new Image();
    fallback.onload = () => applyImage(back, front, fallback.src, clip.name);
    fallback.src = fallbackUrl(clip.name);
  };
  loader.src = posterUrl(clip.name);
}

// Load and show the first clip before the timer starts
const firstClip = clips[clipIndex++];
const firstLoader = new Image();
firstLoader.onload = () => { bgA.style.backgroundImage = `url("${firstLoader.src}")`; };
firstLoader.onerror = () => { bgA.style.backgroundImage = `url("${fallbackUrl(firstClip.name)}")`; };
firstLoader.src = posterUrl(firstClip.name);
dayEl.textContent = `day ${firstClip.name}`;
preloadAhead(0);

// Timer — one tick per second drives both the clock and the image swap
let elapsed = 0;
setInterval(() => {
  elapsed++;
  timerEl.textContent = formatTime(elapsed);

  const clip = clips[clipIndex % clips.length];
  clipIndex++;

  crossfade(clip);
  preloadAhead(clipIndex);
}, 1000);
