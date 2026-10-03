/*
 * background.js — service worker расширения (MV3).
 *
 * Отвечает за:
 *  - очередь заданий: последовательная обработка, 1–2 параллельных «слота»,
 *    случайная пауза между файлами, до N повторов с растущей задержкой;
 *  - сохранение файлов через chrome.downloads (путь {канал}/{дата}_{id}.{ext});
 *  - дедупликацию: id скачанных сообщений хранятся в chrome.storage.local;
 *  - лог ошибок и состояние для popup.
 *
 * Сами байты скачивает вкладка Telegram (page/bridge.js в MAIN world) — только там
 * работает service worker Telegram Web. Background получает готовый blob:-URL.
 * Никаких сетевых запросов отсюда не делается; данные сессии не читаются и не хранятся.
 */

const DEFAULT_SETTINGS = {
  pauseMin: 1.5, // секунды
  pauseMax: 3,
  concurrency: 1, // 1–2 параллельных загрузки
  maxRetries: 3, // повторов после первой неудачной попытки
  template: '{channel}/{date}_{id}.{ext}',
  downloadMethod: 'auto', // auto | api | anchor
};

const LOG_LIMIT = 300;
const FAILED_LIMIT = 200;
const STALL_TIMEOUT_MS = 120000; // нет прогресса от вкладки — считаем попытку неудачной
const ANCHOR_START_TIMEOUT_MS = 20000;

let settings = { ...DEFAULT_SETTINGS };
let log = [];
const q = {
  pending: [],
  active: new Map(), // key -> job
  failed: [],
  paused: false,
  stats: { done: 0, failed: 0 },
};

let workers = 0;
let apiDownloadBroken = false; // chrome.downloads не смог прочитать blob страницы — используем <a download>

const fetchWaiters = new Map(); // key -> ожидание ответа вкладки по текущей попытке
const downloadWaiters = new Map(); // downloadId -> {resolve, reject, allowFallback}
const anchorWaiters = new Map(); // blobUrl -> resolve(downloadId)
const filenameByUrl = new Map(); // blobUrl -> относительный путь (для onDeterminingFilename)
const doneCache = new Map(); // peerKey -> {mid: unixTime}
const knownTabs = new Set(); // вкладки, ставившие задания (для рассылки счётчиков очереди)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// -----------------------------------------------------------------------------
// Инициализация и сохранение состояния
// -----------------------------------------------------------------------------

function sanitizeSettings(s) {
  const num = (v, d) => (Number.isFinite(+v) ? +v : d);
  const out = { ...DEFAULT_SETTINGS, ...s };
  out.pauseMin = Math.max(0, num(out.pauseMin, DEFAULT_SETTINGS.pauseMin));
  out.pauseMax = Math.max(out.pauseMin, num(out.pauseMax, DEFAULT_SETTINGS.pauseMax));
  out.concurrency = Math.min(2, Math.max(1, Math.round(num(out.concurrency, 1))));
  out.maxRetries = Math.min(5, Math.max(0, Math.round(num(out.maxRetries, 3))));
  out.template = String(out.template || '').trim() || DEFAULT_SETTINGS.template;
  if (!['auto', 'api', 'anchor'].includes(out.downloadMethod)) out.downloadMethod = 'auto';
  return out;
}

const ready = (async () => {
  const stored = await chrome.storage.local.get(['settings', 'log']);
  settings = sanitizeSettings(stored.settings || {});
  log = Array.isArray(stored.log) ? stored.log : [];

  // Очередь живёт в storage.session: переживает перезапуск service worker, но не браузера
  const { queueState } = await chrome.storage.session.get('queueState');
  if (queueState) {
    q.pending = queueState.pending || [];
    q.failed = queueState.failed || [];
    q.paused = !!queueState.paused;
    q.stats = queueState.stats || q.stats;
    // Задания, активные в момент остановки service worker, возвращаем в начало очереди
    for (const job of (queueState.active || []).reverse()) {
      job.status = 'pending';
      q.pending.unshift(job);
    }
  }
  pump();
})();

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    chrome.storage.session
      .set({
        queueState: {
          pending: q.pending,
          active: [...q.active.values()].map(stripJob),
          failed: q.failed,
          paused: q.paused,
          stats: q.stats,
        },
      })
      .catch((e) => console.warn('persist', e));
  }, 300);
}

let logTimer = null;
function addLog(level, text) {
  log.push({ t: Date.now(), level, text });
  if (log.length > LOG_LIMIT) log = log.slice(-LOG_LIMIT);
  (level === 'error' ? console.warn : console.log)('[TGDL]', text);
  clearTimeout(logTimer);
  logTimer = setTimeout(() => chrome.storage.local.set({ log }).catch(() => {}), 500);
}

