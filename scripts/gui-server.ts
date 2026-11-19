import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, exec, ChildProcess } from 'node:child_process';

export interface ClipState {
  index: number;
  name: string;
  percent: number;
  status: 'waiting' | 'running' | 'done' | 'error';
  stage: string;
  duration?: number;
  outFile?: string;
  setId?: number;
}

export interface PipelineState {
  status: 'idle' | 'running' | 'stopping' | 'done' | 'error' | 'cancelled';
  globalStage: string;
  globalMessage: string;
  url: string;
  numClips: number;
  facecam: boolean;
  subtitles: boolean;
  clipMode: 'stream' | 'download';
  clips: ClipState[];
  startTime: number | null;
  endTime: number | null;
  elapsedSeconds: number;
  etaSeconds: number | null;
  activeSetId: number | null;
  cancelAfterCurrent: boolean;
  error?: string;
}

const CONTROL_FILE = path.resolve('scripts/.clipper-control.json');
const HTML_FILE = path.resolve('src/gui/index.html');

let pipelineState: PipelineState = {
  status: 'idle',
  globalStage: 'idle',
  globalMessage: 'Ready. Enter video URL and click Start.',
  url: '',
  numClips: 4,
  facecam: true,
  subtitles: true,
  clipMode: 'stream',
  clips: [],
  startTime: null,
  endTime: null,
  elapsedSeconds: 0,
  etaSeconds: null,
  activeSetId: null,
  cancelAfterCurrent: false,
};

let activeChildProcess: ChildProcess | null = null;
const sseClients: Set<http.ServerResponse> = new Set();
let timerInterval: NodeJS.Timeout | null = null;

// Send SSE event to all connected clients
function broadcastState() {
  const data = JSON.stringify(pipelineState);
  for (const client of sseClients) {
    try {
      client.write(`event: state\ndata: ${data}\n\n`);
    } catch {
      sseClients.delete(client);
    }
  }
}

// Compute dynamic ETA in seconds
function calculateEta(): number | null {
  if (pipelineState.status !== 'running' && pipelineState.status !== 'stopping') {
    return null;
  }
  if (!pipelineState.startTime) return null;

  const now = Date.now();
  const elapsedSec = (now - pipelineState.startTime) / 1000;
  const clips = pipelineState.clips;
  if (!clips || clips.length === 0) return null;

  const totalClips = clips.length;
  const doneClips = clips.filter((c) => c.status === 'done').length;
  const runningClip = clips.find((c) => c.status === 'running');
  const runningFrac = runningClip ? (runningClip.percent || 0) / 100 : 0;

  const effectiveCompleted = doneClips + runningFrac;

  if (effectiveCompleted >= totalClips) {
    return 0;
  }

  if (effectiveCompleted >= 0.25 && elapsedSec > 5) {
    const secPerClip = elapsedSec / effectiveCompleted;
    const remainingClips = totalClips - effectiveCompleted;
    return Math.max(0, Math.round(remainingClips * secPerClip));
  }

  // Fallback initial estimate: ~45s per clip in stream mode, ~75s in download mode
  const clipTime = pipelineState.clipMode === 'stream' ? 45 : 75;
  const roughSec = Math.max(0, Math.round(totalClips * clipTime - elapsedSec));
  return roughSec;
}

// Timer tick every 1s
function startTicker() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (pipelineState.status === 'running' || pipelineState.status === 'stopping') {
      if (pipelineState.startTime) {
        pipelineState.elapsedSeconds = Math.round((Date.now() - pipelineState.startTime) / 1000);
      }
      pipelineState.etaSeconds = calculateEta();
      broadcastState();
    }
  }, 1000);
}

// Kill child process tree on Windows
function killProcessTree(pid: number) {
  if (process.platform === 'win32') {
    try {
      exec(`taskkill /pid ${pid} /T /F`);
    } catch (err: any) {
      console.warn('taskkill error:', err.message);
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
}

// Check if Remotion Studio is active on port 3000
function isStudioRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:3000', (res) => {
      resolve(res.statusCode !== undefined);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(600, () => {
      req.destroy();
      resolve(false);
    });
  });
}

