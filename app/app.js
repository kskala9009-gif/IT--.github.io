const STORE = {
  requests: 'skala.requests.v1', messages: 'skala.messages.v1',
  profile: 'skala.profile.v1', client: 'skala.client.v1'
};

const load = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
};
const save = (key, value) => localStorage.setItem(key, JSON.stringify(value));
const esc = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));
const timeOf = value => new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' }).format(value ? new Date(value) : new Date());

function displayChatText(value, kind = '') {
  const text = String(value || '').trim();
  if (kind === 'call' || /^(?:Интернет-звонок|Создана комната интернет-звонка)\s*:?\s*https?:\/\//i.test(text)) {
    return 'Пропущенный звонок';
  }
  return text;
}

const backend = window.SkalaBackend;
const safeError = (error, fallback) => backend.userMessage(error, fallback);
let serverMode = false;
let currentUser = null;
let installPrompt = null;
let messagePollTimer = null;
let authCooldownTimer = null;
let requests = load(STORE.requests, []);
let messages = load(STORE.messages, []);
let profile = load(STORE.profile, { name: '', phone: '', email: '', role: 'client' });

const views = [...document.querySelectorAll('[data-view]')];
const nav = [...document.querySelectorAll('.nav-item')];
const chatBody = document.querySelector('#chat-body');
const input = document.querySelector('#message-input');
const toast = document.querySelector('#toast');
const appStatus = document.querySelector('#app-status');
const authGate = document.querySelector('#auth-gate');
const installButton = document.querySelector('#install-button');
const installSheet = document.querySelector('#install-sheet');
const installAction = document.querySelector('#install-action');
const installDescription = document.querySelector('#install-description');
const installHint = document.querySelector('#install-hint');
const installRequested = new URLSearchParams(location.search).get('install') === '1';

const isInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isAppleMobile = () => /iphone|ipad|ipod/i.test(navigator.userAgent);

function updateInstallPanel() {
  installAction.hidden = false;
  installAction.classList.remove('install-action-done');
  if (isInstalled()) {
    installDescription.textContent = 'Приложение Skala уже установлено на этом устройстве и готово к работе.';
    installAction.textContent = 'Приложение установлено ✓';
    installAction.classList.add('install-action-done');
    installHint.textContent = 'Откройте Skala через значок на рабочем столе.';
  } else if (installPrompt) {
    installDescription.textContent = 'Установите приложение, чтобы открывать заявки, чат и звонки прямо с рабочего стола.';
    installAction.innerHTML = 'Установить приложение <span>↓</span>';
    installHint.textContent = 'Установка бесплатна и занимает меньше минуты.';
  } else if (isAppleMobile()) {
    installDescription.textContent = 'На iPhone нажмите «Поделиться» внизу Safari, затем выберите «На экран Домой».';
    installAction.textContent = 'Показать инструкцию';
    installHint.textContent = 'После добавления значок Skala появится на главном экране.';
  } else {
    installDescription.textContent = 'Если окно установки не появилось, откройте меню браузера и выберите «Установить приложение».';
    installAction.textContent = 'Как установить';
    installHint.textContent = 'В Chrome и Edge пункт установки находится в меню справа от адресной строки.';
  }
}

function openInstallPanel() {
  updateInstallPanel();
  installSheet.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeInstallPanel() {
  installSheet.hidden = true;
  document.body.style.overflow = '';
}

async function requestInstall() {
  if (isInstalled()) {
    notify('Skala уже установлена');
    return;
  }
  if (installPrompt) {
    installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === 'accepted') closeInstallPanel();
    installPrompt = null;
    installButton.hidden = true;
    updateInstallPanel();
    return;
  }
  updateInstallPanel();
}

document.querySelector('#install-close').addEventListener('click', closeInstallPanel);
document.querySelector('#install-continue').addEventListener('click', closeInstallPanel);
installSheet.addEventListener('click', event => { if (event.target === installSheet) closeInstallPanel(); });
installAction.addEventListener('click', requestInstall);
addEventListener('keydown', event => { if (event.key === 'Escape' && !installSheet.hidden) closeInstallPanel(); });

function notify(text) {
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => toast.classList.remove('show'), 3000);
}

function showStatus(text, type = '', duration = 0) {
  appStatus.textContent = text;
  appStatus.className = `app-status ${type}`.trim();
  appStatus.hidden = false;
  clearTimeout(showStatus.timer);
  if (duration) showStatus.timer = setTimeout(() => { appStatus.hidden = true; }, duration);
}