/** Копия задания без служебных полей рантайма */
function stripJob(job) {
  const { cancelled, ...rest } = job;
  return rest;
}

const label = (job) => `${job.channel} #${job.mid}`;

// -----------------------------------------------------------------------------
// Дедупликация (chrome.storage.local: "dl:<peerKey>" -> {mid: время})
// -----------------------------------------------------------------------------

function splitKey(key) {
  const i = key.lastIndexOf(':');
  return [key.slice(0, i), key.slice(i + 1)];
}

async function getDoneMap(peerKey) {
  if (!doneCache.has(peerKey)) {
    const k = 'dl:' + peerKey;
    const r = await chrome.storage.local.get(k);
    doneCache.set(peerKey, r[k] || {});
  }
  return doneCache.get(peerKey);
}

async function isDone(key) {
  const [peerKey, mid] = splitKey(key);
  return !!(await getDoneMap(peerKey))[mid];
}

let writeChain = Promise.resolve();
function markDone(key) {
  writeChain = writeChain.then(async () => {
    const [peerKey, mid] = splitKey(key);
    const map = await getDoneMap(peerKey);
    map[mid] = Math.floor(Date.now() / 1000);
    await chrome.storage.local.set({ ['dl:' + peerKey]: map });
  });
  return writeChain;
}

async function historyStats() {
  const all = await chrome.storage.local.get(null);
  let chats = 0;
  let files = 0;
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith('dl:')) continue;
    chats++;
    files += Object.keys(v || {}).length;
  }
  return { chats, files };
}

async function clearHistory() {
  await writeChain;
  const all = await chrome.storage.local.get(null);
  await chrome.storage.local.remove(Object.keys(all).filter((k) => k.startsWith('dl:')));
  doneCache.clear();
}

const isQueued = (key) => q.active.has(key) || q.pending.some((j) => j.key === key);

// -----------------------------------------------------------------------------
// Имена файлов
// -----------------------------------------------------------------------------

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'video/x-msvideo': 'avi',
  'video/3gpp': '3gp',
};

function extFromMime(mime, type) {
  const m = String(mime || '').toLowerCase().split(';')[0].trim();
  if (MIME_EXT[m]) return MIME_EXT[m];
  const sub = /^(?:image|video)\/([a-z0-9]{2,5})$/.exec(m);
  if (sub) return sub[1];
  return type === 'photo' ? 'jpg' : 'mp4';
}

const RESERVED_WIN = /^(con|prn|aux|nul|com\d|lpt\d)$/i;
function sanitizeSegment(name) {
  let s = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f<>:"\\|?*]/g, '_')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .replace(/^\.+/, '');
  if (s.length > 100) s = s.slice(0, 100).trim();
  if (RESERVED_WIN.test(s.split('.')[0])) s = '_' + s;
  return s;
}

const pad = (n) => String(n).padStart(2, '0');
function dateParts(unix) {
  if (!unix) return { date: 'nodate', time: '00-00-00' };
  const d = new Date(unix * 1000);
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    time: `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`,
  };
}

/** Путь относительно папки загрузок: шаблон {channel}/{date}_{id}.{ext} и т. п. */
function buildFilename(job, mime) {
  const ext = extFromMime(mime, job.type);
  const { date, time } = dateParts(job.date);
  const tokens = {
    // Слеш в названии канала не должен порождать вложенные папки
    channel: sanitizeSegment(String(job.channel ?? '').replace(/[\\/]/g, '_')) || 'Telegram',
    date,
    time,
    id: String(job.mid),
    type: job.type,
    ext,
  };
  const path = settings.template.replace(/\{(\w+)\}/g, (m, k) => (k in tokens ? tokens[k] : m));
  const segments = path.split(/[\\/]+/).map(sanitizeSegment).filter(Boolean);
  if (!segments.length) segments.push(`${date}_${tokens.id}.${ext}`);
  let last = segments.pop();
  if (!last.toLowerCase().endsWith('.' + ext)) last += '.' + ext;
  return [...segments, last].join('/');
}

// -----------------------------------------------------------------------------
// Сохранение через chrome.downloads
// -----------------------------------------------------------------------------

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const filename = filenameByUrl.get(item.url) || filenameByUrl.get(item.finalUrl);
  if (!filename) return; // чужая загрузка — не вмешиваемся
  suggest({ filename, conflictAction: 'uniquify' });
  const resolveAnchor = anchorWaiters.get(item.url);
  if (resolveAnchor) {
    anchorWaiters.delete(item.url);
    resolveAnchor(item.id);
  }
});

