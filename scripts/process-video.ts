import fs from 'node:fs';
import path from 'node:path';
import { execSync, spawnSync, spawn } from 'node:child_process';
import { transcribe, toCaptions } from '@remotion/install-whisper-cpp';

// 1. Setup Environment PATH so ffmpeg, ffprobe, and yt-dlp are guaranteed to be found
function setupEnvironmentPath() {
  const extraPaths: string[] = [
    'C:\\Python314\\Scripts',
    'C:\\Python314',
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links'),
  ];

  const packagesDir = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  if (fs.existsSync(packagesDir)) {
    try {
      for (const entry of fs.readdirSync(packagesDir)) {
        if (entry.includes('FFmpeg')) {
          const p = path.join(packagesDir, entry);
          for (const s of fs.readdirSync(p)) {
            const b = path.join(p, s, 'bin');
            if (fs.existsSync(b)) {
              extraPaths.unshift(b);
            }
          }
        }
      }
    } catch {
      // Ignore
    }
  }

  process.env.PATH = [...extraPaths, process.env.PATH || ''].join(path.delimiter);
}

setupEnvironmentPath();

// Helper: parse HH:MM:SS or SS to seconds
function parseTimestamp(ts: string): number {
  if (!ts) return 0;
  if (!ts.includes(':')) {
    const val = parseFloat(ts);
    return isNaN(val) ? 0 : val;
  }
  const parts = ts.split(':').map((p) => parseFloat(p) || 0);
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return 0;
}

