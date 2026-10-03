/*
 * content/ui.js — элементы интерфейса внутри Telegram Web:
 *  - оверлей с кнопкой «Скачать» и чекбоксом на каждом медиа;
 *  - плавающая панель (режим выбора, «Скачать выбранное», «Скачать всё», стоп);
 *  - всплывающие уведомления.
 * Логики загрузки здесь нет — только DOM и колбэки из main.js.
 */
(() => {
  const TGDL = globalThis.TGDL;
  const ui = (TGDL.ui = {});

  const LABELS = {
    idle: '⬇',
    resolving: '…',
    queued: '⏳',
    active: '0%',
    done: '✓',
    error: '⚠',
  };

  // События, которые не должны доходить до обработчиков Telegram (иначе откроется вьюер)
  const BLOCKED_EVENTS = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu', 'touchstart', 'touchend'];
  function shield(el) {
    for (const type of BLOCKED_EVENTS) {
      el.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type !== 'pointerdown' && type !== 'touchstart') e.preventDefault();
      });
    }
  }

  let toastTimer = null;
  ui.notify = (text, level = 'info', ms = 4000) => {
    let toast = document.querySelector('.tgdl-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'tgdl-toast';
      document.body.append(toast);
    }
    toast.textContent = text;
    toast.classList.toggle('tgdl-error', level === 'error');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.remove(), ms);
  };

  /**
   * Создаёт (или обновляет) оверлей внутри элемента медиа.
   * handlers.onDownload(key), handlers.onToggle(key)
   */
  ui.ensureOverlay = (el, key, handlers) => {
    let overlay = el.querySelector(':scope > .tgdl-overlay');
    if (!overlay) {
      // position: relative только для static-элементов: элементы альбома в K позиционированы absolute
      if (getComputedStyle(el).position === 'static') el.classList.add('tgdl-host-rel');
      el.classList.add('tgdl-host');

      overlay = document.createElement('div');
      overlay.className = 'tgdl-overlay';

      const check = document.createElement('div');
      check.className = 'tgdl-check';
      check.setAttribute('role', 'checkbox');
      check.setAttribute('aria-checked', 'false');
      check.title = 'Выбрать';
      shield(check);
      check.addEventListener('click', () => handlers.onToggle(overlay.dataset.key));

      const btn = document.createElement('button');
      btn.className = 'tgdl-btn';
      btn.type = 'button';
      btn.dataset.state = 'idle';
      btn.textContent = LABELS.idle;
      btn.title = 'Скачать';
      shield(btn);
      btn.addEventListener('click', () => handlers.onDownload(overlay.dataset.key));

      overlay.append(check, btn);
      el.append(overlay);
    }
    if (overlay.dataset.key !== key) {
      // Элемент мог быть переиспользован клиентом под другое сообщение
      overlay.dataset.key = key;
      ui.applyState(overlay, 'idle');
      ui.applyChecked(overlay, false);
    }
    return overlay;
  };

  ui.applyState = (overlay, state, info = {}) => {
    const btn = overlay.querySelector('.tgdl-btn');
    if (!btn) return;
    btn.dataset.state = state;
    if (state === 'active' && typeof info.pct === 'number') btn.textContent = `${Math.floor(info.pct)}%`;
    else btn.textContent = LABELS[state] || LABELS.idle;
    btn.title =
      state === 'error' ? `Ошибка: ${info.error || 'неизвестно'} (нажмите, чтобы повторить)`
        : state === 'done' ? 'Уже скачано (нажмите, чтобы скачать ещё раз)'
          : state === 'queued' ? 'В очереди'
            : state === 'active' ? 'Скачивается'
              : 'Скачать';
  };

  ui.applyChecked = (overlay, checked) => {
    overlay.querySelector('.tgdl-check')?.setAttribute('aria-checked', String(!!checked));
    overlay.parentElement?.classList.toggle('tgdl-selected-host', !!checked);
  };

  ui.overlaysFor = (key) =>
    [...document.querySelectorAll('.tgdl-overlay')].filter((o) => o.dataset.key === key);

  ui.setSelectMode = (on) => document.body.classList.toggle('tgdl-select-mode', on);

  /**
   * Плавающая панель. handlers:
   *   onToggleSelect(), onDownloadSelected(), onClearSelection(),
   *   onDownloadAll({stopDate, limit}), onStop()
   */
  ui.createToolbar = (handlers) => {
    const root = document.createElement('div');
    root.className = 'tgdl-toolbar tgdl-collapsed';
    root.innerHTML = `
      <div class="tgdl-head"><span>⬇ TG Downloader</span><span class="tgdl-head-info"></span></div>
      <div class="tgdl-body">
        <div class="tgdl-row">
          <button type="button" class="tgdl-secondary" data-act="select">Режим выбора</button>
        </div>
        <div class="tgdl-row">
          <button type="button" data-act="dl-selected" disabled>Скачать выбранное (0)</button>
          <button type="button" class="tgdl-secondary" data-act="clear-sel" title="Снять выбор">✕</button>
        </div>
        <div class="tgdl-row">
          <label>До даты (включительно)<input type="date" data-field="stopDate"></label>
          <label>Лимит, шт.<input type="number" min="1" step="1" placeholder="без лимита" data-field="limit"></label>
        </div>
        <div class="tgdl-row">
          <button type="button" data-act="dl-all">Скачать всё</button>
          <button type="button" class="tgdl-danger" data-act="stop" disabled>Стоп</button>
        </div>
        <div class="tgdl-status"></div>
      </div>`;
    document.body.append(root);

    const $ = (s) => root.querySelector(s);
    root.querySelector('.tgdl-head').addEventListener('click', () => root.classList.toggle('tgdl-collapsed'));
    $('[data-act="select"]').addEventListener('click', () => handlers.onToggleSelect());
    $('[data-act="dl-selected"]').addEventListener('click', () => handlers.onDownloadSelected());
    $('[data-act="clear-sel"]').addEventListener('click', () => handlers.onClearSelection());
    $('[data-act="stop"]').addEventListener('click', () => handlers.onStop());
    $('[data-act="dl-all"]').addEventListener('click', () => {
      const dateValue = $('[data-field="stopDate"]').value; // YYYY-MM-DD, локальная полночь
      const limitValue = parseInt($('[data-field="limit"]').value, 10);
      handlers.onDownloadAll({
        stopDate: dateValue ? Math.floor(new Date(dateValue + 'T00:00:00').getTime() / 1000) : null,
        limit: limitValue > 0 ? limitValue : null,
      });
    });

    return {
      setStatus(text) {
        $('.tgdl-status').textContent = text || '';
      },
      setHeadInfo(text) {
        $('.tgdl-head-info').textContent = text || '';
      },
      setSelectMode(on) {
        $('[data-act="select"]').textContent = on ? 'Выйти из режима выбора' : 'Режим выбора';
      },
      setSelectedCount(n) {
        const b = $('[data-act="dl-selected"]');
        b.textContent = `Скачать выбранное (${n})`;
        b.disabled = n === 0;
      },
      setBusy(busy) {
        $('[data-act="dl-all"]').disabled = busy;
        $('[data-act="stop"]').disabled = !busy;
      },
      expand() {
        root.classList.remove('tgdl-collapsed');
      },
    };
  };
})();
