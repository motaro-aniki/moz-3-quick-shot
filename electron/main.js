import electron from 'electron';
const { app, BrowserWindow, ipcMain, desktopCapturer, screen, nativeImage, Tray, Menu, shell, dialog, globalShortcut, Notification } = electron;
import path from 'path';
import fs from 'fs';
import { exec, spawn } from 'child_process';
import util from 'util';
const execPromise = util.promisify(exec);
import removeBackground from '@imgly/background-removal-node';
import { createRequire } from 'module';
import url from 'url';
const require = createRequire(import.meta.url);

const isDev = !app.isPackaged;
app.setName('MOZ-3 Quick Shot');

app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

let workspaceWin = null;
let captureWinsPool = [];
let isCapturing = false;
let menuWin = null;
let tray = null;
let globalFrozenSources = null; // キャプチャ遅延対策用の共有変数
let psWorker = null;            // 常駐型PowerShellワーカー
let captureResolveQueue = [];   // IPC通信用キュー
let lastCaptureBounds = null;   // 前回キャプチャの物理座標 { cropX, cropY, cropW, cropH, display_id }
app.isQuitting = false;

// ── QS AI Worker (C# + ONNX Runtime + DirectML) ───────────────
let aiWorker = null;
const aiPendingRequests = new Map(); // id → { resolve, reject }
let aiRequestCounter = 0;
const AI_REQUEST_TIMEOUT_MS = 45_000; // 45秒でタイムアウト→プロセスキル

// ── Refine temp file tracker (for guaranteed cleanup on quit) ──
const refineActivePaths = new Set();

const AI_WORKER_EXE = isDev
    ? path.join(process.cwd(), 'ai-worker', 'bin', 'Release', 'net8.0-windows', 'win-x64', 'publish', 'QSAIWorker.exe')
    : path.join(process.resourcesPath, 'ai-worker', 'QSAIWorker.exe');

// モデルはインストーラーに同梱: 本番は process.resourcesPath/models、開発時はプロジェクト直下の models
const AI_MODELS_DIR = app.isPackaged
    ? path.join(process.resourcesPath, 'models')
    : path.join(process.cwd(), 'models');

function initAIWorker() {
    if (aiWorker) return;
    if (!fs.existsSync(AI_WORKER_EXE)) {
        console.warn('[AI Worker] EXE not found:', AI_WORKER_EXE);
        return;
    }

    aiWorker = spawn(AI_WORKER_EXE, [], {
        env: { ...process.env, QS_MODELS_DIR: AI_MODELS_DIR }
    });

    let buffer = '';
    aiWorker.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const msg = JSON.parse(line);
                if (msg.id && aiPendingRequests.has(msg.id)) {
                    const { resolve, reject } = aiPendingRequests.get(msg.id);
                    aiPendingRequests.delete(msg.id);
                    if (msg.success === false) reject(new Error(msg.error));
                    else resolve(msg);
                }
            } catch (e) {
                console.error('[AI Worker] Parse error:', line);
            }
        }
    });

    aiWorker.stderr.on('data', (d) => console.error('[AI Worker]', d.toString()));
    aiWorker.on('exit', () => {
        aiWorker = null;
        // 未処理リクエストをすべてエラーで返す
        for (const { reject } of aiPendingRequests.values())
            reject(new Error('AI Worker exited unexpectedly'));
        aiPendingRequests.clear();
    });
}

function sendAIRequest(payload) {
    return new Promise((resolve, reject) => {
        if (!aiWorker) {
            // 初回のみ起動を試みる
            initAIWorker();
            if (!aiWorker) {
                reject(new Error('AI Worker is not running. Build ai-worker first.'));
                return;
            }
        }
        const id = String(++aiRequestCounter);

        // タイムアウト: 指定時間内にレスポンスがなければワーカーを強制終了
        const timeoutHandle = setTimeout(() => {
            if (!aiPendingRequests.has(id)) return;
            aiPendingRequests.delete(id);
            const workerToKill = aiWorker;
            if (workerToKill) {
                workerToKill.kill('SIGKILL');
                // aiWorker の null 化と残存リクエストの reject は exit ハンドラに委ねる
            }
            reject(new Error('Processing timeout: AI Worker did not respond within 45 seconds.'));
        }, AI_REQUEST_TIMEOUT_MS);

        aiPendingRequests.set(id, {
            resolve: (result) => { clearTimeout(timeoutHandle); resolve(result); },
            reject:  (err)    => { clearTimeout(timeoutHandle); reject(err); },
        });
        aiWorker.stdin.write(JSON.stringify({ ...payload, id }) + '\n');
    });
}


// ── Persistent Background Capture Worker ───────────────────────
async function initCaptureWorker() {
    if (psWorker) return;
    try {
        const tempDir = app.getPath('temp');
        const exePath = path.join(tempDir, 'moz3_capture_v6.exe');

        if (!fs.existsSync(exePath)) {
            const csPath = path.join(tempDir, 'moz3_capture_v6.cs');
            const manifestPath = path.join(tempDir, 'moz3_capture_v6.manifest');
            const manifestContent = `<?xml version="1.0" encoding="utf-8"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAware xmlns="http://schemas.microsoft.com/SMI/2005/WindowsSettings">true/PM</dpiAware>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2, PerMonitor</dpiAwareness>
    </windowsSettings>
  </application>
</assembly>`;
            fs.writeFileSync(manifestPath, manifestContent, 'utf8');
            const csScript = `
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.Windows.Forms;
using System.Runtime.InteropServices;
using System.IO;

public class NativeCapture {
    [DllImport("shcore.dll")]
    public static extern int SetProcessDpiAwareness(int value);
    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    public static void Main() {
        try { SetProcessDpiAwareness(2); } catch { try { SetProcessDPIAware(); } catch {} }

        while (true) {
            string cmd = Console.ReadLine();
            if (cmd != null && cmd.Trim() == "CAPTURE") {
                try {
                    var screens = Screen.AllScreens;
                    string[] paths = new string[screens.Length];
                    for (int i = 0; i < screens.Length; i++) {
                        var bounds = screens[i].Bounds;
                        using (Bitmap bmp = new Bitmap(bounds.Width, bounds.Height)) {
                            using (Graphics g = Graphics.FromImage(bmp)) {
                                g.CopyFromScreen(bounds.X, bounds.Y, 0, 0, bmp.Size);
                            }
                            string path = Path.Combine(Path.GetTempPath(), "moz3_screen_" + i + ".png");
                            bmp.Save(path, ImageFormat.Png);
                            paths[i] = path + "::" + bounds.X + "," + bounds.Y + "," + bounds.Width + "," + bounds.Height;
                        }
                    }
                    Console.WriteLine(string.Join("|", paths));
                } catch (Exception ex) {
                    Console.WriteLine("ERR:" + ex.Message);
                }
            } else if (cmd != null && cmd.Trim() == "EXIT") {
                break;
            }
        }
    }
}
`;
            fs.writeFileSync(csPath, csScript, 'utf8');
            const csc = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
            await execPromise(`"${csc}" /win32manifest:"${manifestPath}" /out:"${exePath}" /nologo "${csPath}"`);
        }

        psWorker = spawn(exePath);

        psWorker.stdout.on('data', (data) => {
            const out = data.toString().trim();
            if (out && captureResolveQueue.length > 0) {
                // 最も古いリクエストから順に結果を返す
                const resolve = captureResolveQueue.shift();
                resolve(out.split('|').filter(Boolean));
            }
        });

        psWorker.stderr.on('data', (data) => {
            console.error('Capture Worker Error:', data.toString());
        });

        psWorker.on('exit', () => {
            psWorker = null; // 意図せず終了した場合はnullに戻し、次回再起動させる
        });
    } catch (err) {
        console.error("Worker start err", err);
    }
}