function getAuthCooldownSeconds(error) {
  const match = String(error?.message || error || '').match(/after\s+(\d+)\s+seconds?/i);
  return match ? Number(match[1]) : 0;
}

function startAuthCooldown(button, seconds = 60) {
  let remaining = Math.max(1, Math.ceil(Number(seconds) || 60));
  clearInterval(authCooldownTimer);
  button.disabled = true;
  button.classList.add('is-busy');

  const update = () => {
    if (remaining <= 0) {
      clearInterval(authCooldownTimer);
      authCooldownTimer = null;
      button.disabled = false;
      button.classList.remove('is-busy');
      button.innerHTML = 'Получить ссылку <span>→</span>';
      return;
    }
    button.textContent = `Повторно через ${remaining} сек.`;
    remaining -= 1;
  };

  update();
  authCooldownTimer = setInterval(update, 1000);
}

function isNewSessionClockSkew(error) {
  return /jwt issued at future/i.test(String(error?.message || error || ''));
}

async function loadWorkspaceAfterSignIn() {
  const retryDelays = [2000, 4000, 6000];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await backend.loadWorkspace();
    } catch (error) {
      if (!isNewSessionClockSkew(error) || attempt >= retryDelays.length) throw error;
      showStatus('Завершаем безопасный вход…');
      await new Promise(resolve => setTimeout(resolve, retryDelays[attempt]));
    }
  }
}

function go(name) {
  views.forEach(view => view.classList.toggle('active', view.dataset.view === name));
  nav.forEach(item => item.classList.toggle('active', item.dataset.go === name));
  scrollTo({ top: 0, behavior: 'smooth' });
  if (name === 'chat') {
    renderMessages();
    document.querySelector('#chat-badge').hidden = true;
    setTimeout(() => input.focus(), 200);
  }
  history.replaceState(null, '', `#${name}`);
}

document.querySelectorAll('[data-go]').forEach(button => button.addEventListener('click', event => {
  if (button.tagName === 'A') event.preventDefault();
  go(button.dataset.go);
}));

function mapRequest(row) {
  return {
    backendId: row.id, id: row.display_id, createdAt: row.created_at,
    status: row.status, name: row.contact_name, phone: row.phone, email: row.email,
    type: row.project_type, budget: row.budget, idea: row.idea,
    deadline: row.deadline || '', reference: row.reference_url || '',
    styles: row.styles || [], files: []
  };
}

function mapMessage(row) {
  const side = row.kind === 'system' ? 'system' : row.sender_id === currentUser?.id ? 'outgoing' : 'incoming';
  return {
    id: row.id, side, text: row.body, time: timeOf(row.created_at),
    assistant: side === 'incoming', file: row.kind === 'file' ? row.attachment_name : '', kind: row.kind
  };
}

function appendMessage(message, persist = false) {
  if (messages.some(item => item.id === message.id)) return;
  messages.push(message);
  if (persist && !serverMode) save(STORE.messages, messages);
  renderMessages();
  renderDashboard();
}

function startMessagePolling() {
  clearInterval(messagePollTimer);
  const sync = async () => {
    if (!currentUser || document.hidden) return;
    try {
      const rows = await backend.loadMessages();
      rows.forEach(row => appendMessage(mapMessage(row)));
    } catch (error) {
      console.warn('Резервное обновление чата временно недоступно', error);
    }
  };
  messagePollTimer = setInterval(sync, 8000);
}

function addLocalMessage(side, text, assistant = false) {
  appendMessage({ id: crypto.randomUUID(), side, text, time: timeOf(), assistant }, true);
}

function renderDashboard() {
  document.querySelector('#request-count').textContent = String(requests.length).padStart(2, '0');
  document.querySelector('#message-count').textContent = String(messages.filter(message => message.side === 'incoming').length).padStart(2, '0');
  const preview = document.querySelector('#request-preview');
  if (!requests.length) {
    preview.className = 'empty-state';
    preview.innerHTML = '<span>✦</span><div><h3>Заявок пока нет</h3><p>Опишите идею — это займёт около трёх минут.</p></div><button class="secondary">Начать</button>';
    preview.querySelector('button').onclick = () => go('request');
    document.querySelector('#request-summary').textContent = 'Создайте первую идею';
    return;
  }
  const item = requests[0];
  preview.className = 'request-card';
  preview.innerHTML = `<div><div class="request-top"><span class="eyebrow">${esc(item.id)}</span><span class="status">${esc(item.status)}</span></div><h3>${esc(item.type)}</h3><p>${esc(item.idea.slice(0, 150))}${item.idea.length > 150 ? '…' : ''}</p></div><button class="secondary">Обсудить</button>`;
  preview.querySelector('button').onclick = () => go('chat');
  document.querySelector('#request-summary').textContent = item.status;
}

