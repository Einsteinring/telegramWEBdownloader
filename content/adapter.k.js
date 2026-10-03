/*
 * Адаптер Telegram Web K.
 *
 * Основной путь: внутренний API (window.appImManager.managers) через bridge —
 *  - фото: самый большой PhotoSize через apiFileManager.downloadMedia();
 *  - видео: оригинальный документ через /k/stream/<DownloadOptions> с Range-сборкой.
 * Медиавьюер для этого не нужен, а элемент сообщения не обязан оставаться в DOM.
 *
 * Запасной путь (если внутренний API изменился): открыть медиавьюер и взять src оттуда.
 * В этом случае фото будет в том размере, который выбрал вьюер под ваш экран.
 *
 * Общий интерфейс адаптера:
 *   id, sel
 *   isChatOpen(), getScrollContainer(), getChatRoot()
 *   getChatInfo()              -> {peerKey, title, peerId}
 *   scanItems()                -> [{mid, rawMid, type, date, protected, el}]
 *   ensureDate(item)           -> дата (если не известна сразу)
 *   resolveSource(item, chat)  -> source для bridge.fetchSource (вызывается при постановке
 *                                 в очередь, пока элемент ещё есть в DOM)
 */
(() => {
  const TGDL = globalThis.TGDL;
  const { util, bridge } = TGDL;
  const sel = TGDL.selectors.k;

  const SERVER_ID_MOD = 2 ** 32; // MESSAGE_ID_OFFSET в tweb: локальные mid >= 2^32

  let internalApi = null; // кэш результата проверки внутреннего API

  async function hasInternalApi() {
    if (internalApi !== null) return internalApi;
    try {
      await bridge.ready;
      const info = await bridge.call('kChatInfo', {}, { timeout: 3000 });
      internalApi = !!info.available;
    } catch {
      internalApi = false;
    }
    if (!internalApi) console.warn('[TGDL] Web K: внутренний API недоступен, используется медиавьюер');
    return internalApi;
  }

  function detectType(el) {
    if (el.querySelector(sel.notMedia)) return null;
    if (el.querySelector(sel.video)) return 'video';
    if (el.querySelector(sel.photo)) return 'photo';
    return null;
  }

  const adapter = {
    id: 'k',
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
      let peerId = null;
      if (await hasInternalApi()) {
        try {
          peerId = (await bridge.call('kChatInfo', {}, { timeout: 3000 })).peerId;
        } catch {
          /* ниже — запасной вариант по URL */
        }
      }
      // URL Web K: /k/#-1234567890 (peerId) или /k/#@username
      const hash = decodeURIComponent(location.hash.replace(/^#/, '')).split('?')[0];
      const peerKey = util.normalizePeerKey(peerId ?? hash) || 's:' + title;
      return { peerKey, title, peerId };
    },

    scanItems() {
      const root = this.getChatRoot();
      if (!root) return [];
      const items = [];

      for (const bubble of root.querySelectorAll(sel.bubble)) {
        if (bubble.matches(sel.bubbleSkip)) continue;
        const date = +bubble.dataset.timestamp || null;
        const isProtected = bubble.matches(sel.protectedBubble);

        const push = (el, rawMid) => {
          const type = detectType(el);
          if (!type || !rawMid) return;
          items.push({
            rawMid,
            mid: rawMid >= SERVER_ID_MOD ? rawMid % SERVER_ID_MOD : rawMid,
            type,
            date,
            protected: isProtected,
            el,
          });
        };

        const albumItems = bubble.querySelectorAll(sel.albumItem);
        if (albumItems.length) {
          albumItems.forEach((item) => push(item, +item.dataset.mid));
          continue;
        }
        const attachment = bubble.querySelector(sel.attachment);
        if (attachment) push(attachment, +bubble.dataset.mid);
      }
      return items;
    },

    async ensureDate(item) {
      if (item.date) return item.date;
      if (await hasInternalApi()) {
        try {
          const info = await bridge.call('kInspect', { mid: item.rawMid }, { timeout: 5000 });
          item.date = info.date || null;
        } catch {
          /* дата останется неизвестной */
        }
      }
      return item.date;
    },

    async resolveSource(item, chat) {
      if (await hasInternalApi()) {
        return { kind: 'k-msg', peerId: chat.peerId, mid: item.rawMid };
      }
      if (!item.el?.isConnected) throw new Error('Элемент сообщения пропал из DOM — прокрутите к нему');
      const target = item.el.querySelector('.media-photo, .media-video, video, img') || item.el;
      return util.captureViaViewer(target, {
        viewer: sel.viewer,
        image: sel.viewerImage,
        video: sel.viewerVideo,
        isVideo: item.type === 'video',
        // В K геттер video.src переопределён — читаем через MAIN world
        readSrc: (selector) => bridge.call('readMediaSrc', { selector }, { timeout: 3000 }),
        close: () => {
          const btn = document.querySelector(sel.viewerClose);
          if (btn) util.realClick(btn);
          else util.pressEscape();
        },
      });
    },
  };

  // Прогреваем проверку внутреннего API заранее
  hasInternalApi();

  TGDL.adapters = TGDL.adapters || {};
  TGDL.adapters.k = adapter;
})();