// ── Configuration (Settings) ──────────────────────────────────
const getConfigPath = () => path.join(app.getPath('userData'), 'config.json');
const loadConfig = () => {
    try {
        return Object.assign({
            customSavePath: null,
            keepAiOpen: true,
            hotkeys: { startCapture: '', repeatCapture: '', showWorkspace: '' }
        }, JSON.parse(fs.readFileSync(getConfigPath(), 'utf8')));
    } catch {
        return {
            customSavePath: null,
            keepAiOpen: true,
            hotkeys: { startCapture: '', repeatCapture: '', showWorkspace: '' }
        };
    }
};
const saveConfig = (config) => fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));

function registerGlobalShortcuts() {
    globalShortcut.unregisterAll();
    const cfg = loadConfig();
    const failed = [];

    const tryRegister = (action, accelerator, handler) => {
        if (!accelerator) return;
        try {
            const ok = globalShortcut.register(accelerator, handler);
            if (!ok) {
                console.warn(`[shortcut] Failed to register ${action}: ${accelerator}`);
                failed.push({ action, accelerator });
            }
        } catch (e) {
            console.error(`[shortcut] Error registering ${action}:`, e);
            failed.push({ action, accelerator });
        }
    };

    tryRegister('startCapture',  cfg.hotkeys.startCapture,  () => startCapture());
    tryRegister('repeatCapture', cfg.hotkeys.repeatCapture, () => repeatCapture());
    tryRegister('showWorkspace', cfg.hotkeys.showWorkspace,  () => {
        if (workspaceWin) {
            workspaceWin.show();
            workspaceWin.webContents.send('start-visibility-timer', true);
        }
    });

    if (failed.length > 0) {
        const labels = {
            startCapture:  'キャプチャ開始',
            repeatCapture: '前回の範囲を再キャプチャ',
            showWorkspace: 'ワークスペース表示',
        };
        const body = failed
            .map(f => `・${labels[f.action] ?? f.action}（${f.accelerator}）`)
            .join('\n');
        new Notification({
            title: 'MOZ-3 Quick Shot — ショートカット登録失敗',
            body: `以下のショートカットを登録できませんでした。他のアプリと競合している可能性があります。\n${body}`,
        }).show();
    }
}

// ── Storage ──────────────────────────────────────────────────
const getDataDir = () => {
    const defaultDir = path.join(app.getPath('userData'), 'screenshots');
    const cfg = loadConfig();
    const targetDir = (cfg.customSavePath && fs.existsSync(cfg.customSavePath)) ? cfg.customSavePath : defaultDir;

    if (!fs.existsSync(targetDir)) {
        try { fs.mkdirSync(targetDir, { recursive: true }); }
        catch (e) { return defaultDir; }
    }
    return targetDir;
};
const getMetaPath = () => path.join(app.getPath('userData'), 'meta.json');
const loadMeta = () => {
    try { return JSON.parse(fs.readFileSync(getMetaPath(), 'utf8')); }
    catch { return { screenshots: [] }; }
};
const saveMeta = (meta) => fs.writeFileSync(getMetaPath(), JSON.stringify(meta, null, 2));

const MAX_SHOTS = 99;
const cleanupScreenshots = () => {
    const cfg = loadConfig();
    if (cfg.customSavePath && fs.existsSync(cfg.customSavePath)) return; // カスタムパス時は無制限にする

    const meta = loadMeta();
    if (meta.screenshots.length <= MAX_SHOTS) return;
    const unlocked = [...meta.screenshots]
        .sort((a, b) => a.timestamp - b.timestamp)
        .filter(s => !s.locked);
    while (meta.screenshots.length > MAX_SHOTS && unlocked.length > 0) {
        const del = unlocked.shift();
        const fp = path.join(getDataDir(), del.filename);

        if (fs.existsSync(fp)) fs.unlinkSync(fp);
        meta.screenshots = meta.screenshots.filter(s => s.id !== del.id);
    }
    saveMeta(meta);
};

let folderWatcher = null;
let watcherDebounce = null;