chrome.downloads.onCreated.addListener((item) => {
  const resolveAnchor = anchorWaiters.get(item.url);
  if (resolveAnchor) {
    anchorWaiters.delete(item.url);
    resolveAnchor(item.id);
  }
});

function settleDownload(item) {
  const w = downloadWaiters.get(item.id);
  if (!w) return;
  if (item.state === 'complete') {
    downloadWaiters.delete(item.id);
    w.resolve(item);
  } else if (item.state === 'interrupted') {
    downloadWaiters.delete(item.id);
    const err = new Error(`Загрузка прервана: ${item.error || 'неизвестная ошибка'}`);
    // Ошибка сети без единого байта — вероятно, chrome.downloads не видит blob страницы
    err.fallback = w.allowFallback && !item.bytesReceived && String(item.error || '').startsWith('NETWORK');
    w.reject(err);
  }
}

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state || !downloadWaiters.has(delta.id)) return;
  chrome.downloads.search({ id: delta.id }).then(([item]) => item && settleDownload(item));
});

function waitForDownload(id, allowFallback) {
  return new Promise((resolve, reject) => {
    downloadWaiters.set(id, { resolve, reject, allowFallback });
    // На случай, если загрузка завершилась раньше, чем мы подписались
    chrome.downloads.search({ id }).then(([item]) => item && settleDownload(item));
  });
}

async function downloadViaApi(blobUrl, filename) {
  let id;
  try {
    id = await chrome.downloads.download({ url: blobUrl, filename, conflictAction: 'uniquify', saveAs: false });
  } catch (e) {
    const err = new Error('chrome.downloads: ' + (e?.message || e));
    err.fallback = !/filename/i.test(String(e?.message));
    throw err;
  }
  return waitForDownload(id, true);
}

/** Запасной путь: вкладка кликает <a download href=blob:...>, имя файла подставляем в onDeterminingFilename */
async function downloadViaAnchor(tabId, blobUrl) {
  const created = new Promise((resolve, reject) => {
    anchorWaiters.set(blobUrl, resolve);
    setTimeout(() => {
      if (anchorWaiters.delete(blobUrl)) {
        reject(
          new Error(
            'Страница не начала загрузку. Возможно, браузер заблокировал множественные загрузки — ' +
              'разрешите их для web.telegram.org (значок в адресной строке)',
          ),
        );
      }
    }, ANCHOR_START_TIMEOUT_MS);
  });
  await chrome.tabs.sendMessage(tabId, { type: 'anchorDownload', blobUrl });
  const id = await created;
  return waitForDownload(id, false);
}

async function saveFile(job, blobUrl, filename) {
  filenameByUrl.set(blobUrl, filename);
  try {
    const method = settings.downloadMethod;
    if (method === 'api' || (method === 'auto' && !apiDownloadBroken)) {
      try {
        return await downloadViaApi(blobUrl, filename);
      } catch (e) {
        if (method !== 'auto' || !e.fallback) throw e;
        apiDownloadBroken = true;
        addLog('warn', 'chrome.downloads не смог прочитать blob страницы — переключаюсь на сохранение через ссылку на странице');
      }
    }
    return await downloadViaAnchor(job.tabId, blobUrl);
  } finally {
    filenameByUrl.delete(blobUrl);
  }
}

// -----------------------------------------------------------------------------
// Очередь
// -----------------------------------------------------------------------------

function randomPause() {
  const { pauseMin, pauseMax } = settings;
  return Math.round((pauseMin + Math.random() * (pauseMax - pauseMin)) * 1000);
}

function sendToTab(tabId, message) {
  return chrome.tabs.sendMessage(tabId, message).catch(() => undefined);
}

function notifyTab(job, state, extra = {}) {
  sendToTab(job.tabId, { type: 'jobState', key: job.key, mid: job.mid, state, ...extra });
}

let statsTimer = null;
function broadcastStats() {
  clearTimeout(statsTimer);
  statsTimer = setTimeout(() => {
    const tabs = new Set([...q.pending, ...q.active.values()].map((j) => j.tabId).concat([...knownTabs]));
    for (const tabId of tabs) {
      sendToTab(tabId, { type: 'queueStats', pending: q.pending.length, active: q.active.size });
    }
  }, 300);
}

function pump() {
  while (!q.paused && workers < settings.concurrency && q.pending.length) {
    workers++;
    worker().finally(() => {
      workers--;
      pump();
    });
  }
  broadcastStats();
}

async function worker() {
  while (!q.paused && q.pending.length) {
    const job = q.pending.shift();
    await runJob(job);
    if (q.pending.length && !q.paused) await sleep(randomPause());
  }
}