function renderMessages() {
  let html = '<div class="day">Сегодня</div>';
  if (!messages.length) {
    html += '<div class="message incoming">Здравствуйте! Расскажите об идее здесь или создайте подробную заявку. Менеджер Skala ответит в этом чате.<small>Команда Skala</small></div>';
  }
  messages.forEach(message => {
    const label = message.assistant ? `Команда Skala · ${message.time}` : message.time;
    html += `<div class="message ${message.side}${message.file ? ' file' : ''}">${esc(displayChatText(message.text, message.kind))}<small>${esc(label)}</small></div>`;
  });
  chatBody.innerHTML = html;
  requestAnimationFrame(() => { chatBody.scrollTop = chatBody.scrollHeight; });
}

document.querySelector('#message-form').addEventListener('submit', async event => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  input.style.height = 'auto';
  if (!serverMode) {
    addLocalMessage('outgoing', text);
    const typing = document.querySelector('#typing');
    typing.hidden = false;
    setTimeout(() => {
      typing.hidden = true;
      addLocalMessage('incoming', 'Сообщение сохранено на этом устройстве. После подключения сервера здесь ответит менеджер Skala.', true);
    }, 900);
    return;
  }
  try {
    const row = await backend.sendMessage(text);
    appendMessage(mapMessage(row));
  } catch (error) {
    input.value = text;
    notify(safeError(error, 'Не удалось отправить сообщение. Попробуйте ещё раз.'));
  }
});

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
});

document.querySelector('#chat-file').addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) return notify('Файл должен быть не больше 10 МБ');
  if (!serverMode) return addLocalMessage('outgoing', `Вложение: ${file.name}`);
  try {
    showStatus('Загружаем файл…');
    const row = await backend.sendMessage('', file);
    appendMessage(mapMessage(row));
    showStatus('Файл отправлен', 'success', 1800);
  } catch (error) {
    showStatus(safeError(error, 'Не удалось загрузить файл. Проверьте формат и попробуйте ещё раз.'), 'error', 4500);
  }
});

document.querySelector('#chat-info').onclick = () => notify(serverMode ? 'Переписка защищённо хранится на сервере Skala' : 'Демо: переписка хранится только на этом устройстве');

const idea = document.querySelector('[name="idea"]');
idea.addEventListener('input', () => { document.querySelector('#idea-count').textContent = idea.value.length; });
document.querySelector('#attachments').addEventListener('change', event => {
  const files = [...event.target.files];
  const tooLarge = files.some(file => file.size > 10 * 1024 * 1024);
  const tooMany = files.length > 5;
  document.querySelector('#upload-note').textContent = tooMany
    ? 'Можно выбрать не больше 5 файлов'
    : tooLarge
    ? 'Один из файлов больше 10 МБ'
    : files.length ? `Выбрано файлов: ${files.length} · ${files.map(file => file.name).join(', ')}` : 'До 5 файлов · JPG, PNG, WEBP, PDF или DOCX · каждый до 10 МБ';
});

