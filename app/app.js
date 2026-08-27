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

const backend = window.SkalaBackend;
let serverMode = false;
let currentUser = null;
let installPrompt = null;
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
    assistant: side === 'incoming', file: row.kind === 'file' ? row.attachment_name : ''
  };
}

function appendMessage(message, persist = false) {
  if (messages.some(item => item.id === message.id)) return;
  messages.push(message);
  if (persist && !serverMode) save(STORE.messages, messages);
  renderMessages();
  renderDashboard();
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
    html += `<div class="message ${message.side}${message.file ? ' file' : ''}">${esc(message.text)}<small>${esc(label)}</small></div>`;
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
    notify(`Не удалось отправить: ${error.message}`);
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
    showStatus(`Ошибка загрузки: ${error.message}`, 'error', 4500);
  }
});

document.querySelector('#chat-info').onclick = () => notify(serverMode ? 'Переписка защищённо хранится на сервере Skala' : 'Демо: переписка хранится только на этом устройстве');

const idea = document.querySelector('[name="idea"]');
idea.addEventListener('input', () => { document.querySelector('#idea-count').textContent = idea.value.length; });
document.querySelector('#attachments').addEventListener('change', event => {
  const files = [...event.target.files];
  const tooLarge = files.some(file => file.size > 10 * 1024 * 1024);
  document.querySelector('#upload-note').textContent = tooLarge
    ? 'Один из файлов больше 10 МБ'
    : files.length ? `Выбрано файлов: ${files.length} · ${files.map(file => file.name).join(', ')}` : 'PNG, JPG, PDF или DOC до 10 МБ';
});

document.querySelector('#request-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const files = [...document.querySelector('#attachments').files];
  if (files.some(file => file.size > 10 * 1024 * 1024)) return notify('Каждый файл должен быть не больше 10 МБ');
  const data = new FormData(form);
  const styles = data.getAll('style');
  const item = {
    id: `SK-${new Date().getFullYear()}-${Date.now().toString().slice(-8)}`,
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
    document.querySelector('#upload-note').textContent = 'PNG, JPG, PDF или DOC до 10 МБ';
  } catch (error) {
    showStatus(`Не удалось отправить заявку: ${error.message}`, 'error', 5500);
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
    notify(`Не удалось сохранить: ${error.message}`);
  }
});

document.querySelector('#logout-button').addEventListener('click', async () => {
  try {
    await backend.signOut();
    currentUser = null;
    authGate.hidden = false;
    notify('Вы вышли из кабинета');
  } catch (error) {
    notify(`Не удалось выйти: ${error.message}`);
  }
});

const callDialog = document.querySelector('#call-dialog');
const callFrame = document.querySelector('#call-frame');
document.querySelector('#internet-call').onclick = async () => {
  const room = `Skala-Consultation-${crypto.randomUUID()}`;
  const url = `https://meet.jit.si/${room}`;
  if (serverMode) {
    try {
      const row = await backend.sendMessage(`Интернет-звонок: ${url}`);
      appendMessage(mapMessage(row));
    } catch (error) {
      notify(`Ссылка на звонок не добавлена в чат: ${error.message}`);
    }
  } else {
    addLocalMessage('system', `Создана комната интернет-звонка: ${url}`);
  }
  callDialog.showModal();
  setTimeout(() => {
    callFrame.innerHTML = `<iframe title="Интернет-звонок Skala" src="${url}#config.prejoinPageEnabled=true&config.startWithVideoMuted=true" allow="camera; microphone; fullscreen; display-capture; autoplay"></iframe>`;
  }, 400);
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
    document.querySelector('#auth-note').textContent = 'Ссылка отправлена. Откройте письмо от Supabase и нажмите кнопку входа.';
    showStatus('Письмо для входа отправлено', 'success', 3000);
  } catch (error) {
    document.querySelector('#auth-note').textContent = `Не удалось отправить письмо: ${error.message}`;
  } finally {
    button.classList.remove('is-busy');
  }
});

addEventListener('beforeinstallprompt', event => {
  event.preventDefault();
  installPrompt = event;
  document.querySelector('#install-button').hidden = false;
});

document.querySelector('#install-button').onclick = async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  document.querySelector('#install-button').hidden = true;
};

async function boot() {
  const first = location.hash.slice(1);
  const initialView = ['dashboard', 'request', 'chat', 'calls', 'profile'].includes(first) ? first : 'dashboard';
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
    const workspace = await backend.loadWorkspace();
    requests = workspace.requests.map(mapRequest);
    messages = workspace.messages.map(mapMessage);
    profile = {
      name: workspace.profile?.full_name || '', phone: workspace.profile?.phone || '',
      email: currentUser.email || '', role: workspace.profile?.role || 'client'
    };
    await backend.subscribeToMessages(row => appendMessage(mapMessage(row)));
    authGate.hidden = true;
    appStatus.hidden = true;
    updateProfile(); renderDashboard(); renderMessages(); go(initialView);
  } catch (error) {
    showStatus(`Сервер пока не готов: ${error.message}`, 'error');
    updateProfile(); renderDashboard(); renderMessages();
  }
}

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
boot();
