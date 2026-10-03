/*
 * content/common.js — общие утилиты content script (изолированный мир).
 * Всё складывается в глобальный неймспейс TGDL, общий для файлов content script.
 */
(() => {
  const TGDL = (globalThis.TGDL = globalThis.TGDL || {});
  const TAG = '__tgdl';

  const util = (TGDL.util = {});

  util.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * Ждёт, пока predicate() вернёт truthy-значение, и возвращает его.
   * Бросает ошибку по таймауту.
   */
  util.waitFor = async (predicate, { timeout = 10000, interval = 100, message = 'Таймаут ожидания' } = {}) => {
    const start = Date.now();
    for (;;) {
      const value = await predicate();
      if (value) return value;
      if (Date.now() - start > timeout) throw new Error(message);
      await util.sleep(interval);
    }
  };

  /** Простая очередь-мьютекс: гарантирует последовательное выполнение fn */
  util.createMutex = () => {
    let tail = Promise.resolve();
    return (fn) => {
      const run = tail.then(fn, fn);
      tail = run.catch(() => {});
      return run;
    };
  };

  /** Клик «как пользователь»: pointer/mouse-события + click (нужно и для K, и для A) */
  util.realClick = (el) => {
    const rect = el.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      view: window,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0,
    };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  };

  util.pressEscape = () => {
    const opts = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true, cancelable: true };
    document.dispatchEvent(new KeyboardEvent('keydown', opts));
    document.dispatchEvent(new KeyboardEvent('keyup', opts));
  };

  // ---------------------------------------------------------------------------
  // Имена файлов и даты
  // ---------------------------------------------------------------------------

  const RESERVED_WIN = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

  /** Очищает одну компоненту пути для chrome.downloads (Windows-совместимо) */
  util.sanitizeName = (name, fallback = 'untitled') => {
    let s = String(name ?? '')
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
      .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/[. ]+$/, '');
    if (s.length > 80) s = s.slice(0, 80).trim();
    if (!s || /^\.+$/.test(s)) s = fallback;
    if (RESERVED_WIN.test(s)) s = '_' + s;
    return s;
  };

  const pad = (n) => String(n).padStart(2, '0');
  /** unix-время (сек) → {date: 'YYYY-MM-DD', time: 'HH-mm-ss'} в локальном часовом поясе */
  util.formatDateParts = (unix) => {
    if (!unix) return { date: 'nodate', time: '00-00-00' };
    const d = new Date(unix * 1000);
    return {
      date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
      time: `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`,
    };
  };

  // Локали, в которых может быть интерфейс Web A (язык UI Telegram может не совпадать с браузером)
  const COMMON_LOCALES = ['en', 'en-GB', 'ru', 'uk', 'be', 'kk', 'uz', 'de', 'fr', 'es', 'it', 'pt', 'pt-BR',
    'pl', 'tr', 'nl', 'id', 'ms', 'ar', 'he', 'ko', 'ja', 'zh-CN', 'zh-TW', 'ca', 'cs', 'sk', 'ro', 'hu', 'fi',
    'sv', 'nb', 'da', 'hr', 'sr', 'bg', 'el', 'vi', 'th', 'hi', 'az', 'ka', 'hy'];

  function candidateLocales() {
    return [...new Set([document.documentElement.lang, ...(navigator.languages || []), ...COMMON_LOCALES].filter(Boolean))];
  }

  // Убираем невидимые bidi-метки и приводим все виды пробелов к обычному
  const normalizeWs = (s) =>
    String(s).replace(/[\u200e\u200f\u2066-\u2069]/g, '').replace(/[\s\u00a0\u202f]+/g, ' ').trim();
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /**
   * Точные парсеры: для каждой локали строим регулярное выражение по formatToParts
   * того же формата, что использует Web A (formatDateTimeToString в util/dates/oldDateFormat.ts:
   * toLocaleString(lang, {year:'numeric', month:'short', day:'numeric', hour, minute, second, hourCycle})).
   */
  let exactParsers = null;
  function getExactParsers() {
    if (exactParsers) return exactParsers;
    exactParsers = [];
    for (const loc of candidateLocales()) {
      for (const hourCycle of ['h23', 'h12']) {
        let fmt;
        try {
          fmt = new Intl.DateTimeFormat(loc, {
            year: 'numeric', month: 'short', day: 'numeric',
            hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle,
          });
        } catch {
          continue;
        }
        const ro = fmt.resolvedOptions();
        if (ro.calendar !== 'gregory' || ro.numberingSystem !== 'latn') continue;

        const partOf = (date, type) => fmt.formatToParts(date).find((p) => p.type === type)?.value;
        const months = [];
        for (let m = 0; m < 12; m++) months.push(normalizeWs(partOf(new Date(2001, m, 15, 10), 'month') || ''));
        const periods = {};
        for (const h of [9, 21]) {
          const p = partOf(new Date(2001, 0, 15, h), 'dayPeriod');
          if (p) periods[normalizeWs(p).toLowerCase()] = h >= 12 ? 'pm' : 'am';
        }

        const groups = [];
        let src = '^';
        for (const part of fmt.formatToParts(new Date(2001, 0, 15, 9, 5, 7))) {
          switch (part.type) {
            case 'literal': {
              const lit = normalizeWs(part.value);
              src += lit ? '\\s*' + escapeRe(lit).replace(/ /g, '\\s*') + '\\s*' : '\\s*';
              break;
            }
            case 'year':
              src += '(\\d{4})';
              groups.push('year');
              break;
            case 'month':
              src += '(' + months.filter(Boolean).map(escapeRe).sort((a, b) => b.length - a.length).join('|') + ')';
              groups.push('month');
              break;
            case 'day':
            case 'hour':
            case 'minute':
            case 'second':
              src += '(\\d{1,2})';
              groups.push(part.type);
              break;
            case 'dayPeriod':
              src += '(' + Object.keys(periods).map(escapeRe).join('|') + ')';
              groups.push('dayPeriod');
              break;
            default:
              src += '.*?'; // день недели, эра и прочее — пропускаем
          }
        }
        // Якорь конца обязателен: иначе 24-часовой парсер «съест» строку с AM/PM по префиксу
        src += '\\s*$';
        exactParsers.push({ re: new RegExp(src, 'i'), groups, months: months.map((m) => m.toLowerCase()), periods });
      }
    }
    return exactParsers;
  }

  function parseExact(s) {
    for (const p of getExactParsers()) {
      const m = p.re.exec(s);
      if (!m) continue;
      const v = {};
      p.groups.forEach((g, i) => (v[g] = m[i + 1]));
      const month = p.months.indexOf(String(v.month).toLowerCase());
      if (month < 0) continue;
      let hour = +v.hour;
      if (v.dayPeriod) {
        const period = p.periods[v.dayPeriod.toLowerCase()];
        if (period === 'pm' && hour < 12) hour += 12;
        if (period === 'am' && hour === 12) hour = 0;
      }
      const d = new Date(+v.year, month, +v.day, hour, +v.minute, +(v.second || 0));
      if (!Number.isNaN(d.getTime())) return Math.floor(d.getTime() / 1000);
    }
    return null;
  }

  // Названия месяцев во всех вероятных локалях — для разбора даты из title в Web A
  let monthTable = null;
  function getMonthTable() {
    if (monthTable) return monthTable;
    const locales = new Set(
      candidateLocales(),
    );
    const norm = (s) => s.toLowerCase().replace(/[.\u200e\u200f]/g, '').trim();
    monthTable = [];
    for (const loc of locales) {
      for (const month of ['short', 'long']) {
        let fmtAlone;
        let fmtWithDay;
        try {
          fmtAlone = new Intl.DateTimeFormat(loc, { month });
          fmtWithDay = new Intl.DateTimeFormat(loc, { month, day: 'numeric' });
        } catch {
          continue;
        }
        for (let m = 0; m < 12; m++) {
          const date = new Date(2001, m, 15);
          const names = [fmtAlone.format(date)];
          const part = fmtWithDay.formatToParts(date).find((p) => p.type === 'month');
          if (part) names.push(part.value); // родительный падеж: «окт.», «октября»
          for (const n of names) {
            const v = norm(n);
            if (v && !/^\d+$/.test(v)) monthTable.push([v, m]);
          }
        }
      }
    }
    // Сначала длинные названия, чтобы «июня» не совпало с «июн» раньше времени
    monthTable.sort((a, b) => b[0].length - a[0].length);
    return monthTable;
  }

  /** Запасной эвристический разбор (если ни один точный парсер не подошёл) */
  function parseHeuristic(input) {
    let s = String(input).replace(/[\u200e\u200f\u202f\u00a0]/g, ' ');
    // В title могут быть несколько дат (редактирование/пересылка) — берём первую строку
    s = s.split('\n')[0];

    // Время: последнее вхождение HH:MM(:SS)
    const timeRe = /(\d{1,2}):(\d{2})(?::(\d{2}))?/g;
    let tm;
    let lastTime = null;
    while ((tm = timeRe.exec(s))) lastTime = tm;
    let hours = 0;
    let minutes = 0;
    let seconds = 0;
    if (lastTime) {
      hours = +lastTime[1];
      minutes = +lastTime[2];
      seconds = +(lastTime[3] || 0);
      const tail = s.slice(lastTime.index);
      const pm = /\b(pm|p\s?\.?\s?m\.?)/i.test(tail);
      const am = /\b(am|a\s?\.?\s?m\.?)/i.test(tail);
      if (pm && hours < 12) hours += 12;
      if (am && hours === 12) hours = 0;
      s = s.slice(0, lastTime.index);
    }

    // Год
    const yearMatch = /(\d{4})/.exec(s);
    const year = yearMatch ? +yearMatch[1] : new Date().getFullYear();
    if (yearMatch) s = s.replace(yearMatch[1], ' ');

    // Месяц: число с 月/월 (CJK) или название
    let month = null;
    const cjk = /(\d{1,2})\s*[月월]/.exec(s);
    if (cjk) {
      month = +cjk[1] - 1;
      s = s.replace(cjk[0], ' ');
    } else {
      const lower = s.toLowerCase().replace(/[.\u200e\u200f]/g, '');
      for (const [name, m] of getMonthTable()) {
        if (lower.includes(name)) {
          month = m;
          break;
        }
      }
    }

    const dayMatch = /(\d{1,2})/.exec(s);
    if (month === null || !dayMatch) return null;
    const day = +dayMatch[1];

    const d = new Date(year, month, day, hours, minutes, seconds);
    return Number.isNaN(d.getTime()) ? null : Math.floor(d.getTime() / 1000);
  }

  /**
   * Разбор локализованной даты из title у .message-time в Web A, например
   * "Oct 3, 2025, 14:22:01" / "3 окт. 2025 г., 14:22:01" / "2025年10月3日 午後2:22:01".
   * В title может быть несколько строк (редактирование/пересылка) — берём первую.
   * Возвращает unix-время (сек) или null.
   */
  util.parseLocalizedDateTime = (input) => {
    if (!input) return null;
    const s = normalizeWs(String(input).split('\n')[0]);
    return parseExact(s) ?? parseHeuristic(s);
  };

  /** Нормализованный ключ чата, общий для K и A (чтобы дедупликация работала между клиентами) */
  util.normalizePeerKey = (raw) => {
    if (raw === null || raw === undefined || raw === '') return null;
    const s = String(raw).trim();
    if (/^-100\d+$/.test(s)) return 'c' + s.slice(4); // Web A: id канала/супергруппы
    if (/^-\d+$/.test(s)) return 'c' + s.slice(1); // Web K: peerId = -chatId
    if (/^\d+$/.test(s)) return 'u' + s;
    if (s.startsWith('@')) return 'n:' + s.slice(1).toLowerCase();
    return 's:' + s;
  };

  // ---------------------------------------------------------------------------
  // RPC с page/bridge.js (MAIN world) через window.postMessage
  // ---------------------------------------------------------------------------

  const pending = new Map();
  let seq = 0;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || !d[TAG]) return;
    if (d[TAG] === 'res') {
      const p = pending.get(d.id);
      if (!p) return;
      pending.delete(d.id);
      clearTimeout(p.timer);
      if (d.ok) p.resolve(d.result);
      else p.reject(new Error(d.error || 'Ошибка bridge'));
    } else if (d[TAG] === 'progress') {
      pending.get(d.id)?.onProgress?.(d.loaded, d.total);
    }
  });

  const bridge = (TGDL.bridge = {});

  /**
   * Вызов метода bridge. Возвращает промис; reqId доступен через opts.onStart(reqId)
   * (нужен для отмены). timeout — без активности (прогресс сбрасывает таймер).
   */
  bridge.call = (method, args = {}, { onProgress, onStart, timeout = 120000 } = {}) =>
    new Promise((resolve, reject) => {
      const id = `r${++seq}_${Math.random().toString(36).slice(2, 8)}`;
      const entry = { resolve, reject, timer: null };
      const arm = () => {
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Bridge: нет ответа на ${method} (${Math.round(timeout / 1000)} с)`));
        }, timeout);
      };
      entry.onProgress = (loaded, total) => {
        arm();
        onProgress?.(loaded, total);
      };
      pending.set(id, entry);
      arm();
      onStart?.(id);
      window.postMessage({ [TAG]: 'req', id, method, args }, location.origin);
    });

  /** Ждём готовности bridge (он стартует в document_start, но мог не успеть) */
  bridge.ready = (async () => {
    for (let i = 0; i < 50; i++) {
      try {
        await bridge.call('ping', {}, { timeout: 500 });
        return true;
      } catch {
        await util.sleep(200);
      }
    }
    console.warn('[TGDL] page bridge не отвечает');
    return false;
  })();

  // ---------------------------------------------------------------------------
  // Связь с background
  // ---------------------------------------------------------------------------

  util.sendBg = async (message) => {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (e) {
      const text = String(e?.message || e);
      if (text.includes('context invalidated')) {
        TGDL.ui?.notify?.('Расширение было перезагружено — обновите вкладку (F5)', 'error');
      }
      throw e;
    }
  };

  // ---------------------------------------------------------------------------
  // Общий захват источника через медиавьюер (используется Web A и как запасной путь в Web K)
  // ---------------------------------------------------------------------------

  /**
   * Открывает медиавьюер кликом по элементу, ждёт полноразмерное медиа и закрывает вьюер.
   * cfg:
   *   viewer        — селектор корня открытого вьюера
   *   image, video  — селекторы активного img/video во вьюере
   *   readSrc(sel)  — async-функция чтения src (через bridge в K, напрямую в A)
   *   close()       — закрытие вьюера
   *   isVideo       — что ждём
   * Возвращает source для bridge.fetchSource.
   */
  util.captureViaViewer = async (el, cfg) => {
    const viewerOpen = () => document.querySelector(cfg.viewer);

    if (viewerOpen()) {
      cfg.close();
      await util.waitFor(() => !viewerOpen(), { timeout: 4000 }).catch(() => {});
    }

    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    await util.sleep(150);
    util.realClick(el);
    try {
      await util.waitFor(viewerOpen, { timeout: 2500 });
    } catch {
      // Медиа под спойлером: первый клик снимает спойлер, второй открывает вьюер
      util.realClick(el);
      await util.waitFor(viewerOpen, { timeout: 5000, message: 'Медиавьюер не открылся' });
    }

    try {
      if (cfg.isVideo) {
        const info = await util.waitFor(
          async () => {
            const r = await cfg.readSrc(cfg.video);
            return r?.src && !r.src.startsWith('data:') ? r : null;
          },
          { timeout: 20000, interval: 200, message: 'Во вьюере не появился src видео' },
        );
        const src = info.src;
        return src.startsWith('blob:') ? { kind: 'blob', url: src } : { kind: 'stream', url: src };
      }

      // Фото: сначала вьюер показывает превью, затем подменяет src на полноразмерное.
      // Ждём, пока src перестанет меняться (и изображение загрузится), максимум 20 с.
      let lastSrc = null;
      let stableSince = 0;
      const STABLE_MS = 2000;
      const BIG = 1000; // превью в A — size=x (≤800 px); всё, что больше, — точно полноразмерное
      const info = await util.waitFor(
        async () => {
          const r = await cfg.readSrc(cfg.image);
          if (!r?.src || !r.complete || !r.naturalWidth) return null;
          if (r.src !== lastSrc) {
            lastSrc = r.src;
            stableSince = Date.now();
          }
          if (r.naturalWidth > BIG || r.naturalHeight > BIG) return r;
          return Date.now() - stableSince >= STABLE_MS ? r : null;
        },
        { timeout: 20000, interval: 200, message: 'Во вьюере не загрузилось фото' },
      );
      return { kind: 'blob', url: info.src };
    } finally {
      cfg.close();
      await util.waitFor(() => !viewerOpen(), { timeout: 4000 }).catch(() => {});
      await util.sleep(200);
    }
  };
})();