document.querySelector('#request-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const files = [...document.querySelector('#attachments').files];
  if (files.length > 5) return notify('К одной заявке можно прикрепить не больше 5 файлов');
  if (files.some(file => file.size > 10 * 1024 * 1024)) return notify('Каждый файл должен быть не больше 10 МБ');
  const data = new FormData(form);
  const styles = data.getAll('style');
  const item = {
    id: serverMode ? '' : `SK-${new Date().getFullYear()}-${Date.now().toString().slice(-8)}`,
    createdAt: new Date().toISOString(), status: 'На обсуждении',
    name: data.get('name').trim(), phone: data.get('phone').trim(),
    email: data.get('email').trim(), type: data.get('type'), budget: data.get('budget'),
    idea: data.get('idea').trim(), deadline: data.get('deadline'),
    reference: data.get('reference').trim(), styles, files: files.map(file => file.name)
  };
  const submit = form.querySelector('[type="submit"]');
  submit.classList.add('is-busy');
  try {
    if (serverMode) {
      showStatus(files.length ? 'Создаём заявку и загружаем файлы…' : 'Создаём заявку…');
      const row = await backend.createRequest(item, files);
      requests.unshift(mapRequest(row));
      profile = { ...profile, name: item.name, phone: item.phone, email: currentUser.email || item.email };
      await backend.saveProfile(profile);
      showStatus('Заявка сохранена на сервере', 'success', 2200);
    } else {
      requests.unshift(item);
      save(STORE.requests, requests);
      profile = { name: item.name, phone: item.phone, email: item.email, role: 'client' };
      save(STORE.profile, profile);
      addLocalMessage('system', `Создана заявка ${item.id}: ${item.type}`);
      addLocalMessage('outgoing', `Моя идея: ${item.idea}\nБюджет: ${item.budget}${styles.length ? `\nСтиль: ${styles.join(', ')}` : ''}`);
    }
    updateProfile();
    renderDashboard();
    document.querySelector('#success-title').textContent = `${item.name}, спасибо!`;
    document.querySelector('#success-dialog').showModal();
    form.reset();
    document.querySelector('#idea-count').textContent = '0';
    document.querySelector('#upload-note').textContent = 'До 5 файлов · JPG, PNG, WEBP, PDF или DOCX · каждый до 10 МБ';
  } catch (error) {
    showStatus(safeError(error, 'Не удалось отправить заявку. Попробуйте ещё раз.'), 'error', 5500);
  } finally {
    submit.classList.remove('is-busy');
  }
});

document.querySelector('#success-chat').onclick = () => {
  document.querySelector('#success-dialog').close();
  go('chat');
};

function updateProfile() {
  document.querySelector('#profile-name').value = profile.name || '';
  document.querySelector('#profile-phone').value = profile.phone || '';
  document.querySelector('#profile-email').value = profile.email || '';
  document.querySelector('#profile-email').readOnly = serverMode;
  const initial = (profile.name || currentUser?.email || 'К').trim().charAt(0).toUpperCase();
  document.querySelectorAll('.avatar,.round-profile,.large-avatar').forEach(element => { element.textContent = initial; });
  document.querySelector('#profile-title').textContent = profile.name || currentUser?.email || 'Клиент Skala';
  document.querySelector('#admin-link').hidden = profile.role !== 'admin';
  document.querySelector('#logout-button').hidden = !serverMode;
}

document.querySelector('#profile-form').addEventListener('submit', async event => {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  const next = {
    ...profile, name: data.get('name').trim(), phone: data.get('phone').trim(),
    email: serverMode ? currentUser.email || '' : data.get('email').trim()
  };
  try {
    if (serverMode) await backend.saveProfile(next);
    else save(STORE.profile, next);
    profile = next;
    updateProfile();
    notify('Профиль сохранён');
  } catch (error) {
    notify(safeError(error, 'Не удалось сохранить профиль. Попробуйте ещё раз.'));
  }
});

document.querySelector('#logout-button').addEventListener('click', async () => {
  try {
    clearInterval(messagePollTimer);
    await backend.signOut();
    currentUser = null;
    authGate.hidden = false;
    notify('Вы вышли из кабинета');
  } catch (error) {
    notify(safeError(error, 'Не удалось завершить сеанс. Обновите страницу.'));
  }
});

const callDialog = document.querySelector('#call-dialog');
const callFrame = document.querySelector('#call-frame');
const internetCallButton = document.querySelector('#internet-call');
const CALL_COOLDOWN_MS = 60 * 1000;
let lastCallStartedAt = 0;
let callStarting = false;

internetCallButton.onclick = async () => {
  if (!serverMode || !currentUser) {
    authGate.hidden = false;
    notify('Войдите в кабинет, чтобы начать звонок');
    return;
  }
  if (callStarting) return;
  const waitSeconds = Math.ceil((CALL_COOLDOWN_MS - (Date.now() - lastCallStartedAt)) / 1000);
  if (waitSeconds > 0) {
    notify(`Новый звонок можно начать через ${waitSeconds} сек.`);
    return;
  }

  callStarting = true;
  internetCallButton.disabled = true;
  const room = `Skala-Consultation-${crypto.randomUUID().replaceAll('-', '')}`;
  try {
    const row = await backend.startCall(room);
    appendMessage(mapMessage(row));
    lastCallStartedAt = Date.now();
    callDialog.showModal();
    setTimeout(() => {
      const frame = document.createElement('iframe');
      frame.title = 'Интернет-звонок Skala';
      frame.src = `https://meet.jit.si/${encodeURIComponent(room)}#config.prejoinPageEnabled=true&config.startWithVideoMuted=true`;
      frame.allow = 'camera; microphone; fullscreen; autoplay';
      frame.referrerPolicy = 'no-referrer';
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-presentation');
      frame.setAttribute('allowfullscreen', '');
      callFrame.replaceChildren(frame);
    }, 400);
  } catch (error) {
    notify(safeError(error, 'Не удалось начать звонок. Попробуйте ещё раз.'));
  } finally {
    callStarting = false;
    internetCallButton.disabled = false;
  }
};

