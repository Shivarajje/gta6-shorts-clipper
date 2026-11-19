import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, exec } from 'node:child_process';
import { createServer } from './gui-server';

const DEFAULT_PORT = 4500;

function findAvailablePort(startPort: number): Promise<number> {
  return new Promise((resolve) => {
    const testServer = http.createServer();
    testServer.listen(startPort, () => {
      testServer.close(() => resolve(startPort));
    });
    testServer.on('error', () => {
      resolve(findAvailablePort(startPort + 1));
    });
  });
}

function findBrowserExecutable(): string | null {
  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

  const candidates = [
    path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function main() {
  console.log('\n======================================================');
  console.log('   GTA VI SHORTS CLIPPER - DESKTOP GUI LAUNCHER');
  console.log('======================================================\n');

  const port = await findAvailablePort(DEFAULT_PORT);
  const server = createServer();

  await new Promise<void>((resolve) => {
    server.listen(port, '0.0.0.0', () => {
      console.log(`[GUI Backend] Active on http://localhost:${port}`);
      resolve();
    });
  });

  const appUrl = `http://localhost:${port}`;
  const browserPath = findBrowserExecutable();

  if (browserPath) {
    console.log(`[Window] Launching standalone app window via: ${path.basename(browserPath)}`);
    const appWindow = spawn(
      browserPath,
      [
        `--app=${appUrl}`,
        '--window-size=1080,740',
        '--window-position=center',
        '--disable-extensions',
        '--disable-plugins',
      ],
      {
        stdio: 'ignore',
        detached: false,
      }
    );

    appWindow.on('close', (code) => {
      console.log(`[Window] Application window closed (code ${code}). Shutting down.`);
      server.close();
      process.exit(0);
    });

    appWindow.on('error', (err) => {
      console.warn(`[Window] Error launching browser window: ${err.message}. Opening default browser...`);
      exec(`start "" "${appUrl}"`);
    });
  } else {
    console.log(`[Window] Opening in default browser: ${appUrl}`);
    exec(`start "" "${appUrl}"`);
  }

  console.log(`\nReady! Press Ctrl+C in this terminal to shut down.`);

  // Handle graceful terminal shutdown
  const shutdown = () => {
    console.log('\nShutting down GUI server...');
    server.close(() => {
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal launcher error:', err);
  process.exit(1);
});