// Helper: format seconds to HH:MM:SS.ms for yt-dlp --download-sections
function formatHms(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = (seconds % 60).toFixed(2);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(h)}:${pad(m)}:${s.padStart(5, '0')}`;
}

// Helper: generate punchy 4-6 word curiosity hook headline
function generateCuriosityHook(transcriptText: string, videoTitle: string, index: number): string {
  const defaultHooks = [
    'HE DID NOT SEE THIS COMING',
    'HOW DID HE SURVIVE THIS',
    'THE BIGGEST MISTAKE IN GTA',
    'THIS NPC HAD ENOUGH',
    'NO WAY HE PULLED THIS OFF',
    'COPS NEVER SAW THIS COMING',
  ];

  if (!transcriptText || transcriptText.trim().length < 10) {
    return defaultHooks[(index - 1) % defaultHooks.length];
  }

  const clean = transcriptText.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ');
  const words = clean.split(/\s+/).filter((w) => w.length > 2);

  if (clean.includes('POLICE') || clean.includes('COPS') || clean.includes('BUSTED')) {
    return 'COPS NEVER SAW THIS COMING';
  }
  if (clean.includes('WTF') || clean.includes('NO WAY') || clean.includes('WHAT THE')) {
    return 'HE COULD NOT BELIEVE THIS';
  }
  if (clean.includes('DIED') || clean.includes('DEAD') || clean.includes('EXPLODED')) {
    return 'HE REGRETTED THIS IMMEDIATELY';
  }
  if (clean.includes('RUN') || clean.includes('ESCAPE') || clean.includes('SPEED')) {
    return 'THE MOST INSANE GETAWAY EVER';
  }

  // Synthesize from first few key words
  if (words.length >= 4) {
    return words.slice(0, 5).join(' ');
  }

  return defaultHooks[(index - 1) % defaultHooks.length];
}

const CHARACTER_COLORS = [
  '#00F0FF', // Jason / Protagonist 1 (Electric Cyan)
  '#FF2A85', // Lucia / Protagonist 2 (Hot Pink)
  '#FFE600', // Police / Warning / Shouting (Electric Yellow)
  '#00FF66', // Friend / Sidekick / NPC (Neon Lime)
  '#B026FF', // Rival / Boss (Electric Purple)
  '#FF6B00', // Dispatcher / Alternate (Blaze Orange)
];

function assignSpeakerTurns(captions: any[]): any[] {
  let currentSpeaker = 0;
  return captions.map((cap, idx) => {
    if (idx > 0) {
      const prev = captions[idx - 1];
      const prevText = (prev.text || '').trim();
      const prevStart = prev.startMs ?? prev.fromMs ?? 0;
      const currStart = cap.startMs ?? cap.fromMs ?? 0;
      const isSentenceEnd =
        prevText.endsWith('.') ||
        prevText.endsWith('?') ||
        prevText.endsWith('!') ||
        prevText === '.' ||
        prevText === '?' ||
        prevText === '!';
      const isLongPause = currStart - prevStart >= 1200;

      // Conversational turn shift on sentence punctuation or significant pause
      if (isSentenceEnd || isLongPause) {
        currentSpeaker = (currentSpeaker + 1) % CHARACTER_COLORS.length;
      }
    }

    const speakerColor = CHARACTER_COLORS[currentSpeaker];
    return {
      ...cap,
      speakerId: currentSpeaker,
      color: speakerColor,
    };
  });
}

interface OptimalEndResult {
  duration: number;
  reason: string;
}

function findOptimalClipEnd(options: {
  captions: any[];
  sceneTimesInClip: number[];
  audioSilences: Array<{ start: number; end: number }>;
  currentDuration: number;
  minDuration?: number;
  maxDuration?: number;
  sweetSpot?: number;
}): OptimalEndResult {
  const {
    captions,
    sceneTimesInClip,
    audioSilences,
    currentDuration,
    minDuration = 40.0,
    maxDuration = 57.0,
    sweetSpot = 48.0,
  } = options;

  const effectiveMax = Math.min(57.5, Math.min(maxDuration, currentDuration));
  const effectiveMin = Math.min(minDuration, effectiveMax - 2.0);

  type CandidatePoint = {
    duration: number;
    score: number;
    reason: string;
  };

  const candidates: CandidatePoint[] = [];

  // 1. Evaluate spoken sentence boundaries from Whisper (highest narrative quality)
  if (captions && captions.length > 0) {
    for (let i = 0; i < captions.length; i++) {
      const c = captions[i];
      const txt = (c.text || '').trim();
      const endSec = (c.endMs ?? c.toMs ?? 0) / 1000.0;

      if (endSec < effectiveMin || endSec > effectiveMax) {
        continue;
      }

      let score = 0;
      let reasonType = 'Pause';

      if (txt.includes('?')) {
        score += 45; // Question punchline / cliffhanger
        reasonType = 'Question cliffhanger';
      } else if (txt.includes('!')) {
        score += 38; // Exclamation punchline / high energy
        reasonType = 'Exclamation punchline';
      } else if (txt.includes('.') || txt.includes('...')) {
        score += 28; // Sentence completion
        reasonType = 'Sentence closure';
      }

      let pauseDur = 0;
      if (i < captions.length - 1) {
        const nextStart = (captions[i + 1].startMs ?? captions[i + 1].fromMs ?? 0) / 1000.0;
        pauseDur = Math.max(0, nextStart - endSec);
        if (pauseDur >= 0.3) {
          score += Math.min(30, pauseDur * 25);
        }
      } else {
        pauseDur = 0.5;
        score += 20;
      }

      // Proximity to 45s-50s sweet spot
      const dist = Math.abs(endSec - sweetSpot);
      score += Math.max(0, 20 - dist * 1.8);

      // Check alignment with visual scene change (within 0.8s)
      for (const st of sceneTimesInClip) {
        if (Math.abs(st - endSec) <= 0.8) {
          score += 22;
          reasonType += ' + scene transition';
          break;
        }
      }

      // Accept if it has ending punctuation or noticeable pause
      if (score > 15 && (/[.!?]/.test(txt) || pauseDur >= 0.35)) {
        const tailBuffered = Math.min(effectiveMax, endSec + 0.28);
        candidates.push({
          duration: tailBuffered,
          score,
          reason: `${reasonType} at "${txt}" (${tailBuffered.toFixed(1)}s)`,
        });
      }
    }
  }

  // 2. Evaluate Audio Silences from ffmpeg (silencedetect)
  for (const sil of audioSilences) {
    if (sil.start >= effectiveMin && sil.start <= effectiveMax) {
      const dur = Math.min(effectiveMax, sil.start + 0.25);
      const dist = Math.abs(dur - sweetSpot);
      const score = 25 + Math.max(0, 15 - dist * 1.5);
      candidates.push({
        duration: dur,
        score,
        reason: `Audio energy drop / speech pause (${dur.toFixed(1)}s)`,
      });
    }
  }

  // 3. Evaluate Visual Scene Cuts (ffmpeg)
  for (const st of sceneTimesInClip) {
    if (st >= effectiveMin && st <= effectiveMax) {
      const dist = Math.abs(st - sweetSpot);
      const score = 20 + Math.max(0, 15 - dist * 1.5);
      candidates.push({
        duration: st,
        score,
        reason: `Visual scene cut transition (${st.toFixed(1)}s)`,
      });
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score);
    const best = candidates[0];
    return {
      duration: Math.min(effectiveMax, Math.max(effectiveMin, parseFloat(best.duration.toFixed(2)))),
      reason: best.reason,
    };
  }

  const fallbackDuration = Math.min(effectiveMax, Math.max(effectiveMin, sweetSpot));
  return {
    duration: parseFloat(fallbackDuration.toFixed(2)),
    reason: `Natural engagement cutoff (${fallbackDuration.toFixed(1)}s)`,
  };
}

function getNextSetId(): number {
  const rawDir = path.resolve('raw_videos');
  const outDir = path.resolve('out');
  const existingNumbers: number[] = [];

  for (const dir of [rawDir, outDir]) {
    if (fs.existsSync(dir)) {
      for (const item of fs.readdirSync(dir)) {
        if (/^\d+$/.test(item)) {
          const num = parseInt(item, 10);
          if (!isNaN(num) && num > 0) existingNumbers.push(num);
        }
      }
    }
  }

  if (existingNumbers.length === 0) {
    return 1;
  }
  return Math.max(...existingNumbers) + 1;
}

async function main() {
  const args = process.argv.slice(2);
  let targetUrl = '';
  let manualTimestamp: number | null = null;
  let noRender = false;
  let numClips = 3;
  let noFacecam = false;
  let forceFacecam = false;
  let noSubtitles = false;
  let jsonProgress = false;
  let streamMode = false;
  let controlFilePath = '';
  let customSetId: number | null = null;
  let minDuration = 40.0;
  let maxDuration = 57.0;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--timestamp' || arg === '-t') {
      manualTimestamp = parseTimestamp(args[++i]);
    } else if (arg === '--no-render') {
      noRender = true;
    } else if (arg === '--no-facecam') {
      noFacecam = true;
    } else if (arg === '--facecam') {
      forceFacecam = true;
    } else if (arg === '--no-subtitles') {
      noSubtitles = true;
    } else if (arg === '--subtitles') {
      noSubtitles = false;
    } else if (arg === '--json-progress') {
      jsonProgress = true;
    } else if (arg === '--stream' || arg === '--no-download' || arg === '--direct-clip') {
      streamMode = true;
    } else if (arg === '--full-download' || arg === '--download') {
      streamMode = false;
    } else if (arg === '--control-file') {
      controlFilePath = path.resolve(args[++i]);
    } else if (arg === '--min-duration' || arg === '--min') {
      const parsed = parseFloat(args[++i]);
      if (!isNaN(parsed) && parsed > 0) minDuration = Math.max(15, parsed);
    } else if (arg === '--max-duration' || arg === '--max') {
      const parsed = parseFloat(args[++i]);
      if (!isNaN(parsed) && parsed > 0) maxDuration = Math.min(57.5, parsed);
    } else if (arg === '--set' || arg === '-s') {
      const parsed = parseInt(args[++i], 10);
      if (!isNaN(parsed) && parsed > 0) {
        customSetId = parsed;
      }
    } else if (arg === '--clips' || arg === '-c' || arg === '-n') {
      const parsed = parseInt(args[++i], 10);
      if (!isNaN(parsed) && parsed > 0) {
        numClips = parsed;
      }
    } else if (!arg.startsWith('-') && !targetUrl) {
      targetUrl = arg;
    }
  }

  const emitProgress = (payload: any) => {
    if (jsonProgress) {
      console.log(`JSON_PROGRESS:${JSON.stringify(payload)}`);
    }
  };

  const shouldCancelAfterCurrent = (): boolean => {
    if (!controlFilePath || !fs.existsSync(controlFilePath)) return false;
    try {
      const data = JSON.parse(fs.readFileSync(controlFilePath, 'utf-8'));
      return !!data.cancelAfterCurrent;
    } catch {
      return false;
    }
  };

  const renderRemotionWithProgress = (
    compId: string,
    outFile: string,
    onProgress?: (frac: number) => void
  ): Promise<void> => {
    if (fs.existsSync(outFile)) {
      try {
        fs.unlinkSync(outFile);
      } catch {}
    }

    return new Promise((resolve, reject) => {
      const isWin = process.platform === 'win32';
      const cmd = isWin ? 'npx.cmd' : 'npx';
      const child = spawn(cmd, ['remotion', 'render', compId, outFile], {
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: isWin,
      });

      const parseOutput = (data: Buffer) => {
        const text = data.toString();
        const match =
          /Rendered\s+(\d+)\/(\d+)\s+frames/i.exec(text) ||
          /(\d+)\/(\d+)\s+frames/i.exec(text) ||
          /frame\s+(\d+)\s+of\s+(\d+)/i.exec(text);
        if (match) {
          const cur = parseInt(match[1], 10);
          const tot = parseInt(match[2], 10);
          if (tot > 0 && onProgress) {
            onProgress(Math.min(1.0, Math.max(0, cur / tot)));
          }
        }
      };

      child.stdout?.on('data', parseOutput);
      child.stderr?.on('data', parseOutput);

      child.on('close', (code) => {
        if (code === 0) {
          if (onProgress) onProgress(1.0);
          resolve();
        } else {
          reject(new Error(`Remotion render exited with code ${code}`));
        }
      });

      child.on('error', (err) => reject(err));
    });
  };

  if (!targetUrl) {
    console.error('Usage: npm run clip -- "<YOUTUBE_URL_OR_FILE>" [--timestamp HH:MM:SS] [--clips N] [--no-facecam] [--no-render]');
    process.exit(1);
  }

  // Auto-detect timestamp from YouTube URL if provided (e.g. &t=691s)
  if (manualTimestamp === null) {
    const tMatch = /[?&]t=([0-9hms]+)/i.exec(targetUrl);
    if (tMatch) {
      const tVal = tMatch[1].replace('s', '');
      manualTimestamp = parseTimestamp(tVal);
      console.log(`Extracted timestamp from URL parameter: ${manualTimestamp}s`);
    }
  }

  const setId = customSetId ?? getNextSetId();

  console.log('=== GTA SHORTS CLIPPER PIPELINE ===');
  console.log('Target URL / Input:', targetUrl);
  console.log(`Set ID: ${setId} (subfolders: raw_videos/${setId}/, out/${setId}/, public/clips/${setId}/)`);
  console.log(`Clips to generate: ${numClips}`);
  if (manualTimestamp !== null) {
    console.log(`Manual Timestamp: ${manualTimestamp}s`);
  }
  console.log(`Render mode: ${noRender ? 'Studio Preview Only (--no-render)' : 'Full Render'}`);

  const rawBaseDir = path.resolve('raw_videos');
  const outBaseDir = path.resolve('out');
  const publicClipsBaseDir = path.resolve('public/clips');

  const rawSetDir = path.join(rawBaseDir, setId.toString());
  const outSetDir = path.join(outBaseDir, setId.toString());
  const publicSetDir = path.join(publicClipsBaseDir, setId.toString());

  fs.mkdirSync(rawSetDir, { recursive: true });
  fs.mkdirSync(outSetDir, { recursive: true });
  fs.mkdirSync(publicSetDir, { recursive: true });

  let videoFilePath = '';
  let videoId = 'local_video';
  let videoTitle = 'GTA Gameplay';
  let videoDuration = 0;
  let heatmapData: Array<{ start_time: number; end_time: number; value: number }> = [];

  const isRemoteUrl = targetUrl.startsWith('http://') || targetUrl.startsWith('https://');

  if (isRemoteUrl) {
    emitProgress({ type: 'status_update', stage: 'metadata', message: 'Extracting video metadata & heatmap...', setId });
    console.log('\n[1/6] Extracting metadata & live chat via yt-dlp...');
    try {
      const dumpCommand = `yt-dlp --dump-json --write-subs --sub-langs live_chat --skip-download -o "${rawSetDir}/%(id)s.%(ext)s" "${targetUrl}"`;
      const metadataRaw = execSync(dumpCommand, { maxBuffer: 50 * 1024 * 1024 }).toString();
      const metadata = JSON.parse(metadataRaw);

      videoId = metadata.id || 'video';
      videoTitle = metadata.title || 'GTA Video';
      videoDuration = metadata.duration || 0;
      if (Array.isArray(metadata.heatmap)) {
        heatmapData = metadata.heatmap;
      }
      console.log(`Video Title: "${videoTitle}"`);
      console.log(`Duration: ${videoDuration}s | Heatmap points: ${heatmapData.length}`);
    } catch (err: any) {
      console.warn('Warning: Could not fetch detailed metadata/heatmap via dump-json:', err.message);
    }

    videoFilePath = path.join(rawSetDir, `${videoId}.mp4`);

    if (streamMode) {
      console.log(`\n[2/6] Direct Stream Mode: Skipping full video download!`);
      console.log(`Clip segments will be streamed directly from YouTube on demand.`);
      emitProgress({
        type: 'status_update',
        stage: 'stream_ready',
        message: 'Direct Stream Mode: Skipping full video download (zero disk waste).',
        setId,
      });
    } else {
      if (!fs.existsSync(videoFilePath)) {
        // Check if already downloaded in another set
        for (const item of fs.readdirSync(rawBaseDir)) {
          const candidate = path.join(rawBaseDir, item, `${videoId}.mp4`);
          if (fs.existsSync(candidate) && candidate !== videoFilePath) {
            console.log(`\nReusing existing video from raw_videos/${item}/${videoId}.mp4 -> raw_videos/${setId}/${videoId}.mp4`);
            fs.copyFileSync(candidate, videoFilePath);
            break;
          }
        }
      }

      if (!fs.existsSync(videoFilePath)) {
        emitProgress({ type: 'status_update', stage: 'download', message: 'Downloading 1080p source video with yt-dlp...', setId });
        console.log(`\n[2/6] Downloading 1080p H.264 MP4 into raw_videos/${setId}/...`);
        const dlCommand = `yt-dlp -f "bv*[ext=mp4][vcodec^=avc1][height<=1080]+ba[ext=m4a]/b[ext=mp4][height<=1080]/bv*+ba/b" --merge-output-format mp4 -o "${videoFilePath}" "${targetUrl}"`;
        execSync(dlCommand, { stdio: 'inherit' });
      } else {
        console.log(`\n[2/6] Video ready: raw_videos/${setId}/${videoId}.mp4`);
      }
    }
  } else {
    // Local video path
    videoFilePath = path.resolve(targetUrl);
    videoId = path.basename(videoFilePath, path.extname(videoFilePath));
    videoTitle = videoId;
    console.log(`Using local video file: ${videoFilePath}`);
  }

  // Get exact video duration from ffprobe if not set
  if (!videoDuration || videoDuration <= 0) {
    if (videoFilePath && fs.existsSync(videoFilePath)) {
      try {
        const probeOut = execSync(
          `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoFilePath}"`
        )
          .toString()
          .trim();
        videoDuration = parseFloat(probeOut) || 60;
      } catch {
        videoDuration = 180;
      }
    } else {
      videoDuration = 180;
    }
  }

  // [3/6] Smart Multi-Signal Clip Scoring
  emitProgress({ type: 'status_update', stage: 'scoring', message: 'Detecting visual motion & chat velocity spikes...', setId });
  console.log('\n[3/6] Computing multi-signal viral clip scores...');

  // A. Live Chat Replay Velocity & Keywords
  const chatFile = path.join(rawSetDir, `${videoId}.live_chat.json`);
  const chatBuckets = new Map<number, number>();
  if (fs.existsSync(chatFile)) {
    console.log('Parsing YouTube Live Chat replay file...');
    try {
      const content = fs.readFileSync(chatFile, 'utf-8');
      const lines = content.split('\n');
      const boostKeywords = ['LUL', 'OMEGALUL', 'WTF', 'NO WAY', 'W', 'CLIP', '???', 'KEKW', 'LOL'];

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const item = JSON.parse(line);
          const replayAction = item?.replayChatItemAction;
          const offsetMs = parseInt(replayAction?.videoOffsetTimeMsec || '0', 10);
          const offsetSec = Math.floor(offsetMs / 1000);
          const bucket = Math.floor(offsetSec / 10) * 10;

          // Message text
          const renderer = replayAction?.actions?.[0]?.addChatItemAction?.item?.liveChatTextMessageRenderer;
          const messageText = renderer?.message?.runs?.map((r: any) => r.text).join('') || '';

          let score = 1.0;
          for (const kw of boostKeywords) {
            if (messageText.toUpperCase().includes(kw)) {
              score += 2.0;
            }
          }
          chatBuckets.set(bucket, (chatBuckets.get(bucket) || 0) + score);
        } catch {
          // Skip line
        }
      }
    } catch (err: any) {
      console.warn('Chat parsing error:', err.message);
    }
  }

  // B. Visual motion & scene-change density via ffmpeg
  const sceneTimes: number[] = [];
  if (videoFilePath && fs.existsSync(videoFilePath)) {
    console.log('Detecting scene changes & visual motion cuts via ffmpeg...');
    try {
      const sceneDetect = spawnSync('ffmpeg', [
        '-i',
        videoFilePath,
        '-filter:v',
        "scale=480:-1,select='gt(scene,0.25)',showinfo",
        '-f',
        'null',
        '-',
      ]);
      const stderr = sceneDetect.stderr?.toString() || '';
      const regex = /pts_time:([0-9.]+)/g;
      let match;
      while ((match = regex.exec(stderr)) !== null) {
        sceneTimes.push(parseFloat(match[1]));
      }
    } catch (err: any) {
      console.warn('Scene detection warning:', err.message);
    }
    console.log(`Detected ${sceneTimes.length} visual scene cuts/motion spikes.`);
  } else {
    console.log('Direct Stream Mode: Using YouTube Heatmap & Chat Replay for scoring.');
  }

  // C. Candidate Windows Generation
  const targetWindowDuration = Math.min(57.0, Math.max(minDuration, maxDuration));
  type Candidate = { start: number; end: number; score: number };
  const candidates: Candidate[] = [];

  const maxStart = Math.max(0, videoDuration - targetWindowDuration);
  const step = Math.max(5, Math.floor(videoDuration / 120));

  for (let start = 0; start <= maxStart; start += step) {
    const end = Math.min(videoDuration, start + targetWindowDuration);
    let score = 0;

    // 1. Heatmap score (weight 4.0)
    if (heatmapData.length > 0) {
      const inRange = heatmapData.filter((h) => h.start_time >= start && h.end_time <= end);
      if (inRange.length > 0) {
        const avgHeat = inRange.reduce((a, b) => a + b.value, 0) / inRange.length;
        score += avgHeat * 4.0;
      }
    }

    // 2. Chat velocity score (weight 3.5)
    let chatCount = 0;
    for (let b = Math.floor(start / 10) * 10; b <= end; b += 10) {
      chatCount += chatBuckets.get(b) || 0;
    }
    score += Math.min(10, chatCount) * 0.35;

    // 3. Visual scene density score (weight 2.5)
    const cutsInWindow = sceneTimes.filter((t) => t >= start && t <= end).length;
    score += Math.min(15, cutsInWindow) * 0.25;

    // 4. Manual timestamp boost
    if (manualTimestamp !== null) {
      const dist = Math.abs(manualTimestamp - (start + targetWindowDuration / 2));
      if (dist < targetWindowDuration / 2) {
        score += 5000;
      }
    }

    candidates.push({ start, end, score });
  }

  // Pick top non-overlapping windows
  candidates.sort((a, b) => b.score - a.score);
  const chosenWindows: Candidate[] = [];

  for (const cand of candidates) {
    const overlaps = chosenWindows.some(
      (w) => Math.max(w.start, cand.start) < Math.min(w.end, cand.end) - 10
    );
    if (!overlaps) {
      chosenWindows.push(cand);
      if (chosenWindows.length === numClips) break;
    }
  }

  // If fewer than numClips found (e.g. short video), split video evenly
  while (chosenWindows.length < numClips) {
    const fallbackStart = Math.min(
      Math.max(0, videoDuration - targetWindowDuration),
      chosenWindows.length * Math.floor(videoDuration / numClips)
    );
    chosenWindows.push({
      start: fallbackStart,
      end: Math.min(videoDuration, fallbackStart + targetWindowDuration),
      score: 1.0,
    });
  }

  console.log(`Selected Top ${numClips} Viral Clip Windows:`);
  chosenWindows.forEach((w, i) => {
    console.log(`  Clip ${i + 1}: ${w.start.toFixed(1)}s -> ${w.end.toFixed(1)}s (Score: ${w.score.toFixed(2)})`);
  });

  // [4/6] Dead-Air Trimming, Transcription, and Metadata Generation
  console.log(`\n[4/6] Dead-air trimming, dynamic clip sizing (${minDuration}s - ${maxDuration}s) & Whisper transcription...`);

  emitProgress({
    type: 'init_clips',
    totalClips: chosenWindows.length,
    candidates: chosenWindows,
    setId,
  });

  let stoppedEarly = false;

  for (let i = 0; i < chosenWindows.length; i++) {
    const clipIndex = i + 1;
    const window = chosenWindows[i];
    const clipSetFolder = path.join(publicSetDir, `clip_${clipIndex}`);
    const clipActiveFolder = path.join(publicClipsBaseDir, `clip_${clipIndex}`);
    fs.mkdirSync(clipSetFolder, { recursive: true });
    fs.mkdirSync(clipActiveFolder, { recursive: true });

    emitProgress({
      type: 'clip_start',
      clipIndex,
      totalClips: chosenWindows.length,
      percent: 5,
      stage: 'Trimming audio & cutting video window',
    });

    let finalStart = window.start;
    let finalDuration = Math.min(maxDuration, window.end - window.start);

    // Dead-Air Check at START via ffmpeg silencedetect (pauses > 1.5s) if local video is available
    if (videoFilePath && fs.existsSync(videoFilePath)) {
      try {
        const silenceDetect = spawnSync('ffmpeg', [
          '-ss',
          window.start.toString(),
          '-t',
          finalDuration.toString(),
          '-i',
          videoFilePath,
          '-af',
          'silencedetect=noise=-30dB:d=1.5',
          '-f',
          'null',
          '-',
        ]);
        const stderr = silenceDetect.stderr?.toString() || '';
        const silenceStartMatch = /silence_start: ([0-9.]+)/.exec(stderr);
        const silenceEndMatch = /silence_end: ([0-9.]+)/.exec(stderr);

        if (silenceStartMatch && silenceEndMatch) {
          const sStart = parseFloat(silenceStartMatch[1]);
          const sEnd = parseFloat(silenceEndMatch[1]);
          if (sStart <= 0.4 && sEnd > 1.5 && sEnd < 8.0) {
            console.log(`  Clip ${clipIndex}: Trimmed ${sEnd.toFixed(1)}s of starting dead-air.`);
            finalStart += sEnd;
            finalDuration = Math.max(minDuration, finalDuration - sEnd);
          }
        }
      } catch {
        // Silence detection fallback
      }
    }

    finalDuration = Math.min(maxDuration, Math.max(minDuration, finalDuration));

    const clipMp4Path = path.join(clipSetFolder, 'clip.mp4');
    const clipWavPath = path.join(clipSetFolder, 'audio.wav');
    const clipCaptionsPath = path.join(clipSetFolder, 'captions.json');
    const clipMetaPath = path.join(clipSetFolder, 'meta.json');

    console.log(`\n  --- Processing Clip ${clipIndex} ---`);

    if (streamMode && isRemoteUrl) {
      console.log(`  [Direct Stream] Downloading slice directly from YouTube (${finalStart.toFixed(1)}s -> ${(finalStart + finalDuration).toFixed(1)}s)...`);
      emitProgress({
        type: 'clip_progress',
        clipIndex,
        totalClips: chosenWindows.length,
        percent: 10,
        stage: 'Streaming clip portion directly from YouTube (No full download)',
      });

      const startHms = formatHms(finalStart);
      const endHms = formatHms(finalStart + finalDuration);
      const sectionArg = `*${startHms}-${endHms}`;

      execSync(
        `yt-dlp --download-sections "${sectionArg}" -f "bv*[ext=mp4][vcodec^=avc1][height<=1080]+ba[ext=m4a]/b[ext=mp4][height<=1080]/bv*+ba/b" --merge-output-format mp4 -o "${clipMp4Path}" --force-overwrites "${targetUrl}"`,
        { stdio: 'ignore' }
      );

      // Apply faststart for instant browser playback
      const tmpFast = path.join(clipSetFolder, 'clip_fs.mp4');
      execSync(`ffmpeg -y -i "${clipMp4Path}" -c copy -movflags +faststart "${tmpFast}"`, { stdio: 'ignore' });
      if (fs.existsSync(tmpFast)) {
        fs.unlinkSync(clipMp4Path);
        fs.renameSync(tmpFast, clipMp4Path);
      }
    } else {
      console.log(`  Extracting initial window (${finalDuration.toFixed(1)}s) -> ${clipMp4Path}`);

      // Fast H.264 cut with +faststart for instant browser playback
      execSync(
        `ffmpeg -y -ss ${finalStart} -t ${finalDuration} -i "${videoFilePath}" -c:v libx264 -preset fast -crf 18 -c:a aac -b:a 192k -movflags +faststart "${clipMp4Path}"`,
        { stdio: 'ignore' }
      );
    }

    // Extract 16kHz mono WAV for Whisper
    execSync(`ffmpeg -y -i "${clipMp4Path}" -ar 16000 -ac 1 -c:a pcm_s16le "${clipWavPath}"`, {
      stdio: 'ignore',
    });

    emitProgress({
      type: 'clip_progress',
      clipIndex,
      totalClips: chosenWindows.length,
      percent: 20,
      stage: 'Transcribing speech with local Whisper',
    });

    // Local Whisper Transcription
    console.log(`  Transcribing with local whisper.cpp (base.en)...`);
    let captionsList: any[] = [];
    let fullTranscriptText = '';

    try {
      const whisperOutput = await transcribe({
        inputPath: path.resolve(clipWavPath),
        whisperPath: path.resolve('whisper.cpp'),
        whisperCppVersion: '1.5.5',
        model: 'base.en',
        modelFolder: path.resolve('whisper.cpp'),
        tokenLevelTimestamps: true,
        printOutput: false,
      });

      const converted = toCaptions({
        whisperCppOutput: whisperOutput,
      });
      captionsList = converted.captions || [];
      captionsList = assignSpeakerTurns(captionsList);
      fullTranscriptText = captionsList.map((c) => c.text).join(' ');
      console.log(`  Generated ${captionsList.length} word-level caption tokens with multi-character sync colors.`);
    } catch (err: any) {
      console.warn(`  Whisper transcription warning for clip ${clipIndex}:`, err.message);
    }

    emitProgress({
      type: 'clip_progress',
      clipIndex,
      totalClips: chosenWindows.length,
      percent: 45,
      stage: 'Optimizing natural narrative ending boundary',
    });

    // Dynamic Clip Boundary Optimization (40s - 57s)
    console.log(`  Evaluating natural narrative & visual ending boundaries...`);
    const audioSilences: Array<{ start: number; end: number }> = [];
    try {
      const silOut = spawnSync('ffmpeg', [
        '-i',
        clipMp4Path,
        '-af',
        'silencedetect=noise=-30dB:d=0.35',
        '-f',
        'null',
        '-',
      ]);
      const stderr = silOut.stderr?.toString() || '';
      const lines = stderr.split('\n');
      let curStart: number | null = null;
      for (const line of lines) {
        const sMatch = /silence_start: ([0-9.]+)/.exec(line);
        const eMatch = /silence_end: ([0-9.]+)/.exec(line);
        if (sMatch) curStart = parseFloat(sMatch[1]);
        if (eMatch && curStart !== null) {
          audioSilences.push({ start: curStart, end: parseFloat(eMatch[1]) });
          curStart = null;
        }
      }
    } catch {}

    const clipSceneTimes = sceneTimes
      .map((t) => t - finalStart)
      .filter((t) => t >= minDuration && t <= maxDuration);

    const { duration: optimalDuration, reason } = findOptimalClipEnd({
      captions: captionsList,
      sceneTimesInClip: clipSceneTimes,
      audioSilences,
      currentDuration: finalDuration,
      minDuration,
      maxDuration,
    });

    console.log(`  Dynamic Clip Duration: ${optimalDuration.toFixed(1)}s (Reason: ${reason})`);

    // If optimal duration is shorter than initial cut, trim MP4, WAV, and Captions
    if (optimalDuration < finalDuration - 0.4) {
      finalDuration = optimalDuration;
      const tempMp4 = path.join(clipSetFolder, 'clip_full.mp4');
      fs.renameSync(clipMp4Path, tempMp4);
      execSync(
        `ffmpeg -y -ss 0 -t ${finalDuration} -i "${tempMp4}" -c:v libx264 -preset fast -crf 18 -c:a aac -b:a 192k -movflags +faststart "${clipMp4Path}"`,
        { stdio: 'ignore' }
      );
      if (fs.existsSync(tempMp4)) fs.unlinkSync(tempMp4);

      // Re-extract audio wav for exact length matching
      execSync(`ffmpeg -y -i "${clipMp4Path}" -ar 16000 -ac 1 -c:a pcm_s16le "${clipWavPath}"`, {
        stdio: 'ignore',
      });

      // Filter and clamp captions to finalDuration
      const maxMs = Math.round(finalDuration * 1000);
      captionsList = captionsList
        .filter((c: any) => (c.startMs ?? c.fromMs ?? 0) < maxMs)
        .map((c: any) => {
          const end = c.endMs ?? c.toMs ?? 0;
          if (end > maxMs) {
            return { ...c, endMs: maxMs, toMs: maxMs };
          }
          return c;
        });
      fullTranscriptText = captionsList.map((c: any) => c.text).join(' ');
    } else {
      finalDuration = optimalDuration;
    }

    fs.writeFileSync(clipCaptionsPath, JSON.stringify(captionsList, null, 2), 'utf-8');

    // Generate Curiosity Hook Headline
    const hookText = generateCuriosityHook(fullTranscriptText, videoTitle, clipIndex);
    console.log(`  Curiosity Hook: "${hookText}"`);

    emitProgress({
      type: 'clip_progress',
      clipIndex,
      totalClips: chosenWindows.length,
      percent: 55,
      stage: 'Detecting facecam & generating metadata',
    });

    // [5/6] Facecam Detection via Python script
    let facecamInfo = {
      hasFacecam: false,
      corner: 'none',
      facecamBox: { x: 0, y: 0, width: 0, height: 0 },
    };

    if (noFacecam) {
      console.log(`  Facecam detection skipped (--no-facecam): Pure gameplay layout.`);
    } else {
      console.log(`  Running OpenCV facecam detection...`);
      try {
        const pyScript = path.resolve('scripts/detect_facecam.py');
        const pyOut = execSync(`python "${pyScript}" "${clipMp4Path}"`, { maxBuffer: 10 * 1024 * 1024 });
        facecamInfo = JSON.parse(pyOut.toString());
        if (forceFacecam) {
          facecamInfo.hasFacecam = true;
        }
        console.log(`  Facecam detected: ${facecamInfo.hasFacecam} (${facecamInfo.corner})`);
      } catch (err: any) {
        console.warn(`  Facecam detection fallback:`, err.message);
      }
    }

    // Format readable multi-line transcript for Studio editing
    const transcriptLines: string[] = [];
    let curLine = '';
    for (const c of captionsList) {
      curLine += c.text;
      if (/[.?!]/.test(c.text)) {
        transcriptLines.push(curLine.trim());
        curLine = '';
      }
    }
    if (curLine.trim()) transcriptLines.push(curLine.trim());
    const formattedTranscript = transcriptLines.join('\n');

    // Save final meta.json
    const metaData = {
      clipId: `clip_${clipIndex}`,
      videoTitle,
      start: finalStart,
      duration: finalDuration,
      width: 1920,
      height: 1080,
      fps: 60,
      hookText,
      subtitlesText: formattedTranscript,
      hasFacecam: noFacecam ? false : facecamInfo.hasFacecam,
      showSubtitles: !noSubtitles,
      corner: facecamInfo.corner,
      facecamBox: facecamInfo.facecamBox,
    };

    fs.writeFileSync(clipMetaPath, JSON.stringify(metaData, null, 2), 'utf-8');

    // Mirror to active public/clips/clip_X for Remotion Studio preview
    try {
      fs.copyFileSync(clipMp4Path, path.join(clipActiveFolder, 'clip.mp4'));
      fs.copyFileSync(clipWavPath, path.join(clipActiveFolder, 'audio.wav'));
      fs.copyFileSync(clipCaptionsPath, path.join(clipActiveFolder, 'captions.json'));
      fs.copyFileSync(clipMetaPath, path.join(clipActiveFolder, 'meta.json'));
    } catch {}

    const compId = `Clip${clipIndex}`;
    const outFile = path.join(outSetDir, `short_${clipIndex}.mp4`);
    const relOutFile = path.relative(process.cwd(), outFile).replace(/\\/g, '/');

    if (noRender) {
      console.log(`  Preview ready (--no-render): public/clips/clip_${clipIndex}`);
      emitProgress({
        type: 'clip_done',
        clipIndex,
        totalClips: chosenWindows.length,
        duration: finalDuration,
        outFile: relOutFile,
        noRender: true,
        setId,
      });
    } else {
      emitProgress({
        type: 'clip_progress',
        clipIndex,
        totalClips: chosenWindows.length,
        percent: 60,
        stage: 'Rendering 60fps vertical Short',
      });

      console.log(`  Rendering ${compId} -> ${outFile}...`);
      try {
        await renderRemotionWithProgress(compId, outFile, (frac) => {
          const pct = Math.min(99, 60 + Math.round(frac * 39));
          emitProgress({
            type: 'clip_render_progress',
            clipIndex,
            totalClips: chosenWindows.length,
            percent: pct,
            renderFraction: frac,
            stage: `Rendering video frames (${Math.round(frac * 100)}%)`,
          });
        });
        console.log(`  [SUCCESS] Rendered: out/${setId}/short_${clipIndex}.mp4`);
        emitProgress({
          type: 'clip_done',
          clipIndex,
          totalClips: chosenWindows.length,
          duration: finalDuration,
          outFile: relOutFile,
          setId,
        });
      } catch (err: any) {
        console.error(`  Error rendering ${compId}:`, err.message);
        emitProgress({
          type: 'clip_error',
          clipIndex,
          totalClips: chosenWindows.length,
          error: err.message,
        });
      }
    }

    // Check Graceful Cancel after current clip
    if (shouldCancelAfterCurrent()) {
      console.log(`\n[CANCELLED] Cleanly stopping after completing Clip ${clipIndex} as requested.`);
      emitProgress({
        type: 'cancelled_after_current',
        clipIndex,
        totalClips: chosenWindows.length,
        setId,
        message: `Cancelled after completing Clip ${clipIndex}.`,
      });
      stoppedEarly = true;
      break;
    }
  }

  if (!stoppedEarly) {
    emitProgress({
      type: 'all_done',
      totalClips: chosenWindows.length,
      setId,
    });
  }

  console.log(`\n=== PIPELINE COMPLETED SUCCESSFULLY (SET ${setId}) ===`);
  console.log(`📁 Raw Video:       raw_videos/${setId}/`);
  console.log(`📁 Rendered Shorts: out/${setId}/short_1.mp4 ...`);
  console.log(`📁 Clip Assets:     public/clips/${setId}/`);
}

main().catch((err) => {
  console.error('Pipeline failed with error:', err);
  process.exit(1);
});
