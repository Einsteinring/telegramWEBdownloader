/*
 * Селекторы DOM для Telegram Web K (web.telegram.org/k, репозиторий morethanwords/tweb).
 * Если после обновления Telegram что-то перестало находиться — правьте только этот файл.
 */
(() => {
  const TGDL = (globalThis.TGDL = globalThis.TGDL || {});
  TGDL.selectors = TGDL.selectors || {};

  TGDL.selectors.k = {
    // Прокручиваемый контейнер ленты открытого чата (ChatBubbles.scrollable.container)
    scrollContainer: '.chat.active .bubbles .scrollable-y, .chat.active .bubbles > .scrollable',
    // Корень открытого чата (для MutationObserver)
    chatRoot: '.chat.active .bubbles',
    // Заголовок чата в верхней панели
    chatTitle: '.chat.active .chat-info .peer-title, .sidebar-header .chat-info .peer-title',

    // Пузырь сообщения: data-mid — id сообщения, data-timestamp — unix-время
    bubble: '.bubble[data-mid]',
    // Служебные/рекламные пузыри пропускаем
    bubbleSkip: '.service, .is-sponsored, .is-outgoing.is-sending',
    // Элемент альбома (свой data-mid у каждого фото/видео)
    albumItem: '.album-item[data-mid]',
    // Контейнер вложения одиночного медиа
    attachment: '.attachment',
    // Признаки фото/видео внутри вложения
    photo: '.media-photo',
    video: '.media-video, video, .video-time, .video-play',
    // Это не наши медиа: стикеры, кружочки, превью ссылок
    notMedia: '.media-sticker, .media-round, .web, .webpage, .document-container, .audio',

    // Признак запрета пересылки/сохранения (класс ставится в bubbles.ts: canForward === false)
    protectedBubble: '.no-forwards',

    // Медиавьюер (запасной способ, если внутренний API недоступен)
    viewer: '.media-viewer-whole.active',
    viewerVideo: '.media-viewer-whole.active .media-viewer-mover:not(.hiding) video',
    viewerImage: '.media-viewer-whole.active .media-viewer-mover:not(.hiding) img:not(.thumbnail)',
    // Последняя кнопка в .media-viewer-buttons — «закрыть» (base.ts: [..., 'download', 'rotate', 'zoomin', 'close'])
    viewerClose: '.media-viewer-whole.active .media-viewer-buttons > .btn-icon:last-child',
  };
})();
