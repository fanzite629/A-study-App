'use strict';
// Electron main process: windows, tray, platform events, and wiring between
// the Core (data + timer), the character pack loader, and the two windows.

const {
  app, BrowserWindow, Tray, Menu, screen, ipcMain, powerMonitor, Notification,
  nativeImage, dialog, shell, protocol, net, clipboard, safeStorage,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');

const geo = require('../shared/geometry');
const { readJson, readState, writeJsonAtomic } = require('./persist');
const { Core, petView } = require('./core');
const { loadPack, listPacks } = require('./packs');
const { Profiles } = require('./ai/profiles');
const { Chats } = require('./ai/chats');
const { ChatService } = require('./ai/service');

// ------------------------------------------------------------------ startup

const ARGV = process.argv.slice(app.isPackaged ? 1 : 2);
const flag = (f) => ARGV.includes(f);
const flagValue = (f) => { const a = ARGV.find((x) => x.startsWith(f + '=')); return a ? a.slice(f.length + 1) : null; };

if (flag('--no-gpu')) app.disableHardwareAcceleration();
// Self-test runs use a throwaway data folder so they can never touch real records.
app.setPath('userData', flagValue('--test-data') || (flagValue('--selftest')
  ? path.resolve(flagValue('--selftest'), 'userdata')
  : path.join(app.getPath('appData'), 'TPlan')));

const SCHEME = 'tplan-pack';
protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

if (!app.requestSingleInstanceLock({ argv: ARGV })) {
  app.quit();
} else {
  main();
}

function main() {
  const ROOT = path.join(__dirname, '..', '..');
  const DATA = app.getPath('userData');
  const CHAR_DIR = path.join(DATA, 'characters');
  const STATE_FILE = path.join(DATA, 'state.json');
  const PREFS_FILE = path.join(DATA, 'pet-window.json');
  const LOG_FILE = path.join(DATA, 'desktop-log.txt');
  const AI_FILE = path.join(DATA, 'ai-profiles.json');
  const CHAT_DIR = path.join(DATA, 'chats');
  const UI_INDEX = path.join(ROOT, 'ui-dist', 'index.html');
  const SELFTEST = flagValue('--selftest');

  // A fixed-size UI card shown when no character pack is loaded. It is not a
  // character; it only exists so the window can still be found and dragged.
  const MISSING_GEOM = { canvasW: 260, canvasH: 132, anchorX: 130, footY: 132, figureTop: 0, figureLeft: 0, figureRight: 260 };

  const DEFAULT_PREFS = {
    foot: null, height: null, alwaysOnTop: true, locked: false, passthrough: false,
    quiet: false, visible: true, packDir: null, reducedMotion: false,
  };

  let prefs = { ...DEFAULT_PREFS, ...readJson(PREFS_FILE, {}) };
  let pack = null;            // loaded pack, or null
  let packStatus = { status: 'missing', errors: [], warnings: [] };
  let layout = null;
  let pet = null;
  let consoleWin = null;   // developer console (pet diagnostics)
  let appWin = null;       // the T计划 main window
  let tray = null;
  let quitting = false;
  let hit = false;
  let drag = null;
  let lastRendered = null;
  let mainCloseNoticeShown = false;
  const LOG = [];

  // ---------------------------------------------------------------- logging

  function log(type, msg, data) {
    const e = { t: new Date().toISOString(), type, msg, ...(data !== undefined ? { data } : {}) };
    LOG.push(e);
    if (LOG.length > 400) LOG.shift();
    fs.appendFile(LOG_FILE, JSON.stringify(e) + '\n', () => {});
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.webContents.send('console:log', e);
  }

  // ------------------------------------------------------------------- core

  const core = new Core({
    read: () => readState(STATE_FILE),
    write: (s) => writeJsonAtomic(STATE_FILE, s),
    // Keep the untouched file before a schema upgrade rewrites it.
    backup: (raw, from) => writeJsonAtomic(path.join(DATA, `before-schema-${from}-upgrade-${Date.now()}.json`), raw),
  });

  // ------------------------------------------------------------------ AI
  // Keys are encrypted with the OS (DPAPI on Windows) and only ever decrypted
  // here, in the main process. Requests go through Electron's network stack
  // so the system proxy applies.

  const profiles = new Profiles({
    read: () => readJson(AI_FILE, null),
    write: (d) => writeJsonAtomic(AI_FILE, d),
    codec: {
      available: () => safeStorage.isEncryptionAvailable(),
      encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
      decrypt: (stored) => safeStorage.decryptString(Buffer.from(stored, 'base64')),
    },
  });
  const chats = new Chats({ dir: CHAT_DIR, readJson, writeJson: writeJsonAtomic });
  const appSend = (channel, data) => { if (appWin && !appWin.isDestroyed() && !appWin.webContents.isDestroyed()) appWin.webContents.send(channel, data); };
  const chatService = new ChatService({
    core, chats, profiles,
    fetch: (url, init) => net.fetch(url, init),
    emit: (ev) => appSend('chat:event', ev),
  });

  function savePrefs() {
    try { writeJsonAtomic(PREFS_FILE, prefs); } catch (e) { log('error', '保存窗口设置失败', e.message); }
  }

  // --------------------------------------------------------------- packs

  function packDirToLoad() {
    const cli = flagValue('--pack');
    if (cli) return path.resolve(cli);
    if (prefs.packDir) return prefs.packDir;
    const found = listPacks(CHAR_DIR);
    if (found.length) return found[0].dir;
    return flag('--no-default-pack') ? null : path.join(ROOT,'assets','characters','warm-scholar');
  }

  /**
   * Load a pack. On failure the previously loaded pack (if any) stays active,
   * so a broken reload never blanks the pet or disturbs the timer.
   */
  function applyPack(dir, { remember, reason }) {
    if (!dir) {
      if (!pack) packStatus = { status: 'missing', errors: [], warnings: [], dir: null };
      log('pack', '没有可用的角色资源包', { charactersDir: CHAR_DIR });
      return false;
    }
    const r = loadPack(dir, { nativeImage });
    if (!r.ok) {
      packStatus = {
        status: pack ? 'error-kept-previous' : 'error', dir, errors: r.errors, warnings: r.warnings,
        keptPack: pack ? `${pack.manifest.name} ${pack.manifest.version}` : null,
      };
      log('pack', `资源包加载失败（${reason}）`, { dir, errors: r.errors, warnings: r.warnings });
      sendPack();
      refreshTray();
      return false;
    }
    pack = r.pack;
    packStatus = { status: 'ok', dir: pack.dir, errors: [], warnings: r.warnings };
    if (remember) { prefs.packDir = pack.dir; savePrefs(); }
    log('pack', `已加载资源包：${pack.manifest.name} ${pack.manifest.version}（${reason}）`, {
      dir: pack.dir, states: Object.keys(pack.assets), warnings: r.warnings, geom: pack.geom,
    });
    relayout('pack');
    sendPack();
    refreshTray();
    return true;
  }

  function packPayload() {
    const base = { status: packStatus.status, errors: packStatus.errors, warnings: packStatus.warnings, charactersDir: CHAR_DIR };
    if (!pack) return { ...base, loaded: false };
    const m = pack.manifest;
    const states = {};
    for (const [name, a] of Object.entries(pack.assets)) {
      states[name] = { url: `${SCHEME}://pack/${pack.loadId}/${encodeURI(a.src)}`, mask: a.mask };
    }
    return { ...base, loaded: true, id: m.id, name: m.name, version: m.version, canvas: m.canvas, states };
  }

  /** Serve only files that the current pack's manifest lists. */
  function handlePackProtocol(request) {
    const u = new URL(request.url);
    const [, loadId, ...rest] = u.pathname.split('/');
    const rel = decodeURI(rest.join('/'));
    if (!pack || String(pack.loadId) !== loadId) return new Response('pack not loaded', { status: 404 });
    const asset = Object.values(pack.assets).find((a) => a.src === rel);
    if (!asset) return new Response('not in manifest', { status: 404 });
    return net.fetch(pathToFileURL(asset.file).toString());
  }

  // -------------------------------------------------------------- layout

  function workAreas() { return screen.getAllDisplays().map((d) => d.workArea); }
  function primaryWorkArea() { return screen.getPrimaryDisplay().workArea; }

  function currentHeight() {
    if (!pack) return MISSING_GEOM.footY;
    return geo.clampHeight(prefs.height || pack.manifest.display.defaultHeight);
  }

  /** Recompute the window for the current pack/size, keeping the feet in place. */
  function relayout(reason) {
    const geom = pack ? pack.geom : MISSING_GEOM;
    const next = geo.computeLayout(geom, currentHeight());
    const foot = pet && layout ? geo.footFromPos(posOf(pet), layout) : prefs.foot;
    layout = next;
    const want = foot ? geo.posFromFoot(foot, layout) : null;
    const { pos, recovered } = geo.validateOrRecover(want, layout, workAreas(), primaryWorkArea());
    if (recovered) log('screen', '位置不可见，已移到主屏幕右下角', { reason, want });
    if (pet) {
      pet.setBounds({ x: pos.x, y: pos.y, width: layout.winW, height: layout.winH });
      sendLayout();
    }
    prefs.foot = geo.footFromPos(pos, layout);
    savePrefs();
    return pos;
  }

  function posOf(win) { const b = win.getBounds(); return { x: b.x, y: b.y }; }
  function petAlive() { return !!(pet && !pet.isDestroyed()); }
  /** Send to the pet window only while it exists (it can be gone during shutdown). */
  function petSend(channel, data) { if (petAlive() && !pet.webContents.isDestroyed()) pet.webContents.send(channel, data); }

  function sendLayout() {
    if (!petAlive()) return;
    const side = geo.bubbleSide(posOf(pet), layout, workAreas());
    petSend('pet:layout', { ...layout, side, packLoaded: !!pack });
  }
  function sendPack() { if (pet) petSend('pet:pack', packPayload()); }
  function sendMode() {
    if (pet) petSend('pet:mode', { locked: prefs.locked, passthrough: prefs.passthrough, quiet: prefs.quiet, reducedMotion: prefs.reducedMotion });
  }
  function sendView() {
    const v = petView(core.S, Date.now());
    if (pet) petSend('pet:view', v);
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.webContents.send('console:update', consoleState());
    appSend('app:update', appState());
  }

  function ensureVisible(reason) {
    if (!pet || !layout) return;
    const { pos, recovered } = geo.validateOrRecover(posOf(pet), layout, workAreas(), primaryWorkArea());
    // Re-assert size too: DPI changes can resize a window behind our back.
    pet.setBounds({ x: pos.x, y: pos.y, width: layout.winW, height: layout.winH });
    if (recovered) log('screen', `桌宠不在可见区域，已找回（${reason}）`, pos);
    prefs.foot = geo.footFromPos(pos, layout);
    savePrefs();
    sendLayout();
  }

  // ----------------------------------------------------------- pet window

  function createPet() {
    const geom = pack ? pack.geom : MISSING_GEOM;
    layout = geo.computeLayout(geom, currentHeight());
    const want = prefs.foot ? geo.posFromFoot(prefs.foot, layout) : null;
    const { pos, recovered } = geo.validateOrRecover(want, layout, workAreas(), primaryWorkArea());
    if (recovered) log('screen', '启动时使用默认位置（主屏幕右下角）', { saved: prefs.foot });

    pet = new BrowserWindow({
      x: pos.x, y: pos.y, width: layout.winW, height: layout.winH,
      transparent: true, frame: false, resizable: false, maximizable: false, minimizable: false,
      fullscreenable: false, hasShadow: false, skipTaskbar: true, focusable: false,
      alwaysOnTop: prefs.alwaysOnTop, show: false, backgroundColor: '#00000000', title: 'T计划桌宠',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'pet.js'),
        contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false,
      },
    });
    applyMouseMode();
    pet.on('close', (e) => { if (!quitting) { e.preventDefault(); hidePet('close-blocked'); } });
    pet.on('session-end', () => { log('power', 'Windows 会话结束（关机/注销）'); core.autoPause('session-end'); savePrefs(); });
    pet.on('query-session-end', () => log('power', 'Windows 询问是否可以结束会话'));
    pet.webContents.on('did-finish-load', () => {
      sendLayout(); sendPack(); sendMode(); sendView();
      if (prefs.visible) showPet('startup');
      if (core.S.desktop.reminder) petSend('pet:event', { type: 'autoPaused', reason: core.S.desktop.reminder.reason });
    });
    pet.webContents.on('render-process-gone', (_e, d) => log('error', '桌宠渲染进程退出，正在重新加载', d));
    pet.loadFile(path.join(__dirname, '..', 'renderer', 'pet', 'index.html'));
  }

  function applyMouseMode() {
    if (!pet) return;
    if (prefs.passthrough) { hit = false; pet.setIgnoreMouseEvents(true); }
    else pet.setIgnoreMouseEvents(!hit, { forward: true });
  }

  function showPet(reason) {
    if (!pet) return;
    pet.showInactive();
    petSend('pet:appear');
    if (!prefs.visible) { prefs.visible = true; savePrefs(); }
    log('pet', `显示桌宠（${reason}）`);
    refreshTray();
  }

  function hidePet(reason) {
    if (!pet) return;
    pet.hide();
    prefs.visible = false;
    savePrefs();
    log('pet', `隐藏桌宠（${reason}），计时与保存继续运行`);
    refreshTray();
  }

  function findPet() {
    if (!pet) return;
    const pos = geo.recoveryPosition(layout, primaryWorkArea());
    pet.setBounds({ x: pos.x, y: pos.y, width: layout.winW, height: layout.winH });
    prefs.foot = geo.footFromPos(pos, layout);
    restoreInteraction();
    showPet('find');
    sendLayout();
    log('screen', '一键找回：已移到主屏幕右下角', pos);
  }

  function restoreInteraction() {
    prefs.locked = false;
    prefs.passthrough = false;
    savePrefs();
    applyMouseMode();
    sendMode();
    refreshTray();
  }

  function setMode(key, value) {
    if (!['locked','passthrough','quiet','reducedMotion'].includes(key)) return;
    prefs[key] = value;
    savePrefs();
    applyMouseMode();
    sendMode();
    refreshTray();
    log('pet', `${key} = ${value}`);
    if (key === 'passthrough' && value && pet) {
      petSend('pet:event', { type: 'notice', text: '已开启全部穿透。要恢复操作，请在右下角托盘图标里点「恢复桌宠交互」。' });
    }
  }

  function setAlwaysOnTop(v) {
    prefs.alwaysOnTop = v;
    savePrefs();
    if (pet) pet.setAlwaysOnTop(v);
    refreshTray();
  }

  function setHeight(h) {
    prefs.height = h == null ? null : geo.clampHeight(h);
    relayout('resize');
    refreshTray();
    log('pet', `显示高度 = ${currentHeight()} DIP`);
  }

  // ------------------------------------------------------------------ drag

  function dragStart() {
    if (drag || prefs.locked || prefs.passthrough || !pet) return;
    const c = screen.getCursorScreenPoint();
    const p = posOf(pet);
    drag = { offX: c.x - p.x, offY: c.y - p.y, started: Date.now(), frames: 0, lx: p.x, ly: p.y };
    drag.timer = setInterval(() => {
      const q = screen.getCursorScreenPoint();
      const nx = q.x - drag.offX, ny = q.y - drag.offY;
      if (nx !== drag.lx || ny !== drag.ly) {
        pet.setPosition(nx, ny);
        drag.lx = nx; drag.ly = ny; drag.frames++;
      }
      if (Date.now() - drag.started > 120000) dragEnd('watchdog'); // never stuck in drag mode
    }, 16);
  }

  function dragEnd(reason) {
    if (!drag) return;
    clearInterval(drag.timer);
    const b = pet.getBounds();
    if (b.width !== layout.winW || b.height !== layout.winH) {
      log('screen', '拖动后窗口尺寸发生漂移，已恢复（多显示器缩放比例不同可能导致）', { got: b, want: [layout.winW, layout.winH] });
    }
    const { pos, moved } = geo.clampAfterDrag({ x: b.x, y: b.y }, layout, workAreas());
    pet.setBounds({ x: pos.x, y: pos.y, width: layout.winW, height: layout.winH });
    prefs.foot = geo.footFromPos(pos, layout);
    savePrefs();
    const display = screen.getDisplayMatching({ x: pos.x, y: pos.y, width: layout.winW, height: layout.winH });
    log('drag', `拖动结束（${reason}）`, { pos, snappedBack: moved, frames: drag.frames, ms: Date.now() - drag.started, scaleFactor: display.scaleFactor });
    drag = null;
    sendLayout();
  }

  // --------------------------------------------------------------- focus

  function wantFocus() {
    if (!pet) return;
    pet.setFocusable(true);
    pet.focus();
    petSend('pet:focus-granted');
  }
  function releaseFocus() {
    if (!pet) return;
    pet.setFocusable(false);
    pet.setSkipTaskbar(true);
  }

  // ------------------------------------------------------------ main window

  const APP_PAGES = ['today', 'week', 'goals', 'review', 'chat', 'settings'];

  /** The T计划 main window (React UI built into ui-dist). */
  function openMain(page) {
    if (!APP_PAGES.includes(page)) page = undefined;
    if (!fs.existsSync(UI_INDEX)) {
      log('error', '主窗口界面还没有构建（缺少 ui-dist），已改为打开开发控制台。请运行 npm run build:ui');
      return openConsole();
    }
    if (appWin && !appWin.isDestroyed()) {
      if (appWin.isMinimized()) appWin.restore();
      appWin.show(); appWin.focus();
      if (page) appWin.webContents.send('app:goto', page);
      return;
    }
    appWin = new BrowserWindow({
      width: 1180, height: 800, minWidth: 860, minHeight: 560, show: false, title: 'T计划',
      backgroundColor: '#FAF9F5',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'app.js'),
        contextIsolation: true, sandbox: true, nodeIntegration: false,
      },
    });
    appWin.setMenuBarVisibility(false);
    // Links in model answers open in the browser; the window itself never navigates away.
    appWin.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
    appWin.webContents.on('will-navigate', (e, url) => { e.preventDefault(); if (/^https?:\/\//i.test(url)) shell.openExternal(url); });
    appWin.loadFile(UI_INDEX, page ? { hash: page } : undefined);
    appWin.once('ready-to-show', () => appWin.show());
    appWin.on('closed', () => {
      appWin = null;
      log('app', '主窗口已关闭；桌宠、计时和保存继续在后台运行');
      if (!quitting && !mainCloseNoticeShown) {
        mainCloseNoticeShown = true;
        notice('T计划还在托盘里，计时和桌宠不受影响。');
      }
    });
  }

  function appState() {
    return {
      state: core.snapshot(),
      now: Date.now(),
      pet: { visible: petAlive() ? pet.isVisible() : false, quiet: prefs.quiet },
      dataDir: DATA,
      version: app.getVersion(),
    };
  }

  // --------------------------------------------------------- developer console

  function openConsole(page) {
    if (consoleWin && !consoleWin.isDestroyed()) {
      if (consoleWin.isMinimized()) consoleWin.restore();
      consoleWin.show(); consoleWin.focus();
      if (page) consoleWin.webContents.send('console:goto', page);
      return;
    }
    consoleWin = new BrowserWindow({
      width: 1040, height: 760, minWidth: 720, minHeight: 520, show: false, title: 'T计划',
      backgroundColor: '#FAF9F5',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'console.js'),
        contextIsolation: true, sandbox: true, nodeIntegration: false,
      },
    });
    consoleWin.setMenuBarVisibility(false);
    consoleWin.loadFile(path.join(__dirname, '..', 'renderer', 'console', 'index.html'), page ? { hash: page } : undefined);
    consoleWin.once('ready-to-show', () => consoleWin.show());
    consoleWin.on('closed', () => { consoleWin = null; });
  }

  function consoleState() {
    const S = core.S;
    const today = petView(S, Date.now());
    return {
      view: today,
      gallery: packPayload().states || {},
      settings: S.settings,
      tasks: S.tasks.filter((t) => !t.done).slice(-80),
      sessions: S.sessions.slice(-30).reverse(),
      prefs,
      height: currentHeight(),
      pack: { ...packStatus, info: pack ? { name: pack.manifest.name, version: pack.manifest.version, id: pack.manifest.id, states: Object.keys(pack.assets), geom: pack.geom, display: pack.manifest.display } : null },
      packsAvailable: listPacks(CHAR_DIR),
      charactersDir: CHAR_DIR,
      dataDir: DATA,
      lastRendered,
      displays: screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, workArea: d.workArea, scaleFactor: d.scaleFactor, primary: d.id === screen.getPrimaryDisplay().id })),
      petBounds: petAlive() ? pet.getBounds() : null,
      petVisible: petAlive() ? pet.isVisible() : false,
      versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, os: `${process.platform} ${process.getSystemVersion()}` },
      gpu: app.getGPUFeatureStatus(),
      hardwareAcceleration: !flag('--no-gpu'),
      loginItem: loginItemEnabled(),
      log: LOG.slice(-200),
    };
  }

  // -------------------------------------------------------------- notices

  /** Short message: through the pet when visible, else a Windows notification. */
  function notice(text, { force } = {}) {
    if (quitting) return;
    if (petAlive() && pet.isVisible() && !prefs.passthrough && !(prefs.quiet && !force)) {
      petSend('pet:event', { type: 'notice', text });
      return;
    }
    if (prefs.quiet && !force) return;
    if (Notification.isSupported()) {
      const n = new Notification({ title: 'T计划', body: text, silent: false });
      n.on('click', () => showPet('notification'));
      n.show();
    }
  }

  // ----------------------------------------------------------------- tray

  function loginArgs() { return app.isPackaged ? ['--pet-only', '--autostart'] : [ROOT, '--pet-only', '--autostart']; }
  function loginExecutable() { return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath; }
  function loginItemEnabled() {
    try { return app.getLoginItemSettings({ path: loginExecutable(), args: loginArgs() }).openAtLogin; } catch { return false; }
  }

  function createTray() {
    tray = new Tray(nativeImage.createFromPath(path.join(ROOT, 'assets', 'tray', 'tray.png')));
    tray.on('click', () => {
      if (prefs.passthrough || prefs.locked) restoreInteraction();
      showPet('tray-click');
    });
    tray.on('double-click', () => openMain());
    refreshTray();
  }

  function refreshTray() {
    if (!tray || tray.isDestroyed()) return;
    const a = core.S.active;
    const phase = a ? ({ running: '专注中', paused: '已暂停', due: '时间到' }[a.phase] || '') : '';
    tray.setToolTip(['T计划', phase && `${phase} · ${a.title}`, prefs.passthrough && '全部穿透中', !prefs.visible && '桌宠已隐藏']
      .filter(Boolean).join(' · ').slice(0, 120));
    const packs = listPacks(CHAR_DIR);
    const sizes = [200, 260, 320, 400];
    const h = currentHeight();
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 T计划', click: () => openMain() },
      { label: '和 AI 聊聊', click: () => openMain('chat') },
      { type: 'separator' },
      { label: '显示桌宠', type: 'checkbox', checked: !!(pet && pet.isVisible()), click: (i) => (i.checked ? showPet('tray') : hidePet('tray')) },
      { label: '始终置顶', type: 'checkbox', checked: prefs.alwaysOnTop, click: (i) => setAlwaysOnTop(i.checked) },
      { label: '安静模式', type: 'checkbox', checked: prefs.quiet, click: (i) => setMode('quiet', i.checked) },
      { label: '减少动作', type: 'checkbox', checked: prefs.reducedMotion, click: (i) => setMode('reducedMotion', i.checked) },
      { label: '恢复桌宠交互', enabled: prefs.locked || prefs.passthrough, click: restoreInteraction },
      { label: '找回桌宠位置', click: findPet },
      { label: '显示大小', enabled: !!pack, submenu: [
        ...sizes.map((s) => ({ label: `${s}`, type: 'radio', checked: h === s, click: () => setHeight(s) })),
        { label: '使用资源包默认值', click: () => setHeight(null) },
      ] },
      { label: '角色资源包', submenu: [
        ...(packs.length ? packs.map((p) => ({
          label: `${p.name}${p.version ? ' ' + p.version : ''}`, type: 'radio',
          checked: !!(pack && pack.dir === p.dir), click: () => applyPack(p.dir, { remember: true, reason: 'tray' }),
        })) : [{ label: '（资源文件夹里还没有资源包）', enabled: false }]),
        { type: 'separator' },
        { label: '从文件夹加载…', click: choosePackFolder },
        { label: '重新加载当前资源包', enabled: !!(pack || prefs.packDir), click: reloadPack },
        { label: '打开角色资源文件夹', click: openCharactersDir },
      ] },
      { type: 'separator' },
      ...(a ? [
        a.phase === 'running'
          ? { label: '暂停计时', click: () => core.dispatch({ type: 'timer.pause', payload: { activeId: a.id } }) }
          : { label: '继续计时', enabled: a.phase === 'paused', click: () => core.dispatch({ type: 'timer.resume', payload: { activeId: a.id } }) },
        { label: '结束计时并记录', click: () => core.dispatch({ type: 'timer.end', payload: { activeId: a.id } }) },
        { type: 'separator' },
      ] : []),
      { label: '开机自动启动（只启动桌宠）', type: 'checkbox', checked: loginItemEnabled(), click: (i) => {
        app.setLoginItemSettings({ openAtLogin: i.checked, path: loginExecutable(), args: loginArgs() });
        log('app', `开机自动启动 = ${i.checked}`);
      } },
      { label: '开发控制台（桌宠诊断）', click: () => openConsole() },
      { label: '退出 T计划', click: () => app.quit() },
    ]));
  }

  function petContextMenu() {
    const h = currentHeight();
    Menu.buildFromTemplate([
      { label: '打开 T计划', click: () => openMain() },
      { label: '和 AI 聊聊', click: () => openMain('chat') },
      { label: '今天回看', click: () => petSend('pet:event',{type:'review'}) },
      { type: 'separator' },
      { label: '安静模式', type: 'checkbox', checked: prefs.quiet, click: (i) => setMode('quiet', i.checked) },
      { label: '锁定位置', type: 'checkbox', checked: prefs.locked, click: (i) => setMode('locked', i.checked) },
      { label: '全部鼠标穿透', type: 'checkbox', checked: prefs.passthrough, click: (i) => setMode('passthrough', i.checked) },
      { label: '显示大小', enabled: !!pack, submenu: [200, 260, 320, 400].map((s) => ({ label: `${s}`, type: 'radio', checked: h === s, click: () => setHeight(s) })) },
      { label: '重新加载角色资源', enabled: !!(pack || prefs.packDir), click: reloadPack },
      { type: 'separator' },
      { label: '隐藏桌宠', click: () => hidePet('menu') },
    ]).popup({ window: pet });
  }

  async function choosePackFolder() {
    const r = await dialog.showOpenDialog({
      title: '选择角色资源包文件夹（包含 manifest.json）', defaultPath: CHAR_DIR, properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return;
    if (!applyPack(r.filePaths[0], { remember: true, reason: 'choose' })) showPackErrors();
  }

  function reloadPack() {
    const dir = (pack && pack.dir) || prefs.packDir;
    if (!applyPack(dir, { remember: false, reason: 'reload' })) showPackErrors();
    else if (packStatus.warnings.length) notice(`资源包已重新加载（${packStatus.warnings.length} 条提示，详见 T计划 → 角色资源）`);
    else notice('资源包已重新加载');
  }

  function showPackErrors() {
    dialog.showMessageBox({
      type: 'warning', title: '角色资源包加载失败',
      message: packStatus.keptPack ? `加载失败，已继续使用：${packStatus.keptPack}` : '加载失败，桌宠暂时显示“素材缺失”卡片。学习数据和计时不受影响。',
      detail: [...packStatus.errors, ...packStatus.warnings.map((w) => '提示：' + w)].join('\n'),
    });
  }

  function openCharactersDir() {
    fs.mkdirSync(CHAR_DIR, { recursive: true });
    shell.openPath(CHAR_DIR);
  }

  // ------------------------------------------------------------------ IPC

  ipcMain.on('pet:hit', (_e, v) => {
    if (prefs.passthrough || !pet) return;
    if (!!v === hit) return;
    hit = !!v;
    pet.setIgnoreMouseEvents(!hit, { forward: true });
  });
  ipcMain.on('pet:drag', (_e, what) => (what === 'start' ? dragStart() : dragEnd('pointerup')));
  ipcMain.on('pet:menu', () => petContextMenu());
  ipcMain.on('pet:focus', (_e, what) => (what === 'want' ? wantFocus() : releaseFocus()));
  ipcMain.on('pet:rendered', (_e, info) => {
    lastRendered = info;
    if (consoleWin && !consoleWin.isDestroyed()) consoleWin.webContents.send('console:update', consoleState());
  });
  ipcMain.handle('core:dispatch', (_e, cmd) => core.dispatch(cmd));
  ipcMain.handle('console:get', () => consoleState());
  const senderWindow = (e) => BrowserWindow.fromWebContents(e.sender) || appWin || consoleWin || pet;
  ipcMain.handle('console:export-data', async (e) => {
    const r = await dialog.showSaveDialog(senderWindow(e), {defaultPath:'T计划备份.json',filters:[{name:'JSON',extensions:['json']}]});
    if (r.canceled) return {ok:false,canceled:true};
    try {writeJsonAtomic(r.filePath,core.snapshot());return {ok:true};}catch(e){return {ok:false,error:e.message};}
  });
  ipcMain.handle('console:export-diagnostics', () => {
    const s = consoleState();
    delete s.tasks; delete s.sessions; delete s.view;
    clipboard.writeText(JSON.stringify(s, null, 2));
    return true;
  });
  ipcMain.handle('console:import', async (e) => {
    const parent = senderWindow(e);
    const r = await dialog.showOpenDialog(parent, { title: '导入 T计划 导出的 JSON', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    let obj;
    try { obj = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8').replace(/^﻿/, '')); } catch (e) { return { ok: false, error: '文件不是有效的 JSON：' + e.message }; }
    // The web app's export may wrap the state; accept both shapes.
    const state = Array.isArray(obj.tasks) ? obj : (obj.state || obj.data || obj.S || obj);
    if (!Array.isArray(state.tasks)) return {ok:false,error:'导出文件缺少 tasks。'};
    const answer = await dialog.showMessageBox(parent, {type:'question', title:'导入学习记录', message:'用这份文件替换当前任务和历史记录？', detail:'当前数据会另存为导入前备份，正在进行的计时会保留。', buttons:['取消','导入'], defaultId:0, cancelId:0});
    if (answer.response !== 1) return {ok:false,canceled:true};
    writeJsonAtomic(path.join(DATA,'before-import-'+Date.now()+'.json'),core.snapshot());
    return core.dispatch({ type: 'data.import', payload: { state } });
  });
  // ---- main window: full data, read-only queries, model profiles, chat

  ipcMain.handle('app:get', () => appState());
  ipcMain.handle('app:query', (_e, name, args) => core.query(name, args));

  ipcMain.handle('ai:profiles', () => profiles.list());
  ipcMain.handle('ai:save-profile', (_e, input) => profiles.save(input || {}));
  ipcMain.handle('ai:remove-profile', (_e, id) => profiles.remove(id));
  ipcMain.handle('ai:set-active', (_e, id) => profiles.setActive(id));
  ipcMain.handle('ai:test-profile', async (_e, id) => {
    const r = await chatService.testProfile(id);
    log('ai', `连通测试：${r.ok ? '成功' : '失败'}，工具调用：${r.tools ? '支持' : '不支持'}`, { error: r.error, toolsNote: r.toolsNote });
    return r;
  });

  ipcMain.handle('chat:list', () => chats.list());
  ipcMain.handle('chat:create', () => chats.create());
  ipcMain.handle('chat:load', (_e, id) => { const c = chats.load(id); return c ? { ...c, running: chatService.isRunning(id) } : null; });
  ipcMain.handle('chat:remove', (_e, id) => { chatService.stop(id); return chats.remove(id); });
  ipcMain.handle('chat:send', (_e, p) => chatService.send(p || {}));
  ipcMain.handle('chat:stop', (_e, id) => chatService.stop(id));
  ipcMain.handle('chat:decide', (_e, p) => {
    const r = chatService.decide(p || {});
    if (r.proposal) log('ai', `提议「${r.proposal.title}」：${r.proposal.status}`);
    return r;
  });
  ipcMain.handle('review:draft', (_e, p) => chatService.draftReview(p || {}));

  ipcMain.on('app:action', (_e, name, arg) => {
    const actions = {
      'open-main': () => openMain(arg),
      'open-console': () => openConsole(arg),
      'show-review': () => petSend('pet:event',{type:'review'}),
      'show-pet': () => showPet('console'),
      'hide-pet': () => hidePet('console'),
      'find-pet': findPet,
      'restore-interaction': restoreInteraction,
      'set-mode': () => setMode(arg.key, !!arg.value),
      'set-top': () => setAlwaysOnTop(!!arg),
      'set-height': () => setHeight(arg),
      'choose-pack': choosePackFolder,
      'reload-pack': reloadPack,
      'open-characters-dir': openCharactersDir,
      'open-data-dir': () => shell.openPath(DATA),
      'test-notification': () => notice('这是一条测试通知。', { force: true }),
    };
    if (actions[name]) actions[name]();
  });

  // ---------------------------------------------------------- core events

  core.on('change', () => { if (!quitting) { sendView(); refreshTray(); } });
  core.on('event', (ev) => {
    log('core', ev.type, ev);
    if (pet) petSend('pet:event', ev);
    if (ev.type === 'gentleReminder' && (!petAlive() || !pet.isVisible())) notice(ev.text);
    const petShowing = petAlive() && pet.isVisible() && !prefs.passthrough;
    if (ev.type === 'timeUp' && !petShowing && !prefs.quiet && Notification.isSupported()) {
      // Hidden or click-through pet: fall back to one Windows notification.
      const n = new Notification({ title: 'T计划 · 时间到', body: '这段时间记下来了。继续一会儿，还是先休息？' });
      n.on('click', () => { restoreInteraction(); showPet('timeUp-notification'); });
      n.show();
    }
  });

  // ------------------------------------------------------------ app events

  app.on('second-instance', (_e, argv, _cwd, extra) => {
    const args = (extra && extra.argv) || argv;
    log('app', '再次启动：转交给已运行的实例', args);
    if (args.includes('--pet-only')) { restoreInteraction(); showPet('second-instance'); }
    else openMain();
  });
  app.on('window-all-closed', () => { /* keep running in the tray */ });
  app.on('will-quit', () => { quitting = true; });
  process.on('uncaughtException', (e) => log('error', '主进程未捕获异常', String(e && e.stack || e)));
  app.on('before-quit', () => {
    quitting = true;
    if (drag) dragEnd('quit');
    core.autoPause('quit');
    savePrefs();
    log('app', '退出整个应用');
  });

  app.whenReady().then(() => {
    app.setAppUserModelId(app.isPackaged ? 'com.tplan.desktop' : process.execPath);
    protocol.handle(SCHEME, handlePackProtocol);
    fs.mkdirSync(CHAR_DIR, { recursive: true });
    writeCharactersReadme(CHAR_DIR);

    // Automated tests on Linux have no keyring. With a throwaway --test-data
    // profile only, let safeStorage use Chromium's built-in fallback key.
    if (process.platform === 'linux' && flagValue('--test-data') && safeStorage.setUsePlainTextEncryption) {
      safeStorage.setUsePlainTextEncryption(true);
    }

    core.load();
    setInterval(() => core.heartbeat(), 10000);
    setInterval(() => core.checkReminders(prefs.quiet), 30000);

    log('app', '启动', { argv: ARGV, petOnly: flag('--pet-only'), autostart: flag('--autostart'), electron: process.versions.electron, hardwareAcceleration: !flag('--no-gpu') });
    applyPack(packDirToLoad(), { remember: false, reason: 'startup' });

    createTray();
    createPet();
    if (flag('--main') || (!app.isPackaged && !flag('--pet-only'))) openMain();
    if (flag('--console')) openConsole();

    powerMonitor.on('suspend', () => { log('power', '系统休眠'); core.autoPause('sleep'); });
    powerMonitor.on('resume', () => { log('power', '系统唤醒'); ensureVisible('resume'); });
    powerMonitor.on('lock-screen', () => {log('power', '锁屏');core.autoPause('lock');});
    powerMonitor.on('unlock-screen', () => log('power', '解锁'));
    let displayTimer = null;
    const onDisplay = (name) => (_e, d, changed) => {
      log('screen', name, { id: d.id, scaleFactor: d.scaleFactor, workArea: d.workArea, changed });
      clearTimeout(displayTimer);
      displayTimer = setTimeout(() => { relayout(name); ensureVisible(name); }, 300);
    };
    screen.on('display-added', onDisplay('display-added'));
    screen.on('display-removed', onDisplay('display-removed'));
    screen.on('display-metrics-changed', onDisplay('display-metrics-changed'));

    if (SELFTEST) {
      require('./selftest').run({
        app, core, ROOT, log, outDir: path.resolve(SELFTEST),
        getPet: () => pet, getLayout: () => layout, getPackStatus: () => packStatus,
        applyPack, setHeight, getFoot: () => geo.footFromPos(posOf(pet), layout),
        markQuitting: () => { quitting = true; },
      });
    }
  }).catch(e => { dialog.showErrorBox('T计划启动失败',e.message);app.exit(1); });

  function writeCharactersReadme(dir) {
    const f = path.join(dir, '把角色资源包放在这里.txt');
    if (fs.existsSync(f)) return;
    fs.writeFileSync(f, [
      'T计划 角色资源包文件夹',
      '',
      '每个资源包是这里的一个子文件夹，里面必须有 manifest.json 和至少一张 idle 透明 PNG。',
      '放好后：托盘图标 → 角色资源包 → 选择它；修改图片后：托盘 → 角色资源包 → 重新加载当前资源包。',
      '格式说明见项目文档 docs/desktop-pet/character-pack-spec.md。',
      '',
    ].join('\r\n'), 'utf8');
  }
}
