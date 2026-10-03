/*
 * content/main.js — точка входа content script.
 *  - определяет версию клиента по URL (/k/ или /a/) и выбирает адаптер;
 *  - расставляет оверлеи на медиа (MutationObserver);
 *  - превращает выбранные медиа в задания (job) и отправляет их в очередь background;
 *  - по команде background скачивает источник через bridge (MAIN world) и
 *    возвращает blob:-URL для сохранения через chrome.downloads;
 *  - «Скачать всё»: автопрокрутка истории вверх с накоплением медиа.
 */
(() => {
  const TGDL = globalThis.TGDL;
  const { util, bridge, ui } = TGDL;

  const client = location.pathname.startsWith('/k') ? 'k' : location.pathname.startsWith('/a') ? 'a' : null;
  if (!client) return;
  const adapter = TGDL.adapters[client];

  const state = {
    chat: null,
    chatSig: '',
    items: new Map(), // key -> последний найденный в DOM item
    itemStates: new Map(), // key -> {state, pct, error}
    checkedKeys: new Set(), // ключи, статус которых уже запрошен у background
    selected: new Map(), // key -> item (режим выбора)
    selectMode: false,
    scan: null, // {stop: boolean} во время «Скачать всё»
    activeReqs: new Map(), // key -> reqId bridge (для отмены)
  };

  // Всё, что открывает медиавьюер или трогает DOM, выполняется строго по одному
  const resolveMutex = util.createMutex();

  const keyOf = (chat, item) => `${chat.peerKey}:${item.mid}`;

  async function getChat() {
    const title = document.querySelector(adapter.sel.chatTitle)?.textContent || '';
    const sig = location.hash + '|' + title;
    if (state.chat && state.chatSig === sig) return state.chat;
    state.chat = await adapter.getChatInfo();
    state.chatSig = sig;
    return state.chat;
  }

  function setItemState(key, st, info = {}) {
    state.itemStates.set(key, { state: st, ...info });
    for (const overlay of ui.overlaysFor(key)) ui.applyState(overlay, st, info);
  }

  /** Если элемент item пропал из DOM (клиент перерисовал ленту), ищем его заново по ключу */
  function freshItem(item) {
    if (item.el?.isConnected || !state.chat) return item;
    const found = adapter.scanItems().find((i) => keyOf(state.chat, i) === item.key);
    if (found) {
      found.key = item.key;
      found.date = found.date || item.date;
      return found;
    }
    return item;
  }

  // ---------------------------------------------------------------------------
  // Оверлеи на медиа
  // ---------------------------------------------------------------------------

  const overlayHandlers = {
    onDownload: (key) => {
      const item = state.items.get(key);
      if (!item) return;
      const st = state.itemStates.get(key)?.state;
      if (st === 'queued' || st === 'active' || st === 'resolving') return;
      let force = false;
      if (st === 'done') {
        if (!confirm('Этот файл уже скачан. Скачать ещё раз?')) return;
        force = true;
      }
      downloadItems([item], { force })
        .then((r) => {
          if (r.failed) ui.notify('Не удалось поставить в очередь — см. лог в popup', 'error');
        })
        .catch((e) => ui.notify(String(e?.message || e), 'error'));
    },
    onToggle: (key) => toggleSelect(key),
  };

  let refreshTimer = null;
  let refreshing = false;
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 300);
  }

  async function refresh() {
    if (refreshing) return scheduleRefresh();
    if (!adapter.isChatOpen()) return;
    refreshing = true;
    try {
      const chat = await getChat();
      const unknown = [];
      for (const item of adapter.scanItems()) {
        const key = keyOf(chat, item);
        item.key = key;
        state.items.set(key, item);
        const overlay = ui.ensureOverlay(item.el, key, overlayHandlers);
        const st = state.itemStates.get(key);
        if (st) ui.applyState(overlay, st.state, st);
        else if (!state.checkedKeys.has(key)) unknown.push(key);
        ui.applyChecked(overlay, state.selected.has(key));
      }
      if (unknown.length) {
        unknown.forEach((k) => state.checkedKeys.add(k));
        const r = await util.sendBg({ type: 'checkKeys', keys: unknown });
        r?.done?.forEach((k) => setItemState(k, 'done'));
        r?.queued?.forEach((k) => setItemState(k, 'queued'));
      }
    } catch (e) {
      console.debug('[TGDL] refresh', e);
    } finally {
      refreshing = false;
    }
  }

  const observer = new MutationObserver((records) => {
    // Свои изменения (оверлеи, панель, тосты) игнорируем, чтобы не зациклиться
    const foreign = records.some((r) => {
      const t = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      return !t?.closest?.('.tgdl-overlay, .tgdl-toolbar, .tgdl-toast');
    });
    if (foreign) scheduleRefresh();
  });

  // ---------------------------------------------------------------------------
  // Постановка в очередь
  // ---------------------------------------------------------------------------

  async function buildJob(item, chat, force) {
    return resolveMutex(async () => {
      const it = freshItem(item);
      await adapter.ensureDate(it);
      const source = await adapter.resolveSource(it, chat);
      return {
        key: item.key,
        peerKey: chat.peerKey,
        channel: chat.title,
        mid: item.mid,
        date: it.date || null,
        type: item.type,
        protected: !!item.protected,
        client,
        source,
        force: !!force,
      };
    });
  }

  /**
   * Ставит медиа в очередь background. Уже скачанные (дедупликация) и уже стоящие
   * в очереди пропускаются, если не указан force.
   */
  async function downloadItems(items, { force = false, shouldStop } = {}) {
    const result = { added: 0, skipped: 0, failed: 0 };
    if (!items.length) return result;
    const chat = await getChat();
    items.forEach((i) => (i.key = i.key || keyOf(chat, i)));

    let skip = new Set();
    if (!force) {
      const r = await util.sendBg({ type: 'checkKeys', keys: items.map((i) => i.key) });
      if (!r || r.error) throw new Error(r?.error || 'Нет ответа от background');
      r.done.forEach((k) => setItemState(k, 'done'));
      r.queued.forEach((k) => setItemState(k, 'queued'));
      skip = new Set([...r.done, ...r.queued]);
    }

    for (const item of items) {
      if (shouldStop?.()) break;
      if (skip.has(item.key)) {
        result.skipped++;
        continue;
      }
      try {
        setItemState(item.key, 'resolving');
        const job = await buildJob(item, chat, force);
        const r = await util.sendBg({ type: 'enqueue', jobs: [job] });
        if (r?.added) {
          result.added++;
          setItemState(item.key, 'queued');
        } else {
          result.skipped++;
          setItemState(item.key, r?.reason === 'done' ? 'done' : 'queued');
        }
      } catch (e) {
        result.failed++;
        const error = String(e?.message || e);
        setItemState(item.key, 'error', { error });
        util.sendBg({ type: 'log', level: 'error', text: `${chat.title} #${item.mid}: ${error}` }).catch(() => {});
      }
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Режим выбора
  // ---------------------------------------------------------------------------

  function toggleSelect(key) {
    const item = state.items.get(key);
    if (!item) return;
    if (state.selected.has(key)) state.selected.delete(key);
    else state.selected.set(key, item);
    for (const overlay of ui.overlaysFor(key)) ui.applyChecked(overlay, state.selected.has(key));
    toolbar.setSelectedCount(state.selected.size);
  }

  function clearSelection() {
    for (const key of state.selected.keys()) {
      for (const overlay of ui.overlaysFor(key)) ui.applyChecked(overlay, false);
    }
    state.selected.clear();
    toolbar.setSelectedCount(0);
  }

  function setSelectMode(on) {
    state.selectMode = on;
    ui.setSelectMode(on);
    toolbar.setSelectMode(on);
    if (!on) clearSelection();
  }

  async function downloadSelected() {
    const items = [...state.selected.values()].sort((a, b) => b.mid - a.mid);
    clearSelection();
    setSelectMode(false);
    toolbar.setStatus(`Ставлю в очередь ${items.length}…`);
    try {
      const r = await downloadItems(items);
      toolbar.setStatus(`Добавлено: ${r.added}, пропущено: ${r.skipped}, ошибок: ${r.failed}`);
    } catch (e) {
      toolbar.setStatus('Ошибка: ' + (e?.message || e));
    }
  }

  // ---------------------------------------------------------------------------
  // «Скачать всё»: автопрокрутка вверх
  // ---------------------------------------------------------------------------

  async function downloadAll({ stopDate = null, limit = null } = {}) {
    if (state.scan) return { ok: false, error: 'Уже выполняется' };
    const container = adapter.getScrollContainer();
    if (!container) {
      ui.notify('Откройте канал, из которого нужно скачать медиа', 'error');
      return { ok: false, error: 'Чат не открыт' };
    }

    const scan = (state.scan = { stop: false });
    toolbar.setBusy(true);
    toolbar.expand();

    let chat = null;
    const seen = new Set();
    const totals = { added: 0, skipped: 0, failed: 0 };
    let reason = '';
    let idleRounds = 0;
    const status = (extra = '') =>
      toolbar.setStatus(
        `«Скачать всё»: найдено ${seen.size}, добавлено ${totals.added}, ` +
          `пропущено ${totals.skipped}, ошибок ${totals.failed}${extra ? '\n' + extra : ''}`,
      );

    try {
      chat = await getChat();
      // Начинаем с самого низа ленты (новейшие сообщения)
      container.scrollTop = container.scrollHeight;
      await util.sleep(1500);

      while (!scan.stop) {
        const current = await getChat();
        if (current.peerKey !== chat.peerKey) {
          reason = 'чат сменился';
          break;
        }

        const fresh = adapter
          .scanItems()
          .map((i) => ((i.key = keyOf(chat, i)), i))
          .filter((i) => !seen.has(i.key))
          .sort((a, b) => b.mid - a.mid); // от новых к старым

        for (const item of fresh) {
          if (scan.stop) break;
          seen.add(item.key);
          state.items.set(item.key, item);

          if (stopDate) {
            const date = await adapter.ensureDate(item);
            if (date && date < stopDate) {
              reason = 'достигнута дата';
              continue; // остальные в этой пачке тоже проверим — порядок в DOM не гарантирован
            }
          }
          if (limit && totals.added + totals.failed >= limit) {
            reason = 'достигнут лимит';
            break;
          }

          const r = await downloadItems([item], { shouldStop: () => scan.stop });
          totals.added += r.added;
          totals.skipped += r.skipped;
          totals.failed += r.failed;
          status();
        }
        if (reason || scan.stop) break;

        // Прокрутка вверх и ожидание подгрузки истории
        const beforeTop = container.scrollTop;
        const beforeHeight = container.scrollHeight;
        container.scrollBy({ top: -Math.round(container.clientHeight * 0.8) });
        await util.sleep(800);

        const moved = Math.abs(container.scrollTop - beforeTop) > 2;
        if (!moved) {
          // Упёрлись в верх загруженного — ждём, пока клиент подгрузит более старые сообщения
          status('Жду подгрузку истории…');
          await util
            .waitFor(() => container.scrollHeight !== beforeHeight || Math.abs(container.scrollTop - beforeTop) > 2, {
              timeout: 6000,
              interval: 250,
            })
            .catch(() => {});
        }
        const changed = Math.abs(container.scrollTop - beforeTop) > 2 || container.scrollHeight !== beforeHeight;
        idleRounds = changed ? 0 : idleRounds + 1;
        if (idleRounds >= 4) {
          reason = 'достигнуто начало канала';
          break;
        }
        status();
      }
    } catch (e) {
      reason = 'ошибка: ' + (e?.message || e);
    } finally {
      state.scan = null;
      toolbar.setBusy(false);
      status(`Остановлено: ${scan.stop ? 'по кнопке' : reason || 'готово'}`);
    }
    return { ok: true, ...totals, found: seen.size, reason };
  }

  // ---------------------------------------------------------------------------
  // Выполнение заданий по команде background
  // ---------------------------------------------------------------------------

  async function handleFetchJob(job) {
    await bridge.ready;
    let lastSent = 0;
    try {
      const res = await bridge.call(
        'fetchSource',
        { source: job.source },
        {
          timeout: 90000, // без прогресса; каждый чанк сбрасывает таймер
          onStart: (reqId) => state.activeReqs.set(job.key, reqId),
          onProgress: (loaded, total) => {
            const pct = total ? (loaded / total) * 100 : 0;
            setItemState(job.key, 'active', { pct });
            const now = Date.now();
            if (now - lastSent > 1000) {
              lastSent = now;
              util.sendBg({ type: 'jobProgress', key: job.key, attemptId: job.attemptId, loaded, total }).catch(() => {});
            }
          },
        },
      );
      await util.sendBg({ type: 'jobFetched', key: job.key, attemptId: job.attemptId, ...res });
    } catch (e) {
      util
        .sendBg({ type: 'jobFetchFailed', key: job.key, attemptId: job.attemptId, error: String(e?.message || e) })
        .catch(() => {});
    } finally {
      state.activeReqs.delete(job.key);
    }
  }

  /** Запасной способ сохранения: клик по <a download> (имя/путь задаст background) */
  function anchorDownload(blobUrl) {
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = 'tgdl-download';
    a.style.display = 'none';
    document.body.append(a);
    a.click();
    setTimeout(() => a.remove(), 1000);
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    switch (msg?.type) {
      case 'fetchJob':
        handleFetchJob(msg.job);
        sendResponse({ accepted: true });
        return;
      case 'cancelJob': {
        const reqId = state.activeReqs.get(msg.key);
        if (reqId) bridge.call('abort', { reqId }, { timeout: 3000 }).catch(() => {});
        sendResponse({ ok: true });
        return;
      }
      case 'revoke':
        bridge.call('revoke', { blobUrl: msg.blobUrl }, { timeout: 3000 }).catch(() => {});
        sendResponse({ ok: true });
        return;
      case 'anchorDownload':
        anchorDownload(msg.blobUrl);
        sendResponse({ ok: true });
        return;
      case 'jobState':
        setItemState(msg.key, msg.state, { pct: msg.pct, error: msg.error });
        if (msg.state === 'error' && msg.final) ui.notify(`Не удалось скачать #${msg.mid}: ${msg.error}`, 'error');
        return;
      case 'queueStats':
        toolbar.setHeadInfo(msg.pending || msg.active ? `${msg.active} / ${msg.pending}` : '');
        return;
      case 'startDownloadAll':
        downloadAll(msg.options || {});
        sendResponse({ ok: true });
        return;
      case 'stopDownloadAll':
        if (state.scan) state.scan.stop = true;
        sendResponse({ ok: true });
        return;
      case 'pageStatus':
        getChat()
          .then((chat) => sendResponse({ client, chatOpen: adapter.isChatOpen(), title: chat.title, scanning: !!state.scan }))
          .catch(() => sendResponse({ client, chatOpen: false, scanning: !!state.scan }));
        return true;
      default:
        return;
    }
  });

  // ---------------------------------------------------------------------------
  // Инициализация
  // ---------------------------------------------------------------------------

  const toolbar = ui.createToolbar({
    onToggleSelect: () => setSelectMode(!state.selectMode),
    onDownloadSelected: () => downloadSelected(),
    onClearSelection: () => clearSelection(),
    onDownloadAll: (opts) => downloadAll(opts),
    onStop: () => {
      if (state.scan) state.scan.stop = true;
    },
  });

  window.addEventListener('hashchange', () => {
    state.chat = null;
    if (state.scan) state.scan.stop = true;
    clearSelection();
    scheduleRefresh();
  });

  observer.observe(document.body, { childList: true, subtree: true });
  scheduleRefresh();
  console.info(`[TGDL] запущен для Web ${client.toUpperCase()}`);
})();