function syncMetaWithFolder() {
    const dir = getDataDir();
    const meta = loadMeta();
    let changed = false;

    // 現在のフォルダ内にある画像一覧を取得 (.png / .jpg)
    let files = [];
    try {
        files = fs.readdirSync(dir).filter(f => f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.jpeg') || f.endsWith('.PNG') || f.endsWith('.JPG') || f.endsWith('.JPEG'));
    } catch {
        files = [];
    }

    const currentFilesSet = new Set(files);
    const metaFilesSet = new Set(meta.screenshots.map(s => s.filename));

    // メタにないファイルを新規追加
    files.forEach(filename => {
        if (!metaFilesSet.has(filename)) {
            try {
                const stat = fs.statSync(path.join(dir, filename));
                // ファイル名からIDを推測できない場合はタイムスタンプ等から生成
                const idMatch = filename.match(/^(qs_\d{14}(?:_\d{3})?(?:_edit\d+)?)\.(png|jpg|jpeg)$/i);
                const id = idMatch ? idMatch[1] : `qs_imported_${stat.mtimeMs}_${Math.random().toString(36).substr(2, 5)}`;
                
                meta.screenshots.push({
                    id,
                    filename,
                    timestamp: stat.mtimeMs,
                    locked: false
                });
                changed = true;
            } catch (e) {
                console.error('Error reading stats for imported file', filename, e);
            }
        }
    });

    // フォルダに存在しないファイルをメタから削除
    const originalLength = meta.screenshots.length;
    meta.screenshots = meta.screenshots.filter(s => currentFilesSet.has(s.filename));
    
    if (meta.screenshots.length !== originalLength) {
        changed = true;
    }

    if (changed) {
        meta.screenshots.sort((a, b) => a.timestamp - b.timestamp);
        saveMeta(meta);
        if (menuWin && !menuWin.isDestroyed()) {
            menuWin.webContents.send('update-count', meta.screenshots.length);
        }
        if (workspaceWin && !workspaceWin.isDestroyed()) {
            workspaceWin.webContents.send('reload-workspace');
        }
    }
}

function startFolderWatcher() {
    if (folderWatcher) return;
    const dir = getDataDir();
    folderWatcher = fs.watch(dir, (eventType, filename) => {
        if (!filename) return;
        const lowerName = filename.toLowerCase();
        if (!lowerName.endsWith('.png') && !lowerName.endsWith('.jpg') && !lowerName.endsWith('.jpeg')) return;
        
        clearTimeout(watcherDebounce);
        watcherDebounce = setTimeout(() => {
            syncMetaWithFolder();
        }, 500); // 連続削除や大量追加時のI/O負荷軽減用デバウンス
    });
}

// ── Logo path ─────────────────────────────────────────────────
const logoPath = isDev
    ? path.join(process.cwd(), 'public/logo/Quick_Shot.png')
    : path.join(process.resourcesPath, 'logo/Quick_Shot.png'); // extraResources

// ── Windows ───────────────────────────────────────────────────
function createWorkspaceWindow() {
    const { workAreaSize } = screen.getPrimaryDisplay();
    // さらに拡大 (前回比で1.2倍程度): 0.42, 0.60
    const W = Math.round(workAreaSize.width * 0.420);
    const H = Math.round(workAreaSize.height * 0.605);
    workspaceWin = new BrowserWindow({
        width: W, height: H,
        x: workAreaSize.width - W,
        y: workAreaSize.height - H,
        transparent: true, frame: false, backgroundColor: '#00000000',
        alwaysOnTop: true, resizable: true, show: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false },
        icon: logoPath,
    });
    if (isDev) workspaceWin.loadURL('http://localhost:5174');
    else workspaceWin.loadFile(path.join(import.meta.dirname, '../dist/index.html'));
    workspaceWin.on('close', (e) => {
        if (!app.isQuitting) { e.preventDefault(); workspaceWin.hide(); }
    });
    workspaceWin.on('closed', () => { workspaceWin = null; });

    // タイトルバードラッグ中はワークスペースをホバー扱いにする
    let workspaceDragEndTimer = null;
    workspaceWin.on('move', () => {
        if (workspaceWin && !workspaceWin.isDestroyed()) {
            workspaceWin.webContents.send('workspace-dragging', true);
            clearTimeout(workspaceDragEndTimer);
            workspaceDragEndTimer = setTimeout(() => {
                if (workspaceWin && !workspaceWin.isDestroyed()) {
                    workspaceWin.webContents.send('workspace-dragging', false);
                }
            }, 300);
        }
    });
}

let menuCurrentX = 0;
let menuCurrentY = 0;
let isMenuDragging = false;
let menuExpanded = false;
let menuGlobalPoll;

function startMenuPolling() {
    clearInterval(menuGlobalPoll);
    menuGlobalPoll = setInterval(() => {
        if (!menuWin || menuWin.isDestroyed() || !menuWin.isVisible()) return;
        if (isMenuDragging) return;

        const pt = screen.getCursorScreenPoint();
        const bounds = menuWin.getBounds();

        if (!menuExpanded) {
            // Hover tab trigger: Center 60px wide, from top edge to 10px down
            const tabXLeft = bounds.x + (bounds.width / 2) - 30;
            const tabXRight = Math.round(bounds.x + (bounds.width / 2) + 30);
            if (pt.x >= tabXLeft && pt.x <= tabXRight && pt.y >= bounds.y && pt.y <= bounds.y + 10) {
                menuExpanded = true;
                menuWin.setIgnoreMouseEvents(false);
                menuWin.webContents.send('set-expanded', true);
            }
        } else {
            // Hover exit trigger: outside the menu bounds (with a tiny 2px tolerance)
            if (pt.x < bounds.x - 2 || pt.x > bounds.x + bounds.width + 2 || pt.y < bounds.y - 2 || pt.y > bounds.y + bounds.height + 2) {
                menuExpanded = false;
                menuWin.setIgnoreMouseEvents(true); // purely ignore clicks now, no 'forward' needed!
                menuWin.webContents.send('set-expanded', false);
            }
        }
    }, 50);
}

function createMenuWindow() {
    const { workAreaSize, bounds } = screen.getPrimaryDisplay();
    const MENU_W = 256, MENU_H = 46;
    menuCurrentX = bounds.x + workAreaSize.width - MENU_W;
    menuCurrentY = bounds.y;

    menuWin = new BrowserWindow({
        width: MENU_W, height: MENU_H,
        x: menuCurrentX,
        y: menuCurrentY, // ALWAYS KEEP ON SCREEN NATIVELY!
        transparent: true, frame: false, backgroundColor: '#00000000',
        alwaysOnTop: true, resizable: false, skipTaskbar: true, movable: false,
        webPreferences: { nodeIntegration: true, contextIsolation: false },
        icon: logoPath,
    });
    menuWin.setAlwaysOnTop(true, 'screen-saver');
    if (isDev) menuWin.loadURL('http://localhost:5174/menu.html');
    else menuWin.loadFile(path.join(import.meta.dirname, '../dist/menu.html'));
    menuWin.webContents.once('did-finish-load', () => {
        menuWin.setIgnoreMouseEvents(true); // START IGNORING
        startMenuPolling();
    });
    menuWin.on('closed', () => { menuWin = null; });
}

function setupTray() {
    const icon = fs.existsSync(logoPath) ? logoPath : null;
    tray = new Tray(icon
        ? nativeImage.createFromPath(logoPath).resize({ width: 16, height: 16 })
        : nativeImage.createEmpty()
    );
    tray.setToolTip('MOZ-3 Quick Shot');
    const ctxMenu = Menu.buildFromTemplate([
        { label: 'ワークスペースを表示', click: () => { workspaceWin?.show(); workspaceWin?.webContents.send('start-visibility-timer'); } },
        { label: 'スクショメニューを表示', click: () => menuWin?.show() },
        { type: 'separator' },
        { label: '終了', click: () => { app.isQuitting = true; app.quit(); } },
    ]);
    tray.setContextMenu(ctxMenu);
    tray.on('click', () => {
        if (workspaceWin?.isVisible()) workspaceWin.hide();
        else { workspaceWin?.show(); workspaceWin?.webContents.send('start-visibility-timer'); }
    });
}

