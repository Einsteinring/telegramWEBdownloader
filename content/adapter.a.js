/*
 * Адаптер Telegram Web A.
 *
 * В продакшен-сборке Web A состояние приложения недоступно со страницы
 * (window.getGlobal определяется только при DEBUG), поэтому ID документа и
 * полноразмерное фото можно получить только из DOM медиавьюера:
 *  - видео: <video src=".../a/progressive/document<ID>"> → Range-сборка через service worker;
 *  - фото: <img src="blob:..."> с размером photo<ID> без суффикса size (максимальный).
 * Поэтому source получаем при постановке в очередь, пока элемент сообщения есть в DOM,
 * а сам вьюер будет кратко открываться и закрываться для каждого медиа.
 *
 * Исключение: автовоспроизводимые в ленте видео уже имеют progressive src — вьюер не нужен.
 */
(() => {
  const TGDL = globalThis.TGDL;
  const { util } = TGDL;
  const sel = TGDL.selectors.a;

  function detectType(el) {
    return el.querySelector(sel.videoMarker) ? 'video' : 'photo';
  }

  /** Чтение src напрямую (в Web A геттеры не переопределены, DOM общий с изолированным миром) */
  async function readSrc(selector) {
    const el = document.querySelector(selector);
    if (!el) return null;
    const src = el.tagName === 'IMG' ? el.currentSrc || el.src : el.currentSrc || el.getAttribute('src');
    return {
      src: src ? new URL(src, location.href).href : null,
      naturalWidth: el.naturalWidth || el.videoWidth || 0,
      naturalHeight: el.naturalHeight || el.videoHeight || 0,
      complete: el.tagName === 'IMG' ? el.complete : true,
    };
  }

  const adapter = {
    id: 'a',
    sel,

    isChatOpen() {
      return !!document.querySelector(sel.chatRoot);
    },

    getChatRoot() {
      return document.querySelector(sel.chatRoot);
    },

    getScrollContainer() {
      return document.querySelector(sel.scrollContainer);
    },

    async getChatInfo() {
      const title = document.querySelector(sel.chatTitle)?.textContent?.trim() || 'Telegram';
      // URL Web A: /a/#-1001234567890 (chatId), возможно с "_threadId"
      const hash = decodeURIComponent(location.hash.replace(/^#/, '')).split(/[?_]/)[0];
      const peerKey = util.normalizePeerKey(hash) || 's:' + title;
      return { peerKey, title, peerId: hash || null };
    },

    scanItems() {
      const root = this.getChatRoot();
      if (!root) return [];
      const items = [];

      for (const msgEl of root.querySelectorAll(sel.message)) {
        if (msgEl.matches(sel.messageSkip)) continue;
        const mainId = +msgEl.dataset.messageId;
        if (!mainId) continue;
        const isProtected = !!msgEl.querySelector(sel.protector);

        const albumEls = msgEl.querySelectorAll(sel.albumMedia);
        if (albumEls.length) {
          for (const el of albumEls) {
            // "album-media-message-123"; у платных медиа есть суффикс "-<index>" — их пропускаем
            const rest = el.id.slice(sel.albumIdPrefix.length);
            if (!/^\d+$/.test(rest)) continue;
            items.push({ rawMid: +rest, mid: +rest, type: detectType(el), date: null, protected: isProtected, el, msgEl });
          }
          continue;
        }

        const media = [...msgEl.querySelectorAll(sel.singleMedia)].find((el) => !el.closest(sel.notMedia));
        if (media) {
          items.push({ rawMid: mainId, mid: mainId, type: detectType(media), date: null, protected: isProtected, el: media, msgEl });
        }
      }
      return items;
    },

    /**
     * Дата в Web A есть только в title у .message-time, причём он заполняется
     * лениво по mouseenter — эмулируем наведение и разбираем локализованную строку.
     */
    async ensureDate(item) {
      if (item.date) return item.date;
      const timeEl = item.msgEl?.querySelector(sel.messageTime);
      if (!timeEl) return null;
      if (!timeEl.title) {
        timeEl.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
        await util.waitFor(() => timeEl.title, { timeout: 1500, interval: 50 }).catch(() => {});
      }
      item.date = util.parseLocalizedDateTime(timeEl.title);
      if (!item.date) console.warn('[TGDL] Web A: не удалось разобрать дату', timeEl.title);
      return item.date;
    },

    async resolveSource(item) {
      if (!item.el?.isConnected) throw new Error('Элемент сообщения пропал из DOM — прокрутите к нему');

      // Видео, уже проигрываемое в ленте, имеет progressive src оригинального документа
      if (item.type === 'video') {
        const inline = item.el.querySelector('video.full-media[src*="/progressive/"]');
        if (inline) return { kind: 'stream', url: new URL(inline.getAttribute('src'), location.href).href };
      }

      return util.captureViaViewer(item.el, {
        viewer: sel.viewer,
        image: sel.viewerActiveImage,
        video: sel.viewerActiveVideo,
        isVideo: item.type === 'video',
        readSrc,
        close: () => util.pressEscape(),
      });
    },
  };

  TGDL.adapters = TGDL.adapters || {};
  TGDL.adapters.a = adapter;
})();
