/*
 * popup.js — настройки, прогресс очереди, лог ошибок.
 * Состояние запрашивается у background раз в секунду, пока popup открыт.
 */
const $ = (sel) => document.querySelector(sel);

const send = (message) => chrome.runtime.sendMessage(message);

function fmtBytes(n) {
  if (!n) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i ? 1 : 0)} ${units[i]}`;
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of [].concat(children)) node.append(c);
  return node;
}

const STATUS_TEXT = {
  fetching: 'загрузка',
  saving: 'сохранение',
  'retry-wait': 'ожидание повтора',
  pending: 'в очереди',
};

let settingsFilled = false;

function render(state) {
  if (!state || state.error) return;

  $('#c-pending').textContent = state.pending;
  $('#c-active').textContent = state.active.length;
  $('#c-done').textContent = state.stats.done;
  $('#c-failed').textContent = state.stats.failed;
  $('#btn-pause').textContent = state.paused ? 'Продолжить' : 'Пауза';

  // Активные задания с прогрессом
  const list = $('#active-list');
  list.replaceChildren(
    ...state.active.map((j) => {
      const pct = j.total ? Math.min(100, (j.loaded / j.total) * 100) : 0;
      const bar = el('div');
      bar.style.width = `${pct}%`;
      const size = j.total ? `${fmtBytes(j.loaded)} / ${fmtBytes(j.total)}` : STATUS_TEXT[j.status] || j.status;
      return el('div', { className: 'job' }, [
        el('div', { className: 'name' }, [
          el('span', { textContent: `${j.channel} #${j.mid} (${j.type})${j.attempts > 1 ? ` · попытка ${j.attempts}` : ''}` }),
          el('span', { className: 'muted', textContent: size }),
        ]),
        el('div', { className: 'bar' }, bar),
      ]);
    }),
  );

  // Неудачные
  $('#failed-list').replaceChildren(
    ...(state.failed.length
      ? state.failed.map((f) => el('li', { textContent: `${f.channel} #${f.mid}: ${f.error}` }))
      : [el('li', { className: 'muted', textContent: 'Нет' })]),
  );

  // Лог (новые сверху)
  $('#log-list').replaceChildren(
    ...state.log
      .slice()
      .reverse()
      .map((e) =>
        el('li', { className: e.level }, [
          el('time', { textContent: new Date(e.t).toLocaleTimeString() }),
          e.text,
        ]),
      ),
  );

  if (!settingsFilled) {
    const form = $('#settings');
    for (const [k, v] of Object.entries(state.settings)) {
      if (form.elements[k]) form.elements[k].value = v;
    }
    settingsFilled = true;
  }
}

async function refresh() {
  try {
    render(await send({ type: 'getState' }));
  } catch (e) {
    console.warn(e);
  }
}

async function refreshHistory() {
  const h = await send({ type: 'historyStats' });
  $('#history').textContent = `Запомнено скачанных сообщений: ${h.files} (чатов: ${h.chats}). Они будут пропускаться.`;
}

async function getTelegramTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || !/^https:\/\/web\.telegram\.org\/(k|a)\//.test(tab.url)) return null;
  return tab;
}

async function refreshPageStatus() {
  const tab = await getTelegramTab();
  const status = $('#page-status');
  const allButtons = [$('#btn-all-start'), $('#btn-all-stop')];
  if (!tab) {
    status.textContent = 'Откройте web.telegram.org/k или /a в активной вкладке.';
    allButtons.forEach((b) => (b.disabled = true));
    return;
  }
  try {
    const s = await chrome.tabs.sendMessage(tab.id, { type: 'pageStatus' });
    status.textContent = s.chatOpen
      ? `Web ${s.client.toUpperCase()} · ${s.title}${s.scanning ? ' · идёт «Скачать всё»' : ''}`
      : `Web ${s.client.toUpperCase()} · чат не открыт`;
    $('#btn-all-start').disabled = !s.chatOpen || s.scanning;
    $('#btn-all-stop').disabled = !s.scanning;
  } catch {
    status.textContent = 'Обновите вкладку Telegram (F5) — расширение ещё не подключено к ней.';
    allButtons.forEach((b) => (b.disabled = true));
  }
}

// --- Обработчики ---

$('#btn-pause').addEventListener('click', async () => {
  const state = await send({ type: 'getState' });
  render(await send({ type: state.paused ? 'resume' : 'pause' }));
});

$('#btn-cancel').addEventListener('click', async () => {
  if (!confirm('Отменить все задания в очереди и прервать текущие загрузки?')) return;
  render(await send({ type: 'cancelAll' }));
});

$('#btn-retry').addEventListener('click', async () => render(await send({ type: 'retryFailed' })));
$('#btn-clear-failed').addEventListener('click', async () => render(await send({ type: 'clearFailed' })));
$('#btn-clear-log').addEventListener('click', async () => render(await send({ type: 'clearLog' })));

$('#btn-clear-history').addEventListener('click', async () => {
  if (!confirm('Очистить историю? После этого уже скачанные файлы будут скачаны повторно.')) return;
  await send({ type: 'clearHistory' });
  refreshHistory();
});

$('#btn-all-start').addEventListener('click', async () => {
  const tab = await getTelegramTab();
  if (!tab) return;
  const dateValue = $('#all-date').value;
  const limit = parseInt($('#all-limit').value, 10);
  await chrome.tabs.sendMessage(tab.id, {
    type: 'startDownloadAll',
    options: {
      stopDate: dateValue ? Math.floor(new Date(dateValue + 'T00:00:00').getTime() / 1000) : null,
      limit: limit > 0 ? limit : null,
    },
  });
  setTimeout(refreshPageStatus, 500);
});

$('#btn-all-stop').addEventListener('click', async () => {
  const tab = await getTelegramTab();
  if (tab) await chrome.tabs.sendMessage(tab.id, { type: 'stopDownloadAll' });
  setTimeout(refreshPageStatus, 500);
});

$('#settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const settings = Object.fromEntries(new FormData(form).entries());
  const r = await send({ type: 'saveSettings', settings });
  for (const [k, v] of Object.entries(r.settings)) {
    if (form.elements[k]) form.elements[k].value = v;
  }
  $('#settings-saved').textContent = 'Сохранено';
  setTimeout(() => ($('#settings-saved').textContent = ''), 1500);
});

refresh();
refreshHistory();
refreshPageStatus();
setInterval(refresh, 1000);
setInterval(refreshPageStatus, 3000);