/** Просит вкладку скачать источник и ждёт blob:-URL (jobFetched / jobFetchFailed) */
function requestFetch(job) {
  return new Promise((resolve, reject) => {
    const w = { attemptId: job.attemptId, resolve, reject, timer: null };
    const fail = (message) => {
      if (fetchWaiters.get(job.key) !== w) return;
      fetchWaiters.delete(job.key);
      clearTimeout(w.timer);
      reject(new Error(message));
    };
    w.fail = fail;
    w.arm = () => {
      clearTimeout(w.timer);
      w.timer = setTimeout(() => {
        sendToTab(job.tabId, { type: 'cancelJob', key: job.key });
        fail(`Нет прогресса загрузки ${STALL_TIMEOUT_MS / 1000} с`);
      }, STALL_TIMEOUT_MS);
    };
    w.arm();
    fetchWaiters.set(job.key, w);

    chrome.tabs
      .sendMessage(job.tabId, {
        type: 'fetchJob',
        job: { key: job.key, attemptId: job.attemptId, mid: job.mid, source: job.source },
      })
      .then((r) => {
        if (!r?.accepted) fail('Вкладка не приняла задание');
      })
      .catch((e) => fail('Вкладка Telegram недоступна: ' + (e?.message || e)));
  });
}

async function runJob(job) {
  q.active.set(job.key, job);
  persist();
  const maxAttempts = settings.maxRetries + 1;

  for (;;) {
    job.attempts = (job.attempts || 0) + 1;
    job.attemptId = `${job.key}#${job.attempts}#${Date.now()}`;
    job.status = 'fetching';
    job.loaded = 0;
    job.total = 0;
    notifyTab(job, 'active', { pct: 0 });

    let blobUrl = null;
    try {
      const fetched = await requestFetch(job);
      blobUrl = fetched.blobUrl;
      if (!fetched.size) throw new Error('Получен пустой файл');
      job.status = 'saving';
      const filename = buildFilename(job, fetched.mime);
      await saveFile(job, blobUrl, filename);
      await markDone(job.key);
      q.stats.done++;
      addLog('info', `Сохранено: ${filename} (${(fetched.size / 1048576).toFixed(1)} МБ)`);
      notifyTab(job, 'done');
      break;
    } catch (e) {
      const error = String(e?.message || e);
      if (job.cancelled) {
        addLog('warn', `Отменено: ${label(job)}`);
        notifyTab(job, 'idle');
        break;
      }
      if (job.attempts < maxAttempts) {
        const delay = 2000 * 2 ** (job.attempts - 1); // 2, 4, 8… с
        addLog('warn', `${label(job)}: ${error} — повтор ${job.attempts}/${settings.maxRetries} через ${delay / 1000} с`);
        job.status = 'retry-wait';
        notifyTab(job, 'queued');
        await sleep(delay);
        if (job.cancelled) break;
        continue;
      }
      q.stats.failed++;
      job.status = 'failed';
      job.error = error;
      q.failed.unshift(stripJob(job));
      if (q.failed.length > FAILED_LIMIT) q.failed.length = FAILED_LIMIT;
      addLog('error', `${label(job)}: ${error} (попыток: ${job.attempts})`);
      notifyTab(job, 'error', { error, final: true });
      break;
    } finally {
      if (blobUrl) sendToTab(job.tabId, { type: 'revoke', blobUrl });
    }
  }

  q.active.delete(job.key);
  persist();
  broadcastStats();
}

async function enqueue(jobs, tabId) {
  if (!tabId) return { added: false, reason: 'no-tab' };
  knownTabs.add(tabId);
  let added = 0;
  let reason = '';
  for (const job of jobs || []) {
    if (!job?.key || !job.source) continue;
    if (isQueued(job.key)) {
      reason = 'queued';
      continue;
    }
    if (!job.force && (await isDone(job.key))) {
      reason = 'done';
      continue;
    }
    q.pending.push({ ...job, tabId, attempts: 0, status: 'pending', addedAt: Date.now() });
    added++;
  }
  persist();
  pump();
  return { added: added > 0, count: added, reason };
}

async function checkKeys(keys) {
  const done = [];
  const queued = [];
  for (const key of keys || []) {
    if (isQueued(key)) queued.push(key);
    else if (await isDone(key)) done.push(key);
  }
  return { done, queued };
}