// ── Capture Pool ──────────────────────────────────────────────────
function initCaptureWinsPool() {
    captureWinsPool.forEach(p => { if (p.win && !p.win.isDestroyed()) p.win.close(); });
    captureWinsPool = [];

    const displays = screen.getAllDisplays();
    displays.forEach(d => {
        const win = new BrowserWindow({
            x: d.bounds.x, y: d.bounds.y,
            width: d.bounds.width, height: d.bounds.height,
            backgroundColor: '#000000', transparent: false,
            frame: false, alwaysOnTop: true, show: false,
            skipTaskbar: true, resizable: false, movable: false,
            enableLargerThanScreen: true,
            type: 'toolbar',
            webPreferences: { nodeIntegration: true, contextIsolation: false },
        });
        win.setBounds(d.bounds);

        if (isDev) win.loadURL('http://localhost:5174/capture.html');
        else win.loadFile(path.join(import.meta.dirname, '../dist/capture.html'));

        captureWinsPool.push({
            win,
            display_id: d.id.toString(),
            bounds: d.bounds
        });
    });
}

// ── Capture ───────────────────────────────────────────────────
async function startCapture() {
    try {
        if (isCapturing) return;
        isCapturing = true;

        // UIを隠してから画面フリーズまで最低限だけ待機
        if (workspaceWin?.isVisible()) workspaceWin.hide();
        if (menuWin) menuWin.hide();
        await new Promise(r => setTimeout(r, 40));

        // 常駐型ワーカーがいない場合は起動
        if (!psWorker) await initCaptureWorker();

        // 待機キューにPromiseのResolveを登録し、Workerに命令を送信
        const imagePaths = await new Promise((resolve) => {
            captureResolveQueue.push(resolve);
            psWorker.stdin.write("CAPTURE\r\n");
        });

        const displays = screen.getAllDisplays();

        globalFrozenSources = imagePaths.map((item) => {
            const parts = item.split('::');
            const file = parts[0];
            if (!file || !fs.existsSync(file)) return null;

            let physicalBounds = null;
            if (parts[1]) {
                const [px, py, pw, ph] = parts[1].split(',').map(Number);
                physicalBounds = { x: px, y: py, width: pw, height: ph };
            }

            const buf = fs.readFileSync(file);
            return {
                physicalBounds,
                thumbnail: nativeImage.createFromBuffer(buf)
            };
        }).filter(Boolean);

        if (!globalFrozenSources || globalFrozenSources.length === 0) {
            isCapturing = false;
            if (menuWin) menuWin.show();
            return;
        }

        const currentDisplays = screen.getAllDisplays();
        if (currentDisplays.length !== captureWinsPool.length) {
            initCaptureWinsPool();
            await new Promise(r => setTimeout(r, 500)); // 再構築時のロード待ち
        }

        globalFrozenSources.forEach((source) => {
            let matchedDisplay = currentDisplays[0];
            if (source.physicalBounds) {
                let bestDist = Infinity;
                const pCenterX = source.physicalBounds.x + source.physicalBounds.width / 2;
                const pCenterY = source.physicalBounds.y + source.physicalBounds.height / 2;

                for (const d of displays) {
                    const eCenterX = (d.bounds.x * d.scaleFactor) + (d.bounds.width * d.scaleFactor) / 2;
                    const eCenterY = (d.bounds.y * d.scaleFactor) + (d.bounds.height * d.scaleFactor) / 2;
                    const dist = Math.hypot(pCenterX - eCenterX, pCenterY - eCenterY);
                    if (dist < bestDist) {
                        bestDist = dist;
                        matchedDisplay = d;
                    }
                }
            }
            source.display_id = matchedDisplay.id.toString();

            const poolItem = captureWinsPool.find(p => p.display_id === source.display_id) || captureWinsPool[0];
            if (poolItem && poolItem.win && !poolItem.win.isDestroyed()) {
                poolItem.win.webContents.send('capture-init-single', {
                    imgDataUrl: source.thumbnail.toDataURL(),
                    scaleFactor: matchedDisplay.scaleFactor
                });
            }
        });
    } catch (e) {
        isCapturing = false;
        dialog.showErrorBox('Quick Shot Capture Error', `キャプチャ起動時にエラーが発生しました。\n${e.message}\n${e.stack}`);
        if (menuWin) menuWin.show();
    }
}

// ── リピートキャプチャ（前回と同じ範囲を即座に撮影） ──────────────
async function repeatCapture() {
    if (isCapturing) return;

    if (!lastCaptureBounds) {
        new Notification({
            title: 'MOZ-3 Quick Shot',
            body: '前回のキャプチャ履歴がありません',
        }).show();
        return;
    }

    isCapturing = true;
    try {
        if (workspaceWin?.isVisible()) workspaceWin.hide();
        if (menuWin) menuWin.hide();
        await new Promise(r => setTimeout(r, 40));

        if (!psWorker) await initCaptureWorker();

        // 最新の画面を取得
        const imagePaths = await new Promise((resolve) => {
            captureResolveQueue.push(resolve);
            psWorker.stdin.write("CAPTURE\r\n");
        });

        const displays = screen.getAllDisplays();

        // startCapture と同じ方法でソースを構築し display_id を割り当てる
        const sources = imagePaths.map((item) => {
            const parts = item.split('::');
            const file = parts[0];
            if (!file || !fs.existsSync(file)) return null;
            let physicalBounds = null;
            if (parts[1]) {
                const [px, py, pw, ph] = parts[1].split(',').map(Number);
                physicalBounds = { x: px, y: py, width: pw, height: ph };
            }
            const buf = fs.readFileSync(file);
            return { physicalBounds, thumbnail: nativeImage.createFromBuffer(buf) };
        }).filter(Boolean);

        if (!sources || sources.length === 0) return;

        sources.forEach((source) => {
            let matchedDisplay = displays[0];
            if (source.physicalBounds) {
                let bestDist = Infinity;
                const pCenterX = source.physicalBounds.x + source.physicalBounds.width / 2;
                const pCenterY = source.physicalBounds.y + source.physicalBounds.height / 2;
                for (const d of displays) {
                    const eCenterX = (d.bounds.x * d.scaleFactor) + (d.bounds.width * d.scaleFactor) / 2;
                    const eCenterY = (d.bounds.y * d.scaleFactor) + (d.bounds.height * d.scaleFactor) / 2;
                    const dist = Math.hypot(pCenterX - eCenterX, pCenterY - eCenterY);
                    if (dist < bestDist) { bestDist = dist; matchedDisplay = d; }
                }
            }
            source.display_id = matchedDisplay.id.toString();
        });

        const { cropX, cropY, cropW, cropH, display_id } = lastCaptureBounds;
        const matchedSource = sources.find(s => s.display_id === display_id) || sources[0];

        // ディスプレイ解像度変更に備えてクロップ座標をクランプ
        const srcSize = matchedSource.thumbnail.getSize();
        const safeX = Math.max(0, Math.min(cropX, srcSize.width - 1));
        const safeY = Math.max(0, Math.min(cropY, srcSize.height - 1));
        const safeW = Math.max(1, Math.min(cropW, srcSize.width - safeX));
        const safeH = Math.max(1, Math.min(cropH, srcSize.height - safeY));

        const croppedImg = matchedSource.thumbnail.crop({ x: safeX, y: safeY, width: safeW, height: safeH });
        const b64 = croppedImg.toPNG().toString('base64');

        await saveCapture(b64);
        notifyAfterCapture();
    } catch (e) {
        console.error('Repeat capture error:', e);
        if (menuWin) menuWin.show();
    } finally {
        isCapturing = false;
    }
}