// Ensure Remotion Studio is running
async function ensureStudioStarted(): Promise<void> {
  const running = await isStudioRunning();
  if (running) return;

  console.log('Launching Remotion Studio in background on port 3000...');
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'npx.cmd' : 'npx';
  const studioProcess = spawn(cmd, ['remotion', 'studio', '--port=3000'], {
    detached: true,
    stdio: 'ignore',
    shell: isWin,
  });
  studioProcess.unref();

  // Wait up to 3 seconds for it to start
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (await isStudioRunning()) break;
  }
}

// Open URL in default browser
function openBrowserUrl(url: string) {
  const isWin = process.platform === 'win32';
  if (isWin) {
    exec(`start "" "${url}"`);
  } else if (process.platform === 'darwin') {
    exec(`open "${url}"`);
  } else {
    exec(`xdg-open "${url}"`);
  }
}

// Create HTTP Server
export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    // Serve HTML UI
    if (pathname === '/' || pathname === '/index.html') {
      if (fs.existsSync(HTML_FILE)) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        fs.createReadStream(HTML_FILE).pipe(res);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('UI HTML file not found at src/gui/index.html');
      }
      return;
    }

    // SSE Events Stream
    if (pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write('\n');

      sseClients.add(res);

      // Immediately send current state
      res.write(`event: state\ndata: ${JSON.stringify(pipelineState)}\n\n`);

      req.on('close', () => {
        sseClients.delete(res);
      });
      return;
    }

    // REST: Get Status
    if (pathname === '/api/status' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(pipelineState));
      return;
    }

    // Helper: read JSON body
    const readBody = (): Promise<any> =>
      new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
        });
        req.on('end', () => {
          try {
            resolve(body ? JSON.parse(body) : {});
          } catch (e) {
            reject(e);
          }
        });
        req.on('error', reject);
      });

    // REST: Start Clipper
    if (pathname === '/api/start' && req.method === 'POST') {
      if (pipelineState.status === 'running' || pipelineState.status === 'stopping') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Clipper is already running' }));
        return;
      }

      let payload: any = {};
      try {
        payload = await readBody();
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
        return;
      }

      const targetUrl = (payload.url || '').trim();
      const numClips = Math.min(10, Math.max(1, parseInt(payload.numClips, 10) || 4));
      const facecam = payload.facecam !== false;
      const subtitles = payload.subtitles !== false;
      const clipMode: 'stream' | 'download' = payload.clipMode === 'download' ? 'download' : 'stream';

      if (!targetUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Video URL is required' }));
        return;
      }

      // Initialize State
      const initialClips: ClipState[] = Array.from({ length: numClips }, (_, i) => ({
        index: i + 1,
        name: `Clip ${i + 1}`,
        percent: 0,
        status: 'waiting',
        stage: 'In queue',
      }));

      pipelineState = {
        status: 'running',
        globalStage: 'starting',
        globalMessage: 'Starting clipper pipeline...',
        url: targetUrl,
        numClips,
        facecam,
        subtitles,
        clipMode,
        clips: initialClips,
        startTime: Date.now(),
        endTime: null,
        elapsedSeconds: 0,
        etaSeconds: numClips * (clipMode === 'stream' ? 45 : 75),
        activeSetId: null,
        cancelAfterCurrent: false,
      };

      // Reset control file
      fs.writeFileSync(CONTROL_FILE, JSON.stringify({ cancelAfterCurrent: false }, null, 2), 'utf-8');

      startTicker();
      broadcastState();

      // Launch child process using direct node execution to avoid cmd.exe & separator issues
      const tsxCli = path.resolve('node_modules/tsx/dist/cli.mjs');
      const scriptPath = path.resolve('scripts/process-video.ts');
      const args = [
        tsxCli,
        scriptPath,
        targetUrl,
        '--clips',
        numClips.toString(),
        '--json-progress',
        '--control-file',
        CONTROL_FILE,
      ];

      if (!facecam) args.push('--no-facecam');
      if (!subtitles) args.push('--no-subtitles');
      if (clipMode === 'stream') {
        args.push('--stream');
      } else {
        args.push('--full-download');
      }

      console.log(`Starting clipper: ${process.execPath} ${args.join(' ')}`);

      try {
        const child = spawn(process.execPath, args, {
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        activeChildProcess = child;

        let stdoutBuffer = '';

        child.stdout?.on('data', (chunk: Buffer) => {
          stdoutBuffer += chunk.toString();
          const lines = stdoutBuffer.split('\n');
          stdoutBuffer = lines.pop() || '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (trimmed.startsWith('JSON_PROGRESS:')) {
              try {
                const jsonStr = trimmed.slice('JSON_PROGRESS:'.length);
                const ev = JSON.parse(jsonStr);

                if (ev.type === 'status_update') {
                  pipelineState.globalStage = ev.stage || pipelineState.globalStage;
                  pipelineState.globalMessage = ev.message || pipelineState.globalMessage;
                  if (ev.setId) pipelineState.activeSetId = ev.setId;
                } else if (ev.type === 'init_clips') {
                  if (ev.setId) pipelineState.activeSetId = ev.setId;
                  pipelineState.globalMessage = `Found ${ev.totalClips} viral clip moments. Processing...`;
                } else if (ev.type === 'clip_start') {
                  const clip = pipelineState.clips.find((c) => c.index === ev.clipIndex);
                  if (clip) {
                    clip.status = 'running';
                    clip.percent = ev.percent || 5;
                    clip.stage = ev.stage || 'Cutting video & audio';
                  }
                  pipelineState.globalMessage = `Processing Clip ${ev.clipIndex} of ${ev.totalClips}...`;
                } else if (ev.type === 'clip_progress' || ev.type === 'clip_render_progress') {
                  const clip = pipelineState.clips.find((c) => c.index === ev.clipIndex);
                  if (clip) {
                    clip.status = 'running';
                    clip.percent = ev.percent;
                    clip.stage = ev.stage;
                  }
                } else if (ev.type === 'clip_done') {
                  const clip = pipelineState.clips.find((c) => c.index === ev.clipIndex);
                  if (clip) {
                    clip.status = 'done';
                    clip.percent = 100;
                    clip.stage = 'Done';
                    clip.duration = ev.duration;
                    clip.outFile = ev.outFile;
                    clip.setId = ev.setId;
                  }
                  if (ev.setId) pipelineState.activeSetId = ev.setId;
                  pipelineState.globalMessage = `Clip ${ev.clipIndex} completed!`;
                } else if (ev.type === 'clip_error') {
                  const clip = pipelineState.clips.find((c) => c.index === ev.clipIndex);
                  if (clip) {
                    clip.status = 'error';
                    clip.stage = ev.error || 'Failed to render';
                  }
                } else if (ev.type === 'cancelled_after_current') {
                  pipelineState.status = 'cancelled';
                  pipelineState.globalMessage = ev.message || `Cleanly cancelled after Clip ${ev.clipIndex}.`;
                } else if (ev.type === 'all_done') {
                  pipelineState.status = 'done';
                  pipelineState.globalMessage = 'All clips processed and rendered successfully!';
                  pipelineState.endTime = Date.now();
                  pipelineState.etaSeconds = 0;
                }

                broadcastState();
              } catch (err: any) {
                console.warn('Failed to parse JSON_PROGRESS line:', trimmed, err.message);
              }
            } else {
              // Log standard output to server console
              console.log(`[Clipper] ${trimmed}`);
            }
          }
        });

        child.stderr?.on('data', (chunk: Buffer) => {
          const text = chunk.toString().trim();
          if (text) {
            console.error(`[Clipper STDERR] ${text}`);
          }
        });

        child.on('close', (code) => {
          activeChildProcess = null;
          console.log(`Clipper process exited with code ${code}`);

          if (pipelineState.status === 'running' || pipelineState.status === 'stopping') {
            if (code === 0) {
              pipelineState.status = 'done';
              pipelineState.globalMessage = 'Pipeline completed!';
            } else if (pipelineState.cancelAfterCurrent) {
              pipelineState.status = 'cancelled';
              pipelineState.globalMessage = 'Cancelled after current clip.';
            } else {
              pipelineState.status = 'error';
              pipelineState.globalMessage = `Pipeline exited with code ${code}`;
              pipelineState.error = `Process error (exit code ${code})`;
            }
          }

          pipelineState.endTime = Date.now();
          pipelineState.etaSeconds = 0;
          broadcastState();
        });

        child.on('error', (err) => {
          activeChildProcess = null;
          console.error('Child spawn error:', err);
          pipelineState.status = 'error';
          pipelineState.globalMessage = `Failed to spawn clipper: ${err.message}`;
          pipelineState.error = err.message;
          broadcastState();
        });
      } catch (err: any) {
        pipelineState.status = 'error';
        pipelineState.globalMessage = err.message;
        broadcastState();
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, status: pipelineState.status }));
      return;
    }

    // REST: Cancel Immediately
    if (pathname === '/api/cancel' && req.method === 'POST') {
      if (activeChildProcess && activeChildProcess.pid) {
        console.log(`Killing child process PID ${activeChildProcess.pid}...`);
        killProcessTree(activeChildProcess.pid);
        activeChildProcess = null;
      }

      pipelineState.status = 'cancelled';
      pipelineState.globalMessage = 'Process cancelled immediately by user.';
      pipelineState.endTime = Date.now();
      pipelineState.etaSeconds = null;
      broadcastState();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // REST: Cancel After Current Clip
    if (pathname === '/api/cancel-after-current' && req.method === 'POST') {
      if (pipelineState.status !== 'running') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Clipper is not currently running' }));
        return;
      }

      pipelineState.cancelAfterCurrent = true;
      pipelineState.status = 'stopping';
      pipelineState.globalMessage = 'Stop requested: Will finish the currently running clip then cancel.';

      try {
        fs.writeFileSync(CONTROL_FILE, JSON.stringify({ cancelAfterCurrent: true }, null, 2), 'utf-8');
      } catch (err: any) {
        console.warn('Error writing control file:', err.message);
      }

      broadcastState();

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Will stop after current clip finishes' }));
      return;
    }

    // REST: Open in Remotion Studio Editor
    if (pathname === '/api/open-editor' && req.method === 'POST') {
      let body: any = {};
      try {
        body = await readBody();
      } catch {}

      const clipId = parseInt(body.clipId, 10) || 1;
      const compId = `Clip${clipId}`;
      const editorUrl = `http://localhost:3000/${compId}`;

      console.log(`Opening clip in Studio: ${editorUrl}`);
      await ensureStudioStarted();
      openBrowserUrl(editorUrl);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, url: editorUrl }));
      return;
    }

    // REST: Open Rendered Video
    if (pathname === '/api/open-video' && req.method === 'POST') {
      let body: any = {};
      try {
        body = await readBody();
      } catch {}

      const outFile = body.outFile;
      if (outFile) {
        const fullPath = path.resolve(outFile);
        if (fs.existsSync(fullPath)) {
          if (process.platform === 'win32') {
            exec(`start "" "${fullPath}"`);
          } else {
            exec(`open "${fullPath}"`);
          }
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // REST: Open Folder in Explorer
    if (pathname === '/api/open-folder' && req.method === 'POST') {
      let body: any = {};
      try {
        body = await readBody();
      } catch {}

      const targetFolder = body.folder || 'out';
      const folderPath = path.resolve(
        pipelineState.activeSetId ? path.join(targetFolder, pipelineState.activeSetId.toString()) : targetFolder
      );

      if (!fs.existsSync(folderPath)) {
        fs.mkdirSync(folderPath, { recursive: true });
      }

      if (process.platform === 'win32') {
        exec(`explorer.exe "${folderPath}"`);
      } else {
        exec(`open "${folderPath}"`);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // 404 Fallback
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });
}

// Standalone entrypoint
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const PORT = parseInt(process.env.PORT || '4500', 10);
  const server = createServer();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n=================================================`);
    console.log(` GTA VI Shorts Clipper GUI Server`);
    console.log(` Running at: http://localhost:${PORT}`);
    console.log(`=================================================\n`);
  });
}
