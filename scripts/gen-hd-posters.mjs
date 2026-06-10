// Extract a 1080p JPEG frame from each source MP4 on B2 and upload as {name}-hd.jpg.
// If the frame at 0.5s is too dark (YAVG < 20 on 0-255 scale), retries at 50% into the video.
//
// Usage:
//   node scripts/gen-hd-posters.mjs --dry-run     # preview only
//   node scripts/gen-hd-posters.mjs --limit 3     # test first 3
//   node scripts/gen-hd-posters.mjs               # all clips (skips already-done)
//   node scripts/gen-hd-posters.mjs --force       # re-generate all (fixes existing dark frames)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { S3Client, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLIPS = JSON.parse(fs.readFileSync(path.join(ROOT, "src", "clips.json"), "utf8")).clips;

function loadEnv(file) {
  const p = path.join(ROOT, file);
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv(".env.local");
loadEnv(".env");

const CDN = (process.env.VITE_CDN_BASE || "").replace(/\/$/, "");
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const BUCKET = process.env.B2_BUCKET;

// Mean Y luminance below this is considered too dark to use (0–255 scale)
const DARK_THRESHOLD = 20;

const argv = new Set(process.argv.slice(2));
const DRY = argv.has("--dry-run");
const FORCE = argv.has("--force");
const limitArg = process.argv.find((_, i) => process.argv[i - 1] === "--limit");
const LIMIT = limitArg ? parseInt(limitArg, 10) : Infinity;

function requireEnv() {
  const missing = ["B2_KEY_ID", "B2_APP_KEY", "B2_BUCKET", "B2_ENDPOINT", "B2_REGION"]
    .filter(k => !process.env[k]);
  if (missing.length || !CDN) {
    console.error(`Missing env vars: ${[...missing, !CDN && "VITE_CDN_BASE"].filter(Boolean).join(", ")}`);
    process.exit(1);
  }
}

function s3() {
  return new S3Client({
    endpoint: process.env.B2_ENDPOINT,
    region: process.env.B2_REGION,
    credentials: { accessKeyId: process.env.B2_KEY_ID, secretAccessKey: process.env.B2_APP_KEY },
  });
}

async function hdExists(client, key) {
  try {
    await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch { return false; }
}

// Extract one frame from a URL at a given seek time into outFile
function extractFrame(url, seekSec, outFile) {
  const r = spawnSync(FFMPEG, [
    "-y", "-ss", String(seekSec),
    "-i", url,
    "-frames:v", "1",
    "-vf", "scale=-2:1080",
    "-q:v", "3",
    outFile,
  ], { stdio: ["ignore", "ignore", "pipe"] });
  if (r.status !== 0) {
    const msg = r.stderr?.toString().trim().split("\n").slice(-3).join(" ") || "ffmpeg failed";
    throw new Error(msg);
  }
}

// Mean Y luminance of a local JPEG (0–255). Returns 255 on failure so we don't retry.
function getLuminance(file) {
  const r = spawnSync(FFPROBE, [
    "-v", "quiet",
    "-f", "lavfi",
    "-i", `movie=${file.replace(/\\/g, "/")},signalstats`,
    "-show_entries", "frame_tags=lavfi.signalstats.YAVG",
    "-of", "default=noprint_wrappers=1:nokey=1",
  ], { encoding: "utf8" });
  const val = parseFloat(r.stdout.trim());
  return Number.isNaN(val) ? 255 : val;
}

// Duration in seconds of a remote video via ffprobe
function getVideoDuration(url) {
  const r = spawnSync(FFPROBE, [
    "-v", "quiet",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    url,
  ], { encoding: "utf8" });
  return parseFloat(r.stdout.trim()) || 0;
}

async function main() {
  requireEnv();
  const client = s3();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "everdays-hd-"));

  let done = 0, skipped = 0, failed = 0, retried = 0;
  const clips = CLIPS.slice(0, LIMIT);
  console.log(`Processing ${clips.length} clip(s)…`);

  for (const clip of clips) {
    const hdKey = `${clip.name}-hd.jpg`;
    const sourceUrl = `${CDN}/${clip.name}.mp4`;
    const outFile = path.join(tmp, hdKey);

    if (DRY) {
      console.log(`~ ${clip.name}  ${sourceUrl} → ${hdKey}`);
      done++;
      continue;
    }

    if (!FORCE && await hdExists(client, hdKey)) {
      process.stdout.write(`= ${clip.name}: exists\n`);
      skipped++;
      continue;
    }

    const idx = done + skipped + failed + 1;
    process.stdout.write(`[${idx}/${clips.length}] ${clip.name}  extracting… `);
    const t0 = Date.now();

    try {
      // First attempt: 0.5s in
      extractFrame(sourceUrl, 0.5, outFile);

      // Check if frame is too dark
      const luma = getLuminance(outFile);
      if (luma < DARK_THRESHOLD) {
        process.stdout.write(`dark(${Math.round(luma)}) → retrying at 50%… `);
        const dur = getVideoDuration(sourceUrl);
        if (dur > 1) {
          extractFrame(sourceUrl, dur / 2, outFile);
        }
        retried++;
      }

      const kb = Math.round(fs.statSync(outFile).size / 1024);
      process.stdout.write(`${kb}KB  uploading… `);

      await client.send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: hdKey,
        Body: fs.readFileSync(outFile),
        ContentType: "image/jpeg",
      }));

      console.log(`done  [${((Date.now() - t0) / 1000).toFixed(1)}s]`);
      done++;
    } catch (e) {
      console.error(`\n  ✗ ${clip.name}: ${e.message}`);
      failed++;
    } finally {
      try { fs.rmSync(outFile, { force: true }); } catch {}
    }
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\nDone. Generated ${done} (${retried} retried at 50%), skipped ${skipped}, failed ${failed}.`);
}

main().catch(e => { console.error(e); process.exit(1); });