function cancelAll() {
  const dropped = q.pending.length;
  for (const job of q.pending) notifyTab(job, 'idle');
  q.pending = [];
  for (const job of q.active.values()) {
    job.cancelled = true;
    sendToTab(job.tabId, { type: 'cancelJob', key: job.key });
    fetchWaiters.get(job.key)?.fail('Отменено');
  }
  addLog('warn', `Очередь отменена (снято заданий: ${dropped}, прерывается активных: ${q.active.size})`);
  persist();
  broadcastStats();
}

function getState() {
  return {
    settings,
    paused: q.paused,
    pending: q.pending.length,
    pendingPreview: q.pending.slice(0, 10).map((j) => ({ key: j.key, channel: j.channel, mid: j.mid, type: j.type })),
    active: [...q.active.values()].map((j) => ({
      key: j.key,
      channel: j.channel,
      mid: j.mid,
      type: j.type,
      status: j.status,
      loaded: j.loaded || 0,
      total: j.total || 0,
      attempts: j.attempts,
    })),
    failed: q.failed.slice(0, 50).map((j) => ({ key: j.key, channel: j.channel, mid: j.mid, error: j.error })),
    stats: q.stats,
    log: log.slice(-150),
    apiDownloadBroken,
  };
}

// -----------------------------------------------------------------------------
// Сообщения от вкладок и popup
// -----------------------------------------------------------------------------

async function handleMessage(msg, sender) {
  await ready;
  switch (msg?.type) {
    // --- от content script ---
    case 'checkKeys':
      return checkKeys(msg.keys);
    case 'enqueue':
      return enqueue(msg.jobs, sender.tab?.id);
    case 'jobProgress': {
      const w = fetchWaiters.get(msg.key);
      const job = q.active.get(msg.key);
      if (w && w.attemptId === msg.attemptId) w.arm();
      if (job && job.attemptId === msg.attemptId) {
        job.loaded = msg.loaded;
        job.total = msg.total;
      }
      return {};
    }
    case 'jobFetched':
    case 'jobFetchFailed': {
      const w = fetchWaiters.get(msg.key);
      if (!w || w.attemptId !== msg.attemptId) {
        // Устаревший ответ (попытка уже отменена по таймауту) — освобождаем blob
        if (msg.blobUrl && sender.tab?.id) sendToTab(sender.tab.id, { type: 'revoke', blobUrl: msg.blobUrl });
        return {};
      }
      fetchWaiters.delete(msg.key);
      clearTimeout(w.timer);
      if (msg.type === 'jobFetched') w.resolve(msg);
      else w.reject(new Error(msg.error || 'Ошибка вкладки'));
      return {};
    }
    case 'log':
      addLog(msg.level === 'error' ? 'error' : 'info', String(msg.text || ''));
      return {};

    // --- от popup ---
    case 'getState':
      return getState();
    case 'historyStats':
      return historyStats();
    case 'saveSettings':
      settings = sanitizeSettings(msg.settings || {});
      await chrome.storage.local.set({ settings });
      pump();
      return { settings };
    case 'pause':
      q.paused = true;
      persist();
      return getState();
    case 'resume':
      q.paused = false;
      persist();
      pump();
      return getState();
    case 'cancelAll':
      cancelAll();
      return getState();
    case 'retryFailed': {
      const jobs = q.failed.splice(0);
      for (const job of jobs) {
        if (!isQueued(job.key)) q.pending.push({ ...job, attempts: 0, status: 'pending', error: undefined });
      }
      persist();
      pump();
      return getState();
    }
    case 'clearFailed':
      q.failed = [];
      persist();
      return getState();
    case 'clearLog':
      log = [];
      await chrome.storage.local.set({ log });
      return getState();
    case 'clearHistory':
      await clearHistory();
      addLog('info', 'История скачанного (дедупликация) очищена');
      return historyStats();
    default:
      return { error: 'unknown message' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handleMessage(msg, sender).then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
  return true; // ответ асинхронный
});

// Закрыли вкладку — её задания выполнить уже нельзя (данные качает именно вкладка)
chrome.tabs.onRemoved.addListener((tabId) => {
  knownTabs.delete(tabId);
  const orphaned = q.pending.filter((j) => j.tabId === tabId);
  if (orphaned.length) {
    q.pending = q.pending.filter((j) => j.tabId !== tabId);
    for (const job of orphaned) q.failed.unshift({ ...stripJob(job), error: 'Вкладка Telegram закрыта' });
    if (q.failed.length > FAILED_LIMIT) q.failed.length = FAILED_LIMIT;
    addLog('warn', `Вкладка закрыта: ${orphaned.length} заданий перенесено в «Неудачные»`);
  }
  for (const job of q.active.values()) {
    if (job.tabId === tabId) fetchWaiters.get(job.key)?.fail('Вкладка Telegram закрыта');
  }
  persist();
});
