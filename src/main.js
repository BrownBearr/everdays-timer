import clipsData from './clips.json';
const CDN = import.meta.env.VITE_CDN_BASE.replace(/\/$/, '');
const PRELOAD_AHEAD = 5;
const TRANSITION_MS = 600;
const bgA = document.getElementById('bg-a');
const bgB = document.getElementById('bg-b');
const timerEl = document.getElementById('timer');
const dayEl = document.getElementById('day');
// Fisher-Yates shuffle — different order each session
const clips = [...clipsData.clips];
for (let i = clips.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [clips[i], clips[j]] = [clips[j], clips[i]];
}
let clipIndex = 0;
let frontIsA = true;
function posterUrl(name) {
    return `${CDN}/${name}.jpg`;
}
function formatTime(secs) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function preloadAhead(fromIndex) {
    for (let i = 1; i <= PRELOAD_AHEAD; i++) {
        const img = new Image();
        img.src = posterUrl(clips[(fromIndex + i) % clips.length].name);
    }
}
function crossfade(clip) {
    const back = frontIsA ? bgB : bgA;
    const front = frontIsA ? bgA : bgB;
    const url = posterUrl(clip.name);
    const loader = new Image();
    loader.onload = () => {
        back.style.backgroundImage = `url("${url}")`;
        // Force reflow so the CSS transition fires from the new opacity value
        void back.getBoundingClientRect();
        back.style.opacity = '1';
        front.style.opacity = '0';
        dayEl.textContent = `day ${clip.name}`;
        setTimeout(() => {
            frontIsA = !frontIsA;
        }, TRANSITION_MS);
    };
    loader.src = url;
}
// Load and show the first clip before the timer starts
const firstClip = clips[clipIndex++];
bgA.style.backgroundImage = `url("${posterUrl(firstClip.name)}")`;
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