document.querySelector('#close-call').onclick = () => {
  callDialog.close();
  callFrame.innerHTML = '<div><span class="team-avatar">S</span><h2>Подключаем комнату…</h2><p>Разрешите доступ к микрофону и камере.</p></div>';
};

document.querySelector('#auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  const email = document.querySelector('#auth-email').value.trim();
  const button = event.currentTarget.querySelector('button');
  button.classList.add('is-busy');
  try {
    await backend.signIn(email);
    document.querySelector('#auth-note').textContent = 'Ссылка отправлена. Проверьте входящие и папку «Спам», затем откройте письмо Skala.';
    showStatus('Письмо для входа отправлено', 'success', 3000);
    startAuthCooldown(button, 60);
  } catch (error) {
    const seconds = getAuthCooldownSeconds(error);
    if (seconds) {
      document.querySelector('#auth-note').textContent = `Предыдущее письмо уже запрошено. Проверьте входящие и «Спам». Повторная отправка будет доступна через ${seconds} сек.`;
      startAuthCooldown(button, seconds);
    } else if (/email rate limit exceeded/i.test(String(error?.message || ''))) {
      document.querySelector('#auth-note').textContent = 'Сейчас отправлено слишком много писем. Попробуйте ещё раз немного позже.';
    } else {
      document.querySelector('#auth-note').textContent = safeError(error, 'Не удалось отправить письмо. Проверьте адрес и попробуйте ещё раз.');
    }
  } finally {
    backend.resetCaptcha();
    if (!button.disabled) button.classList.remove('is-busy');
  }
});

addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
  installButton.hidden = false;
  if (!installSheet.hidden) updateInstallPanel();
});

installButton.onclick = openInstallPanel;
addEventListener('appinstalled', () => {
  installPrompt = null;
  installButton.hidden = true;
  closeInstallPanel();
  notify('Приложение Skala установлено');
});

if (installRequested) openInstallPanel();

async function boot() {
  const first = location.hash.slice(1);
  const initialView = ['dashboard', 'request', 'chat', 'calls', 'profile'].includes(first) ? first : 'dashboard';
  backend.mountCaptcha(document.querySelector('#auth-captcha'));
  try {
    const state = await backend.init((event, user) => {
      if (event === 'SIGNED_IN' && user && !currentUser) location.reload();
      if (event === 'SIGNED_OUT') authGate.hidden = false;
    });
    serverMode = state.configured;
    if (!serverMode) {
      updateProfile(); renderDashboard(); renderMessages(); go(initialView);
      return;
    }
    document.body.classList.add('server-mode');
    if (!state.user) {
      authGate.hidden = false;
      updateProfile(); renderDashboard(); renderMessages();
      return;
    }
    currentUser = state.user;
    showStatus('Подключаем кабинет…');
    const workspace = await loadWorkspaceAfterSignIn();
    requests = workspace.requests.map(mapRequest);
    messages = workspace.messages.map(mapMessage);
    profile = {
      name: workspace.profile?.full_name || '', phone: workspace.profile?.phone || '',
      email: currentUser.email || '', role: workspace.profile?.role || 'client'
    };
    try {
      await backend.subscribeToMessages(row => appendMessage(mapMessage(row)));
    } catch (error) {
      console.warn('Мгновенные обновления чата недоступны, включён резервный режим', error);
      startMessagePolling();
    }
    authGate.hidden = true;
    appStatus.hidden = true;
    updateProfile(); renderDashboard(); renderMessages(); go(initialView);
  } catch (error) {
    const message = isNewSessionClockSkew(error)
      ? 'Вход ещё активируется. Подождите несколько секунд и обновите страницу.'
      : safeError(error, 'Сервис временно недоступен. Попробуйте обновить страницу.');
    showStatus(message, 'error');
    updateProfile(); renderDashboard(); renderMessages();
  }
}

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
boot();