function generateTimestampId() {
    const d = new Date();
    const pad = (n) => n.toString().padStart(2, '0');
    return `qs_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function saveCapture(base64Data, originalId = null) {
    const meta = loadMeta();
    let newId;

    if (originalId) {
        const origShot = meta.screenshots.find(s => s.id === originalId);
        if (origShot) {
            const baseMatch = origShot.id.match(/^qs_\d{14}/);
            const baseStr = baseMatch ? baseMatch[0] : `qs_${Date.now()}`;
            const editCount = meta.screenshots.filter(s => s.id.startsWith(baseStr + '_edit')).length;
            newId = `${baseStr}_edit${editCount + 1}`;
        } else {
            newId = generateTimestampId();
        }
    } else {
        newId = generateTimestampId();
        // 重複回避
        if (meta.screenshots.some(s => s.id === newId)) {
            newId = newId + '_' + Date.now().toString().slice(-3);
        }
    }

    const filename = `${newId}.png`;
    fs.writeFileSync(path.join(getDataDir(), filename), Buffer.from(base64Data, 'base64'));
    meta.screenshots.push({ id: newId, filename, timestamp: Date.now(), locked: false });
    saveMeta(meta);
    cleanupScreenshots();
    return newId;
}

function notifyAfterCapture() {
    const meta = loadMeta();
    if (workspaceWin) {
        workspaceWin.show();
        workspaceWin.webContents.send('screenshot-added', meta.screenshots);
        workspaceWin.webContents.send('start-visibility-timer');
    }
    if (menuWin) {
        menuWin.show();
        menuWin.webContents.send('update-count', meta.screenshots.length);
    }
}

// ── Single instance lock ───────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (workspaceWin) {
            if (workspaceWin.isMinimized()) workspaceWin.restore();
            workspaceWin.focus();
        }
    });
}

// ── App ready ─────────────────────────────────────────────────
app.whenReady().then(() => {
    // 初回起動時は自動起動をデフォルトでONにする
    const cfg = loadConfig();
    if (cfg.autoStartInitialized === undefined) {
        app.setLoginItemSettings({ openAtLogin: true });
        cfg.autoStartInitialized = true;
        saveConfig(cfg);
    }

    initCaptureWorker(); // 起動時に常駐型ワーカーをコンパイル＆初期化
    initCaptureWinsPool(); // プールされたキャプチャウィンドウを生成

    screen.on('display-added', initCaptureWinsPool);
    screen.on('display-removed', initCaptureWinsPool);
    screen.on('display-metrics-changed', initCaptureWinsPool);

    syncMetaWithFolder(); // 初回起動時にフォルダ内の画像と同期する

    createWorkspaceWindow();
    createMenuWindow();
    setupTray();
    startFolderWatcher();
    registerGlobalShortcuts();

    // ── IPC: Capture ──
    ipcMain.on('start-capture', startCapture);

    ipcMain.on('capture-area', async (event, { x, y, w, h, scaleFactor }) => {
        captureWinsPool.forEach(p => { if (!p.win.isDestroyed()) p.win.hide(); });
        await new Promise(r => setTimeout(r, 150));

        try {
            const senderWin = BrowserWindow.fromWebContents(event.sender);
            if (!senderWin) return;

            const targetPool = captureWinsPool.find(p => p.win === senderWin);
            if (!targetPool) throw new Error("Sender win not found in pool.");
            const matchedSource = globalFrozenSources.find(s => s.display_id === targetPool.display_id) || globalFrozenSources[0];

            if (!matchedSource) throw new Error("No frozen capture source found.");

            // x, yは送信元ウィンドウの左上からのローカル座標
            const cropX = Math.round(x * scaleFactor);
            const cropY = Math.round(y * scaleFactor);
            const cropW = Math.round(w * scaleFactor);
            const cropH = Math.round(h * scaleFactor);

            const croppedImg = matchedSource.thumbnail.crop({ x: cropX, y: cropY, width: cropW, height: cropH });
            const b64 = croppedImg.toPNG().toString('base64');

            // 前回キャプチャ座標を記憶（リピートキャプチャで使用）
            lastCaptureBounds = { cropX, cropY, cropW, cropH, display_id: targetPool.display_id };

            await saveCapture(b64);
            notifyAfterCapture();
        } catch (e) {
            console.error('Crop error:', e);
        } finally {
            isCapturing = false;
            globalFrozenSources = null; // メモリ解放
            captureWinsPool.forEach(p => { if (!p.win.isDestroyed()) p.win.webContents.send('capture-reset'); });
        }
    });

    ipcMain.on('cancel-capture', () => {
        isCapturing = false;
        globalFrozenSources = null; // メモリ解放
        captureWinsPool.forEach(p => {
            if (!p.win.isDestroyed()) {
                p.win.hide();
                p.win.webContents.send('capture-reset');
            }
        });
        if (menuWin) menuWin.show();
    });

    ipcMain.on('capture-show', (event) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) {
            win.show();
            win.setAlwaysOnTop(true, 'screen-saver');
        }
    });

    // ── IPC: Storage ──
    ipcMain.handle('get-screenshots', () => {
        // ロード時に実体のないレコードを除外してゴーストを防ぐ
        const meta = loadMeta();
        const dir  = getDataDir();
        const live  = meta.screenshots.filter(s => fs.existsSync(path.join(dir, s.filename)));
        if (live.length !== meta.screenshots.length) {
            meta.screenshots = live;
            saveMeta(meta);
        }
        return live;
    });

    ipcMain.handle('save-ai-shot', async (_, { base64Data, originalId }) => {
        return await saveCapture(base64Data, originalId);
    });

    ipcMain.handle('get-thumbnail', (_, id) => {
        const meta = loadMeta();
        const shot = meta.screenshots.find(s => s.id === id);
        if (!shot) return null;
        const fp = path.join(getDataDir(), shot.filename);
        if (!fs.existsSync(fp)) return null;
        try {
            const img = nativeImage.createFromPath(fp);
            const size = img.getSize();
            const thumbW = 240;
            const thumbH = Math.round(thumbW / (size.width / size.height));
            const b64 = img.resize({ width: thumbW, height: thumbH, quality: 'better' }).toPNG().toString('base64');
            return { b64, w: size.width, h: size.height };
        } catch { return null; }
    });

    ipcMain.handle('get-full-image', (_, id) => {
        const meta = loadMeta();
        const shot = meta.screenshots.find(s => s.id === id);
        if (!shot) return null;
        const fp = path.join(getDataDir(), shot.filename);
        return fs.existsSync(fp) ? fs.readFileSync(fp).toString('base64') : null;
    });

    ipcMain.handle('remove-background', async (_, base64Data) => {
        try {
            // resolve @imgly dist path inside app.asar safely since package.json isn't exported
            const distPath = path.join(path.dirname(require.resolve('@imgly/background-removal-node')), '../dist/');
            const localPublicPath = url.pathToFileURL(distPath).href + '/'; // ensure trailing slash

            const buffer = Buffer.from(base64Data, 'base64');
            const blobInput = new Blob([buffer], { type: 'image/png' });

            const blobOutput = await removeBackground(blobInput, {
                debug: false,
                publicPath: localPublicPath,
                progress: (key, current, total) => {
                    console.log(`[Main] Loading model ${key}: ${current}/${total}`);
                }
            });
            const arrayBuffer = await blobOutput.arrayBuffer();
            return Buffer.from(arrayBuffer).toString('base64');
        } catch (err) {
            console.error('BG Removal Node Error:', err);
            throw err;
        }
    });

    ipcMain.handle('toggle-lock', (_, id) => {
        const meta = loadMeta();
        const shot = meta.screenshots.find(s => s.id === id);
        if (!shot) return { ok: false };
        const lockedCount = meta.screenshots.filter(s => s.locked).length;
        if (!shot.locked && lockedCount >= 9) return { ok: false, reason: 'max9' };
        shot.locked = !shot.locked;
        saveMeta(meta);
        return { ok: true, locked: shot.locked };
    });

    ipcMain.handle('delete-screenshot', (_, id) => {
        const meta = loadMeta();
        const shot = meta.screenshots.find(s => s.id === id);
        // shot が meta にない場合も「削除済み」として成功扱い（冪等性）
        if (shot) {
            const fp = path.join(getDataDir(), shot.filename);
            try {
                fs.unlinkSync(fp);
            } catch (err) {
                if (err.code !== 'ENOENT') throw err; // ENOENT 以外は本物のエラー
                // ENOENT = すでにファイルが存在しない → 削除成功扱い
            }
            meta.screenshots = meta.screenshots.filter(s => s.id !== id);
            saveMeta(meta);
            if (menuWin && !menuWin.isDestroyed()) {
                menuWin.webContents.send('update-count', meta.screenshots.length);
            }
        }
        return true;
    });

    ipcMain.handle('save-edited', async (_, { base64Data, originalId }) => {
        return await saveCapture(base64Data, originalId);
    });

    // ── IPC: Shortcut lock (テキスト入力中にグローバルショートカットを無効化) ──
    ipcMain.handle('shortcut-lock',   () => { globalShortcut.unregisterAll(); });
    ipcMain.handle('shortcut-unlock', () => { registerGlobalShortcuts(); });

    // ── IPC: System fonts ──
    ipcMain.handle('get-system-fonts', async () => {
        try {
            const { stdout } = await execPromise(
                'powershell -NoProfile -Command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; [System.Reflection.Assembly]::LoadWithPartialName(\'System.Drawing\') | Out-Null; [System.Drawing.FontFamily]::Families | Select-Object -ExpandProperty Name | Sort-Object"',
                { timeout: 8000, encoding: 'utf8' }
            );
            const fonts = stdout.trim().split('\n').map(f => f.trim()).filter(Boolean);
            return { ok: true, fonts };
        } catch (err) {
            return { ok: false, fonts: [] };
        }
    });

    // ── IPC: Settings ──
    ipcMain.handle('get-config', () => loadConfig());

    ipcMain.handle('set-keep-ai-open', (_, enabled) => {
        const cfg = loadConfig();
        cfg.keepAiOpen = !!enabled;
        saveConfig(cfg);
        return true;
    });

    ipcMain.handle('set-language', (_, language) => {
        const cfg = loadConfig();
        cfg.language = language;
        saveConfig(cfg);
        // 全ウィンドウに言語変更を通知
        if (workspaceWin && !workspaceWin.isDestroyed()) {
            workspaceWin.webContents.send('language-changed', language);
        }
        if (menuWin && !menuWin.isDestroyed()) {
            menuWin.webContents.send('language-changed', language);
        }
        return true;
    });

    ipcMain.on('open-external', (_, url) => {
        shell.openExternal(url);
    });

    ipcMain.handle('show-confirm-dialog', async (_, options) => {
        const result = await dialog.showMessageBox(workspaceWin || null, {
            type: 'question',
            buttons: ['はい', 'いいえ'],
            defaultId: 1,
            title: options.title || '確認',
            message: options.message,
            detail: options.detail || ''
        });
        return result.response === 0; // 0 is 'はい'
    });

    ipcMain.handle('select-folder', async () => {
        const result = await dialog.showOpenDialog({
            properties: ['openDirectory'],
            title: '保存先のフォルダを選択'
        });
        if (!result.canceled && result.filePaths.length > 0) {
            return result.filePaths[0];
        }
        return null;
    });

    ipcMain.handle('delete-all-images', () => {
        const dir = getDataDir();
        const exts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp']);
        let deleted = 0;
        try {
            const files = fs.readdirSync(dir);
            for (const file of files) {
                if (exts.has(path.extname(file).toLowerCase())) {
                    try {
                        fs.unlinkSync(path.join(dir, file));
                        deleted++;
                    } catch { /* skip locked files */ }
                }
            }
        } catch { /* dir not accessible */ }
        // メタデータをリセットして UI を更新
        const meta = loadMeta();
        meta.screenshots = [];
        saveMeta(meta);
        const count = 0;
        if (menuWin && !menuWin.isDestroyed()) menuWin.webContents.send('update-count', count);
        if (workspaceWin && !workspaceWin.isDestroyed()) workspaceWin.webContents.send('reload-workspace');
        return { deleted };
    });

    ipcMain.handle('set-custom-path', (_, newPath) => {
        const cfg = loadConfig();
        const pathChanged = cfg.customSavePath !== (newPath || null);
        
        cfg.customSavePath = newPath || null;
        saveConfig(cfg);

        // フォルダが変更された場合、監視を再起動して同期を走らせる
        if (pathChanged) {
            // 既存の watcher を停止して再起動する仕組み
            if (folderWatcher) {
                folderWatcher.close();
                folderWatcher = null;
            }
            
            // 新しいフォルダと同期する (完全リセットではなくフォルダの実体に基づく)
            syncMetaWithFolder();

            // syncMetaWithFolder は変更がない場合は通知しないため、
            // パス切り替え時は必ず最新のカウントとワークスペースを通知する
            const latestCount = loadMeta().screenshots.length;
            if (menuWin && !menuWin.isDestroyed()) {
                menuWin.webContents.send('update-count', latestCount);
                const isCustom = !!(cfg.customSavePath && fs.existsSync(cfg.customSavePath));
                menuWin.webContents.send('update-is-custom-folder', isCustom);
            }
            if (workspaceWin && !workspaceWin.isDestroyed()) {
                workspaceWin.webContents.send('reload-workspace');
            }

            startFolderWatcher(); // 新しいパスで監視再開
        }

        return true;
    });

    ipcMain.handle('set-hotkey', (_, { action, accelerator }) => {
        const cfg = loadConfig();
        cfg.hotkeys[action] = accelerator;
        saveConfig(cfg);
        registerGlobalShortcuts(); // 動的にショートカットをリバインド
        return true;
    });

    // ── IPC: Menu mouse ──
    ipcMain.on('menu-enable-mouse', () => menuWin?.setIgnoreMouseEvents(false));
    ipcMain.on('menu-disable-mouse', () => menuWin?.setIgnoreMouseEvents(true, { forward: true }));

    // ── IPC: UI ──
    ipcMain.on('open-screenshots-folder', () => shell.openPath(getDataDir()));

    ipcMain.on('show-workspace', (event, delayed = false) => {
        workspaceWin?.show();
        workspaceWin?.webContents.send('start-visibility-timer', delayed);
        workspaceWin?.webContents.send('workspace-shown');
    });

    ipcMain.on('set-is-dragging', (event, isDragging) => {
        if (workspaceWin) workspaceWin.isDragging = isDragging;
    });

    ipcMain.on('hide-workspace', () => {
        // Prevent hiding while drag-and-drop is active
        if (!workspaceWin?.isDragging) {
            workspaceWin?.hide();
        }
    });

    let menuDragInterval;
    let menuDragOffsetX = 0;

    ipcMain.on('menu-drag-start', () => {
        if (!menuWin) return;
        isMenuDragging = true;
        const pt = screen.getCursorScreenPoint();
        const bounds = menuWin.getBounds();
        menuDragOffsetX = pt.x - bounds.x;

        clearInterval(menuDragInterval);
        menuDragInterval = setInterval(() => {
            if (!menuWin || menuWin.isDestroyed()) {
                clearInterval(menuDragInterval); return;
            }
            const currentPt = screen.getCursorScreenPoint();
            const { bounds: displayBounds } = screen.getDisplayNearestPoint(currentPt);

            let newX = currentPt.x - menuDragOffsetX;
            // はみ出し防止 (マルチモニタ考慮で現在のディスプレイ範囲内に収める)
            if (newX < displayBounds.x) newX = displayBounds.x;
            if (newX + bounds.width > displayBounds.x + displayBounds.width) {
                newX = displayBounds.x + displayBounds.width - bounds.width;
            }

            menuCurrentX = newX;
            menuCurrentY = displayBounds.y;
            menuWin.setBounds({
                x: newX,
                y: menuCurrentY,
                width: 256,
                height: 46
            }); // ドラッグ中はバウンディングボックスを強制再計算
        }, 16);
    });

    ipcMain.on('menu-drag-stop', () => {
        isMenuDragging = false;
        clearInterval(menuDragInterval);
        if (menuWin && !menuWin.isDestroyed()) {
            menuWin.setAlwaysOnTop(true, 'screen-saver'); // DWMのカリングでZ-Indexが落ちるバグの対策
        }
    });

    // ── IPC: Drag file ──
    ipcMain.on('start-drag', (event, id) => {
        const meta = loadMeta();
        const shot = meta.screenshots.find(s => s.id === id);
        if (!shot) return;
        const fp = path.join(getDataDir(), shot.filename);
        if (!fs.existsSync(fp)) {
            dialog.showErrorBox('Drag Error', 'スクショファイルが見つかりません: ' + fp);
            return;
        }

        try {
            let dragIcon;
            if (fs.existsSync(fp)) {
                // Resizeによるラグを防ぐため、元の画像を読み込んで小さめのサムネイルアイコンとして使う
                dragIcon = nativeImage.createFromPath(fp).resize({ width: 140, quality: 'good' });
            }
            if (!dragIcon || dragIcon.isEmpty()) {
                dragIcon = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=');
            }

            event.sender.startDrag({ file: fp, icon: dragIcon });
        } catch (e) {
            dialog.showErrorBox('Drag Exception', e.message);
            console.error('drag error', e);
        }
    });

    let originalWorkspaceBounds = null;

    ipcMain.on('resize-workspace', (event, { imgW, imgH }) => {
        if (!workspaceWin) return;
        if (!originalWorkspaceBounds) originalWorkspaceBounds = workspaceWin.getBounds();

        const { workAreaSize } = screen.getPrimaryDisplay();
        const MAX_W = workAreaSize.width - 20;
        const MAX_H = workAreaSize.height - 20;

        let targetW = imgW + 100; // 余白
        let targetH = imgH + 100;

        if (targetW > originalWorkspaceBounds.width || targetH > originalWorkspaceBounds.height) {
            targetW = Math.min(targetW, MAX_W);
            targetH = Math.min(targetH, MAX_H);

            const curBounds = workspaceWin.getBounds();
            // 右下固定ではなく、画面中央寄せ方向へ広げるか、右下に原点を保つか。ここでは中央固定拡大。
            const newX = Math.round(curBounds.x + curBounds.width / 2 - targetW / 2);
            const newY = Math.round(curBounds.y + curBounds.height / 2 - targetH / 2);

            workspaceWin.setBounds({
                x: Math.max(10, newX),
                y: Math.max(10, newY),
                width: targetW,
                height: targetH
            }, true);
        }
    });

    ipcMain.on('restore-workspace', () => {
        if (!workspaceWin || !originalWorkspaceBounds) return;
        workspaceWin.setBounds(originalWorkspaceBounds, true);
        originalWorkspaceBounds = null;
    });

    ipcMain.on('window-control', (event, command) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (!win) return;
        if (command === 'minimize') win.minimize();
        if (command === 'close') {
            if (win === workspaceWin) {
                // ×ボタン: 終了確認ダイアログをレンダラーで表示
                workspaceWin.webContents.send('request-quit-confirm');
            } else {
                win.close();
            }
        }
    });

    ipcMain.on('confirm-quit', () => {
        app.isQuitting = true;
        app.quit();
    });

    ipcMain.handle('get-screenshot-count', () => loadMeta().screenshots.length);
    ipcMain.handle('get-is-custom-folder', () => {
        const cfg = loadConfig();
        return !!(cfg.customSavePath && fs.existsSync(cfg.customSavePath));
    });

    // ── IPC: Login Item (自動起動) ──
    ipcMain.handle('get-login-item', () => {
        return app.getLoginItemSettings().openAtLogin;
    });

    ipcMain.handle('set-login-item', (_, enabled) => {
        app.setLoginItemSettings({ openAtLogin: enabled });
        return true;
    });

    // ── IPC: AI Worker ──
    ipcMain.handle('ai-status', async () => {
        try {
            const result = await sendAIRequest({ action: 'status' });
            return { ok: true, providers: result.providers };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    ipcMain.handle('ai-model-ready', () => {
        // モデルはインストーラーに同梱済みのため常に true を返す
        return true;
    });

    // U2-Net 背景透過
    // JS 側でプレクロップ済みの base64 を受け取り、C# Worker (removebg) に渡す
    ipcMain.handle('ai-removebg', async (_, { base64Data, target }) => {
        const tmpDir     = app.getPath('temp');
        const ts         = Date.now();
        const inputPath  = path.join(tmpDir, `qs_bg_in_${ts}.png`);
        const outputPath = path.join(tmpDir, `qs_bg_out_${ts}.png`);
        try {
            fs.writeFileSync(inputPath, Buffer.from(base64Data, 'base64'));
            if (!aiWorker) initAIWorker();
            const result = await sendAIRequest({
                action: 'removebg',
                imagePath: inputPath,
                outputPath,
                target: target ?? 'complex',
            });
            const outB64 = fs.readFileSync(outputPath).toString('base64');
            return { ok: true, base64Data: outB64, processingMs: result.processingMs };
        } catch (e) {
            return { ok: false, error: e.message };
        } finally {
            try { fs.unlinkSync(inputPath);  } catch {}
            try { fs.unlinkSync(outputPath); } catch {}
        }
    });

    // SR アップスケール（Lanczos3 + GaussianSharpen、モデル不要）
    ipcMain.handle('ai-sr-upscale', async (_, { base64Data, scale }) => {
        const tmpDir     = app.getPath('temp');
        const ts         = Date.now();
        const inputPath  = path.join(tmpDir, `qs_up_in_${ts}.png`);
        const outputPath = path.join(tmpDir, `qs_up_out_${ts}.png`);
        try {
            fs.writeFileSync(inputPath, Buffer.from(base64Data, 'base64'));
            if (!aiWorker) initAIWorker();
            const result = await sendAIRequest({
                action:     'sr-upscale',
                imagePath:  inputPath,
                outputPath,
                scale:      scale ?? 2,
            });
            const outB64 = fs.readFileSync(outputPath).toString('base64');
            return { ok: true, base64Data: outB64, processingMs: result.processingMs };
        } catch (e) {
            return { ok: false, error: e.message };
        } finally {
            try { fs.unlinkSync(inputPath);  } catch {}
            try { fs.unlinkSync(outputPath); } catch {}
        }
    });

    // Refine 開始: original + current を同じ内容で temp ファイルとして保存
    ipcMain.handle('ai-refine-start', async (_, { base64Data }) => {
        const tmpDir = app.getPath('temp');
        const ts = Date.now();
        const originalPath = path.join(tmpDir, `qs_refine_orig_${ts}.png`);
        const currentPath  = path.join(tmpDir, `qs_refine_curr_${ts}.png`);
        try {
            const buf = Buffer.from(base64Data, 'base64');
            fs.writeFileSync(originalPath, buf);
            fs.writeFileSync(currentPath,  buf);
            refineActivePaths.add(originalPath);
            refineActivePaths.add(currentPath);
            return { ok: true, originalPath, currentPath };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    // Refine クリック: BFS FloodFill を実行し、新しい画像パスと base64 を返す
    // Note: outputPath は削除しない — refineHistory の undo スタックで参照される
    ipcMain.handle('ai-refine', async (_, { originalPath, currentPath, x, y, mode, tolerance }) => {
        const tmpDir = app.getPath('temp');
        const ts = Date.now();
        const outputPath = path.join(tmpDir, `qs_refine_out_${ts}.png`);
        try {
            if (!aiWorker) initAIWorker();
            const result = await sendAIRequest({
                action:       'refine',
                originalPath,
                currentPath,
                outputPath,
                x,
                y,
                mode,
                tolerance:    tolerance ?? 30,
            });
            refineActivePaths.add(outputPath);
            const outB64 = fs.readFileSync(outputPath).toString('base64');
            return { ok: true, base64Data: outB64, newPath: outputPath, processingMs: result.processingMs };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    });

    // Refine クリーンアップ: 指定 temp ファイルを物理削除
    ipcMain.handle('ai-refine-cleanup', (_, { paths }) => {
        if (!Array.isArray(paths)) return;
        for (const p of paths) {
            refineActivePaths.delete(p);
            try {
                if (fs.existsSync(p)) fs.unlinkSync(p);
            } catch (err) {
                console.warn('[Refine] Failed to delete temp file:', p, err.message);
            }
        }
    });

    // 白枠ステッカー（C# WhiteBorderEngine: Dilation + Gaussian + AA 合成）
    // origBase64Data が渡された場合は C# 側で Parallel.For エッジカラーサンプリングを実行（元絵モード）
    ipcMain.handle('ai-white-border', async (_, { base64Data, borderR = 255, borderG = 255, borderB = 255, origBase64Data = null }) => {
        const tmpDir     = app.getPath('temp');
        const ts         = Date.now();
        const inputPath  = path.join(tmpDir, `qs_wb_in_${ts}.png`);
        const outputPath = path.join(tmpDir, `qs_wb_out_${ts}.png`);
        const origPath   = origBase64Data ? path.join(tmpDir, `qs_wb_orig_${ts}.png`) : null;
        try {
            fs.writeFileSync(inputPath, Buffer.from(base64Data, 'base64'));
            if (origPath) fs.writeFileSync(origPath, Buffer.from(origBase64Data, 'base64'));
            if (!aiWorker) initAIWorker();
            const result = await sendAIRequest({
                action: 'white-border', imagePath: inputPath, outputPath,
                borderR, borderG, borderB,
                ...(origPath ? { origPath } : {}),
            });
            if (!result.success) return { ok: false, error: result.error };
            const outB64 = fs.readFileSync(outputPath).toString('base64');
            return { ok: true, base64Data: outB64, processingMs: result.processingMs };
        } catch (e) {
            return { ok: false, error: e.message };
        } finally {
            try { fs.unlinkSync(inputPath);  } catch {}
            try { fs.unlinkSync(outputPath); } catch {}
            if (origPath) try { fs.unlinkSync(origPath); } catch {}
        }
    });

    app.on('activate', () => { if (!workspaceWin) createWorkspaceWindow(); });
});

app.on('window-all-closed', () => {
    // Do NOT quit — stay in tray
});

app.on('before-quit', () => {
    app.isQuitting = true;
    // アプリ終了時に残存 refine temp ファイルを全削除
    for (const p of refineActivePaths) {
        try {
            if (fs.existsSync(p)) fs.unlinkSync(p);
        } catch (err) {
            console.warn('[Refine] Failed to delete temp file on quit:', p, err.message);
        }
    }
    refineActivePaths.clear();
});
