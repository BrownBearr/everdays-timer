// Extract a 1080p JPEG frame from each source MP4 on B2 and upload as {name}-hd.jpg.
// ffmpeg reads only the moov atom + first frame from the remote URL (faststart MP4s),
// so each clip takes ~2-5s rather than downloading the full video.
//
// Usage:
//   node scripts/gen-hd-posters.mjs --dry-run     # preview only
//   node scripts/gen-hd-posters.mjs --limit 3     # test first 3
//   node scripts/gen-hd-posters.mjs               # all 566 clips
//   node scripts/gen-hd-posters.mjs --force       # re-generate even if hd poster exists

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
const BUCKET = process.env.B2_BUCKET;

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

async function main() {
  requireEnv();
  const client = s3();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "everdays-hd-"));

  let done = 0, skipped = 0, failed = 0;
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
      const r = spawnSync(FFMPEG, [
        "-y",
        "-ss", "0.5",
        "-i", sourceUrl,
        "-frames:v", "1",
        "-vf", "scale=-2:1080",
        "-q:v", "3",
        outFile,
      ], { stdio: ["ignore", "ignore", "pipe"] });

      if (r.status !== 0) {
        const msg = r.stderr?.toString().trim().split("\n").slice(-3).join(" ") || "ffmpeg failed";
        throw new Error(msg);
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
  console.log(`\nDone. Generated ${done}, skipped ${skipped}, failed ${failed}.`);
}

main().catch(e => { console.error(e); process.exit(1); });
