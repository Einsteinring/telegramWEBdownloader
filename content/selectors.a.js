/*
 * Селекторы DOM для Telegram Web A (web.telegram.org/a, репозиторий Ajaxy/telegram-tt).
 * Если после обновления Telegram что-то перестало находиться — правьте только этот файл.
 */
(() => {
  const TGDL = (globalThis.TGDL = globalThis.TGDL || {});
  TGDL.selectors = TGDL.selectors || {};

  TGDL.selectors.a = {
    // Прокручиваемый список сообщений
    scrollContainer: '.MessageList',
    chatRoot: '.MessageList',
    // Заголовок чата в шапке
    chatTitle: '.MiddleHeader .ChatInfo .fullName, .MiddleHeader .fullName',

    // Сообщение: data-message-id — id сообщения (для альбома — id «главного» сообщения)
    message: '.Message[data-message-id]',
    messageSkip: '.is-sponsored, .SponsoredMessage',
    // Элемент альбома: у каждого свой id="album-media-message-<id>"
    albumMedia: '.Album [id^="album-media-message-"]',
    albumIdPrefix: 'album-media-message-',
    // Одиночное фото/видео в сообщении
    singleMedia: '.message-content .media-inner',
    // Медиа внутри превью ссылок и прочие не-наши случаи
    notMedia: '.WebPage, .RoundVideo, .sticker, .Album',
    // Признаки видео внутри .media-inner
    videoMarker: '.message-media-duration, video, .icon-play',

    // Время сообщения: title заполняется по mouseenter (MessageMeta.tsx, лениво)
    messageTime: '.message-time',
    // Защита контента: прозрачный перекрывающий элемент
    protector: '.protector',

    // Медиавьюер
    viewer: '#MediaViewer',
    viewerActiveImage: '#MediaViewer .MediaViewerSlide--active .MediaViewerContent img',
    viewerActiveVideo: '#MediaViewer .MediaViewerSlide--active .MediaViewerContent video[src]',
  };
})();
