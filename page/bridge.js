/*
 * page/bridge.js — скрипт, работающий в контексте страницы (world: "MAIN").
 *
 * Зачем он нужен:
 *  - fetch() отсюда идёт от имени страницы web.telegram.org, поэтому его перехватывает
 *    service worker Telegram Web (маршруты /k/stream/..., /a/progressive/...);
 *  - отсюда видны внутренние объекты Web K (window.appImManager) и переопределённый
 *    геттер video.src (в K он возвращает "stream/..." или "hls/...", а не blob MediaSource);
 *  - blob:-URL, созданные здесь, принадлежат origin страницы и доступны content script'у.
 *
 * Связь с content script — через window.postMessage с меткой __tgdl.
 * Никаких внешних запросов: только относительные URL того же origin.
 */
(() => {
  'use strict';

  if (window.__tgdlBridgeLoaded) return;
  window.__tgdlBridgeLoaded = true;

  const TAG = '__tgdl';
  const VERSION = 1;

  // Повторы одного чанка внутри Range-сборки (помимо повторов всей задачи в background)
  const CHUNK_RETRIES = 3;
  const PROGRESS_THROTTLE_MS = 500;

  /** reqId -> AbortController — для отмены долгих загрузок */
  const controllers = new Map();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function post(data) {
    window.postMessage({ [TAG]: data.kind, ...data }, location.origin);
  }

  function reply(id, ok, payload) {
    post({ kind: 'res', id, ok, ...payload });
  }

  function makeProgress(id) {
    let last = 0;
    return (loaded, total, force) => {
      const now = Date.now();
      if (!force && now - last < PROGRESS_THROTTLE_MS) return;
      last = now;
      post({ kind: 'progress', id, loaded, total });
    };
  }

  // ---------------------------------------------------------------------------
  // Сборка файла через Range-запросы к service worker
  // ---------------------------------------------------------------------------

  /** Разбор заголовка "Content-Range: bytes START-END/TOTAL" */
  function parseContentRange(value) {
    const m = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/i.exec(value || '');
    if (!m) return null;
    return { start: +m[1], end: +m[2], total: m[3] === '*' ? null : +m[3] };
  }

  /**
   * Скачивает файл целиком, запрашивая "bytes=OFFSET-" в цикле.
   * SW Telegram отдаёт за раз 512 КБ–1 МБ, поэтому собираем чанки в массив Blob'ов
   * (Chrome держит крупные Blob'ы на диске, так что память не раздувается так сильно,
   * как с ArrayBuffer).
   * ВАЖНО: никогда не запрашиваем "bytes=0-1" — и K, и A отвечают на него
   * фиктивными двумя нулевыми байтами (хак для Safari).
   */
  async function fetchRanged(url, signal, onProgress) {
    const abs = new URL(url, location.href).href;
    const parts = [];
    let offset = 0;
    let total = null;
    let mime = '';

    for (;;) {
      let res;
      let lastError;
      for (let attempt = 0; attempt <= CHUNK_RETRIES; attempt++) {
        if (signal.aborted) throw new Error('Отменено');
        try {
          res = await fetch(abs, {
            headers: { Range: `bytes=${offset}-` },
            credentials: 'same-origin',
            cache: 'no-store',
            signal,
          });
          if (res.status === 200 || res.status === 206) break;
          lastError = new Error(`HTTP ${res.status} на смещении ${offset}`);
          res = null;
        } catch (e) {
          if (signal.aborted) throw new Error('Отменено');
          lastError = e;
          res = null;
        }
        await sleep(1000 * 2 ** attempt);
      }
      if (!res) throw lastError || new Error('Не удалось получить чанк');

      if (!mime) mime = (res.headers.get('Content-Type') || '').split(';')[0].trim();

      // Сервер отдал файл целиком без Range — просто возвращаем его
      if (res.status === 200) {
        const blob = await res.blob();
        onProgress(blob.size, blob.size, true);
        return { blob, mime: mime || blob.type };
      }

      const range = parseContentRange(res.headers.get('Content-Range'));
      const chunk = await res.blob();
      if (!range) throw new Error('Нет заголовка Content-Range в ответе 206');
      if (range.start !== offset) {
        throw new Error(`Сдвиг чанка: ожидали ${offset}, получили ${range.start}`);
      }
      if (chunk.size === 0) {
        // Пустой чанк при неизвестном размере — считаем, что файл закончился
        if (total === null) break;
        throw new Error(`Пустой чанк на смещении ${offset}`);
      }

      parts.push(chunk);
      offset += chunk.size;
      if (range.total !== null) total = range.total;
      onProgress(offset, total);

      if (total !== null && offset >= total) break;
    }

    onProgress(offset, total ?? offset, true);
    return { blob: new Blob(parts, { type: mime || 'application/octet-stream' }), mime };
  }

  /** Копирует существующий blob:-URL страницы в собственный Blob (страница может его отозвать) */
  async function fetchBlobUrl(url, signal, onProgress) {
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`Не удалось прочитать ${url.slice(0, 40)}…: HTTP ${res.status}`);
    const blob = await res.blob();
    onProgress(blob.size, blob.size, true);
    return { blob, mime: blob.type };
  }

  // ---------------------------------------------------------------------------
  // Внутренний API Web K (tweb). window.appImManager монтируется всегда
  // (MOUNT_CLASS_TO = DEBUG || true в src/config/debug.ts).
  // ---------------------------------------------------------------------------

  function kManagers() {
    const m = window.appImManager?.managers;
    if (!m?.appMessagesManager || !m?.apiFileManager) {
      throw new Error('Внутренний API Web K недоступен (window.appImManager.managers)');
    }
    return m;
  }

  function kCurrentPeerId() {
    return window.appImManager?.chat?.peerId ?? null;
  }

  /** Самый большой PhotoSize фотографии (photoSize / photoSizeProgressive) */
  function kLargestPhotoSize(photo) {
    const sizes = (photo?.sizes || []).filter(
      (s) => (s._ === 'photoSize' || s._ === 'photoSizeProgressive') && s.w && s.h,
    );
    sizes.sort((a, b) => a.w * a.h - b.w * b.h);
    return sizes[sizes.length - 1] || null;
  }

  /** URL стрима оригинального документа — тот же формат, что getFileURL('stream', ...) в tweb */
  function kDocStreamUrl(doc) {
    const options = {
      dcId: doc.dc_id,
      location: {
        _: 'inputDocumentFileLocation',
        id: doc.id,
        access_hash: doc.access_hash,
        file_reference: doc.file_reference,
      },
      size: doc.size,
      mimeType: doc.mime_type,
      fileName: doc.file_name,
    };
    return 'stream/' + encodeURIComponent(JSON.stringify(options));
  }

  async function kGetMessage(peerId, mid) {
    const managers = kManagers();
    const msg = await managers.appMessagesManager.getMessageByPeer(peerId, mid);
    if (!msg) throw new Error(`Сообщение ${mid} не найдено в кэше Web K — прокрутите ленту к нему`);
    return msg;
  }

  /** Описание медиа сообщения: тип, mime, дата, что качать */
  function kDescribe(msg) {
    const media = msg.media;
    if (media?._ === 'messageMediaPhoto' && media.photo?._ === 'photo') {
      const size = kLargestPhotoSize(media.photo);
      if (!size) throw new Error('У фото нет доступных размеров');
      return { type: 'photo', mime: 'image/jpeg', date: msg.date, photo: media.photo, size };
    }
    if (media?._ === 'messageMediaDocument' && media.document?._ === 'document') {
      const doc = media.document;
      const mime = doc.mime_type || '';
      const isVideo = ['video', 'gif', 'round'].includes(doc.type) || mime.startsWith('video/');
      const isImage = mime.startsWith('image/') && doc.type !== 'sticker';
      if (!isVideo && !isImage) throw new Error(`Неподдерживаемый тип документа: ${doc.type || mime}`);
      return {
        type: isVideo ? (doc.type === 'gif' ? 'gif' : 'video') : 'photo',
        mime,
        date: msg.date,
        doc,
        size: doc.size,
      };
    }
    throw new Error(`В сообщении нет фото/видео (${media?._ || 'пусто'})`);
  }

  async function kFetchMessageMedia(peerId, mid, signal, onProgress) {
    peerId = peerId ?? kCurrentPeerId();
    const msg = await kGetMessage(peerId, mid);
    const d = kDescribe(msg);

    if (d.photo) {
      // Скачиваем самый большой размер через apiFileManager (возвращает Blob из воркера)
      const result = await kManagers().apiFileManager.downloadMedia({ media: d.photo, thumb: d.size });
      if (signal.aborted) throw new Error('Отменено');
      const blob = result instanceof Blob ? result : new Blob([result], { type: d.mime });
      onProgress(blob.size, blob.size, true);
      return { blob, mime: blob.type || d.mime };
    }

    const res = await fetchRanged(kDocStreamUrl(d.doc), signal, onProgress);
    return { blob: res.blob, mime: d.mime || res.mime };
  }

  // ---------------------------------------------------------------------------
  // Методы RPC
  // ---------------------------------------------------------------------------

  const methods = {
    ping() {
      return { version: VERSION };
    },

    /** Информация о текущем чате Web K из внутреннего состояния */
    kChatInfo() {
      const chat = window.appImManager?.chat;
      return {
        available: !!window.appImManager?.managers,
        peerId: chat?.peerId ?? null,
      };
    },

    /** Тип/дата медиа сообщения Web K (без скачивания) */
    async kInspect({ peerId, mid }) {
      const msg = await kGetMessage(peerId ?? kCurrentPeerId(), mid);
      const d = kDescribe(msg);
      return { type: d.type, mime: d.mime, date: d.date, size: d.size?.size ?? d.size ?? null };
    },

    /**
     * Читает src медиа-элемента через геттер страницы.
     * В Web K геттер video.src переопределён (createVideo.ts) и отдаёт "stream/..." / "hls/...".
     */
    readMediaSrc({ selector }) {
      const el = document.querySelector(selector);
      if (!el) return { src: null };
      const src = el.tagName === 'IMG' ? el.currentSrc || el.src : el.src;
      return {
        src: src || null,
        naturalWidth: el.naturalWidth || el.videoWidth || 0,
        naturalHeight: el.naturalHeight || el.videoHeight || 0,
        complete: el.tagName === 'IMG' ? el.complete : el.readyState > 0,
      };
    },

    /**
     * Главный метод: скачать источник и вернуть blob:-URL.
     * source.kind:
     *   'k-msg'  — {peerId, mid}: через внутренний API Web K
     *   'stream' — {url}: Range-сборка через service worker (K stream/, A progressive/)
     *   'blob'   — {url}: копия существующего blob:-URL страницы
     */
    async fetchSource({ source }, ctx) {
      let result;
      if (source.kind === 'k-msg') {
        result = await kFetchMessageMedia(source.peerId, source.mid, ctx.signal, ctx.progress);
      } else if (source.kind === 'stream') {
        // В K "hls/<опции оригинала>" — тот же документ; stream/ отдаёт исходный файл
        const url = source.url.replace(/(^|\/)hls\//, '$1stream/');
        result = await fetchRanged(url, ctx.signal, ctx.progress);
      } else if (source.kind === 'blob') {
        result = await fetchBlobUrl(source.url, ctx.signal, ctx.progress);
      } else {
        throw new Error(`Неизвестный тип источника: ${source.kind}`);
      }
      const blobUrl = URL.createObjectURL(result.blob);
      return { blobUrl, size: result.blob.size, mime: result.mime || result.blob.type || '' };
    },

    abort({ reqId }) {
      controllers.get(reqId)?.abort();
      return {};
    },

    revoke({ blobUrl }) {
      if (typeof blobUrl === 'string' && blobUrl.startsWith('blob:')) URL.revokeObjectURL(blobUrl);
      return {};
    },
  };

  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data[TAG] !== 'req') return;

    const { id, method, args } = data;
    const fn = methods[method];
    if (!fn) {
      reply(id, false, { error: `Нет метода ${method}` });
      return;
    }

    const controller = new AbortController();
    controllers.set(id, controller);
    try {
      const result = await fn(args || {}, { signal: controller.signal, progress: makeProgress(id) });
      reply(id, true, { result });
    } catch (e) {
      reply(id, false, { error: String(e?.message || e) });
    } finally {
      controllers.delete(id);
    }
  });

  post({ kind: 'ready', version: VERSION });
})();
