const backend = window.SkalaBackend;

const STATUS_OPTIONS = [
  'Новая',
  'На обсуждении',
  'Оценка',
  'В работе',
  'На согласовании',
  'Завершён',
  'Отложен'
];

const state = {
  user: null,
  overview: { requests: [], profiles: [], me: null },
  clients: [],
  selectedClientId: null,
  selectedRequestId: null,
  messages: [],
  section: 'clients',
  search: '',
  messageToken: 0,
  chatTimer: null
};

const elements = {
  authGate: document.querySelector('#auth-gate'),
  accessGate: document.querySelector('#access-gate'),
  accessTitle: document.querySelector('#access-title'),
  accessMessage: document.querySelector('#access-message'),
  adminApp: document.querySelector('#admin-app'),
  appStatus: document.querySelector('#app-status'),
  toast: document.querySelector('#toast'),
  directoryList: document.querySelector('#directory-list'),
  directorySearch: document.querySelector('#directory-search'),
  emptyClient: document.querySelector('#empty-client'),
  clientWorkspace: document.querySelector('#client-workspace'),
  projectList: document.querySelector('#project-list'),
  chatBody: document.querySelector('#chat-body'),
  messageForm: document.querySelector('#message-form'),
  messageInput: document.querySelector('#message-input')
};

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[char]));

const padCount = value => String(value).padStart(2, '0');

function initials(value) {
  const parts = String(value || 'Клиент').trim().split(/\s+/).filter(Boolean);
  return parts.slice(0, 2).map(part => part[0]).join('').toUpperCase() || 'К';
}

function formatDate(value, options = { day: '2-digit', month: 'short' }) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('ru-RU', options).format(date);
}

function formatTime(value) {
  return formatDate(value, { hour: '2-digit', minute: '2-digit' });
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

function displayChatText(value) {
  const text = String(value || '').trim();
  if (/^(?:Интернет-звонок|Создана комната интернет-звонка)\s*:?\s*https?:\/\//i.test(text)) {
    return 'Пропущенный звонок';
  }
  return text;
}

function notify(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => elements.toast.classList.remove('show'), 3000);
}

function showStatus(message, type = '', duration = 0) {
  elements.appStatus.textContent = message;
  elements.appStatus.className = `app-status ${type}`.trim();
  elements.appStatus.hidden = false;
  clearTimeout(showStatus.timer);
  if (duration) showStatus.timer = setTimeout(() => { elements.appStatus.hidden = true; }, duration);
}

function showLogin() {
  elements.authGate.hidden = false;
  elements.accessGate.hidden = true;
  elements.adminApp.hidden = true;
  elements.appStatus.hidden = true;
}

function showAccessError(title, message) {
  elements.accessTitle.textContent = title;
  elements.accessMessage.textContent = message;
  elements.authGate.hidden = true;
  elements.accessGate.hidden = false;
  elements.adminApp.hidden = true;
  elements.appStatus.hidden = true;
}

function requestForClient(clientId) {
  return state.overview.requests
    .filter(request => request.user_id === clientId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function buildClients() {
  const records = new Map();
  state.overview.profiles
    .filter(profile => profile.id !== state.overview.me?.id)
    .forEach(profile => records.set(profile.id, {
      id: profile.id,
      name: profile.full_name || '',
      phone: profile.phone || '',
      email: '',
      createdAt: profile.created_at,
      requests: []
    }));

  state.overview.requests.forEach(request => {
    if (request.user_id === state.overview.me?.id) return;
    const existing = records.get(request.user_id) || {
      id: request.user_id,
      name: '',
      phone: '',
      email: '',
      createdAt: request.created_at,
      requests: []
    };
    existing.name ||= request.contact_name || '';
    existing.phone ||= request.phone || '';
    existing.email ||= request.email || '';
    existing.requests.push(request);
    records.set(request.user_id, existing);
  });

  state.clients = [...records.values()].map(client => {
    client.requests.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    const latest = client.requests[0];
    if (latest) {
      client.name ||= latest.contact_name || '';
      client.phone ||= latest.phone || '';
      client.email ||= latest.email || '';
    }
    client.name ||= client.email || 'Клиент Skala';
    client.lastActivity = latest?.updated_at || latest?.created_at || client.createdAt;
    return client;
  }).sort((a, b) => new Date(b.lastActivity || 0) - new Date(a.lastActivity || 0));
}

function renderMetrics() {
  const inactiveStatuses = new Set(['Завершён', 'Завершена', 'Отложен', 'Отложена']);
  const active = state.overview.requests.filter(request => !inactiveStatuses.has(request.status)).length;
  document.querySelector('#clients-count').textContent = padCount(state.clients.length);
  document.querySelector('#requests-count').textContent = padCount(state.overview.requests.length);
  document.querySelector('#active-count').textContent = padCount(active);
}

function clientSearchText(client) {
  return [client.name, client.phone, client.email, ...client.requests.flatMap(request => [
    request.display_id, request.project_type, request.status, request.idea
  ])].join(' ').toLocaleLowerCase('ru');
}

function directoryClientHtml(client) {
  const latest = client.requests[0];
  const active = client.id === state.selectedClientId ? ' active' : '';
  const subtitle = latest?.project_type || client.email || client.phone || 'Пока без заявок';
  return `<button class="directory-item${active}" type="button" data-client-id="${escapeHtml(client.id)}">
    <span class="directory-avatar">${escapeHtml(initials(client.name))}</span>
    <span class="directory-main"><strong>${escapeHtml(client.name)}</strong><small>${escapeHtml(subtitle)}</small></span>
    <span class="directory-side"><time>${escapeHtml(formatDate(client.lastActivity))}</time><span class="project-badge">${client.requests.length}</span></span>
  </button>`;
}

function directoryRequestHtml(request) {
  const client = state.clients.find(item => item.id === request.user_id);
  const active = request.id === state.selectedRequestId ? ' active' : '';
  return `<button class="directory-item${active}" type="button" data-client-id="${escapeHtml(request.user_id)}" data-request-id="${escapeHtml(request.id)}">
    <span class="directory-avatar">${escapeHtml(initials(client?.name || request.contact_name))}</span>
    <span class="directory-main"><strong>${escapeHtml(request.project_type)}</strong><small>${escapeHtml(client?.name || request.contact_name || request.display_id)}</small></span>
    <span class="directory-side"><time>${escapeHtml(formatDate(request.created_at))}</time><span class="project-badge">${escapeHtml(request.status || 'Новая')}</span></span>
  </button>`;
}

function renderDirectory() {
  const isClients = state.section === 'clients';
  document.querySelector('#directory-eyebrow').textContent = isClients ? 'Клиенты' : 'Заявки';
  document.querySelector('#directory-title').textContent = isClients ? 'Рабочие диалоги' : 'Очередь проектов';
  elements.directorySearch.placeholder = isClients ? 'Найти клиента' : 'Найти заявку';
  document.querySelectorAll('[data-section]').forEach(button => button.classList.toggle('active', button.dataset.section === state.section));

  const query = state.search.trim().toLocaleLowerCase('ru');
  if (isClients) {
    const clients = state.clients.filter(client => !query || clientSearchText(client).includes(query));
    document.querySelector('#directory-count').textContent = clients.length;
    elements.directoryList.innerHTML = clients.length
      ? clients.map(directoryClientHtml).join('')
      : '<div class="list-empty">Клиенты не найдены.<br>Попробуйте изменить запрос.</div>';
    return;
  }

  const requests = state.overview.requests.filter(request => {
    if (!query) return true;
    const client = state.clients.find(item => item.id === request.user_id);
    return [request.display_id, request.project_type, request.status, request.idea, client?.name, request.contact_name]
      .join(' ').toLocaleLowerCase('ru').includes(query);
  });
  document.querySelector('#directory-count').textContent = requests.length;
  elements.directoryList.innerHTML = requests.length
    ? requests.map(directoryRequestHtml).join('')
    : '<div class="list-empty">Заявки не найдены.<br>Попробуйте изменить запрос.</div>';
}

function statusOptions(current) {
  const options = STATUS_OPTIONS.includes(current) || !current ? STATUS_OPTIONS : [current, ...STATUS_OPTIONS];
  return options.map(status => `<option value="${escapeHtml(status)}"${status === current ? ' selected' : ''}>${escapeHtml(status)}</option>`).join('');
}

function projectHtml(request) {
  const focused = request.id === state.selectedRequestId ? ' focused' : '';
  const reference = safeUrl(request.reference_url);
  const meta = [
    request.budget ? `<span>Бюджет: ${escapeHtml(request.budget)}</span>` : '',
    request.deadline ? `<span>Срок: ${escapeHtml(formatDate(request.deadline, { day: '2-digit', month: 'long', year: 'numeric' }))}</span>` : '',
    reference ? `<a class="project-link" href="${escapeHtml(reference)}" target="_blank" rel="noopener noreferrer">Открыть пример ↗</a>` : ''
  ].filter(Boolean).join('');
  return `<article class="project-card${focused}" data-project-card="${escapeHtml(request.id)}">
    <div class="project-card-top">
      <span class="project-id">${escapeHtml(request.display_id || 'Заявка')} · ${escapeHtml(formatDate(request.created_at))}</span>
      <select class="status-select" data-request-status="${escapeHtml(request.id)}" aria-label="Статус заявки ${escapeHtml(request.display_id || '')}">${statusOptions(request.status)}</select>
    </div>
    <h4>${escapeHtml(request.project_type || 'Новый проект')}</h4>
    <p>${escapeHtml(request.idea || 'Описание пока не добавлено.')}</p>
    ${meta ? `<div class="project-meta">${meta}</div>` : ''}
  </article>`;
}

function renderSelectedClient() {
  const client = state.clients.find(item => item.id === state.selectedClientId);
  elements.emptyClient.hidden = Boolean(client);
  elements.clientWorkspace.hidden = !client;
  if (!client) return;

  document.querySelector('#client-avatar').textContent = initials(client.name);
  document.querySelector('#client-name').textContent = client.name;
  const contacts = [client.email, client.phone].filter(Boolean);
  document.querySelector('#client-contacts').textContent = contacts.join(' · ') || 'Контактные данные не указаны';
  const phoneLink = document.querySelector('#client-phone-link');
  phoneLink.hidden = !client.phone;
  phoneLink.href = client.phone ? `tel:${client.phone.replace(/[^+\d]/g, '')}` : '#';
  document.querySelector('#client-request-count').textContent = client.requests.length;
  elements.projectList.innerHTML = client.requests.length
    ? client.requests.map(projectHtml).join('')
    : '<div class="no-projects">У клиента пока нет заявок. Переписку можно начать прямо сейчас.</div>';
  renderMessages();
}

function renderMessages(loading = false) {
  if (!state.selectedClientId) {
    elements.chatBody.innerHTML = '';
    return;
  }
  if (loading) {
    elements.chatBody.innerHTML = '<div class="chat-empty chat-loading">Загружаем переписку…</div>';
    return;
  }
  if (!state.messages.length) {
    elements.chatBody.innerHTML = '<div class="chat-empty">Сообщений пока нет. Напишите клиенту — ответ появится в его личном кабинете.</div>';
    return;
  }

  elements.chatBody.innerHTML = `<div class="chat-day">Переписка Skala</div>${state.messages.map(message => {
    const side = message.kind === 'system' ? 'system' : message.sender_id === state.selectedClientId ? 'incoming' : 'outgoing';
    const attachment = message.attachment_name ? `\nВложение: ${message.attachment_name}` : '';
    const sender = side === 'incoming' ? 'Клиент' : side === 'outgoing' ? 'Skala' : '';
    return `<div class="message ${side}">${escapeHtml(`${displayChatText(message.body)}${attachment}`)}<small>${escapeHtml([sender, formatTime(message.created_at)].filter(Boolean).join(' · '))}</small></div>`;
  }).join('')}`;
  requestAnimationFrame(() => { elements.chatBody.scrollTop = elements.chatBody.scrollHeight; });
}

async function loadMessages(clientId, { quiet = false } = {}) {
  if (!clientId) return;
  const token = ++state.messageToken;
  if (!quiet) renderMessages(true);
  try {
    const messages = await backend.adminMessages(clientId);
    if (token !== state.messageToken || clientId !== state.selectedClientId) return;
    const previousLastId = state.messages.at(-1)?.id;
    state.messages = messages;
    renderMessages();
    if (quiet && previousLastId && messages.at(-1)?.id !== previousLastId) notify('В чате новое сообщение');
  } catch (error) {
    if (!quiet && token === state.messageToken) {
      elements.chatBody.innerHTML = `<div class="chat-empty">Не удалось загрузить чат: ${escapeHtml(error.message)}</div>`;
    }
  }
}

function selectClient(clientId, requestId = null) {
  if (!state.clients.some(client => client.id === clientId)) return;
  state.selectedClientId = clientId;
  state.selectedRequestId = requestId;
  state.messages = [];
  renderDirectory();
  renderSelectedClient();
  loadMessages(clientId);
  if (requestId) {
    requestAnimationFrame(() => document.querySelector(`[data-project-card="${CSS.escape(requestId)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }
}

function renderAll() {
  buildClients();
  if (state.selectedClientId && !state.clients.some(client => client.id === state.selectedClientId)) {
    state.selectedClientId = null;
    state.selectedRequestId = null;
  }
  if (!state.selectedClientId && state.clients.length) state.selectedClientId = state.clients[0].id;
  renderMetrics();
  renderDirectory();
  renderSelectedClient();
}

async function refreshOverview({ quiet = false } = {}) {
  const button = document.querySelector('#refresh-button');
  button.classList.add('is-busy');
  if (!quiet) showStatus('Обновляем рабочее пространство…');
  try {
    state.overview = await backend.adminOverview();
    renderAll();
    document.querySelector('#sync-time').textContent = `Обновлено ${formatTime(new Date())}`;
    elements.appStatus.hidden = true;
    if (state.selectedClientId) await loadMessages(state.selectedClientId, { quiet });
    if (!quiet) notify('Данные обновлены');
  } finally {
    button.classList.remove('is-busy');
  }
}

document.querySelector('#auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  const email = document.querySelector('#auth-email').value.trim();
  const button = event.currentTarget.querySelector('button');
  button.classList.add('is-busy');
  try {
    await backend.signIn(email);
    document.querySelector('#auth-note').textContent = 'Ссылка отправлена. Откройте письмо и подтвердите вход.';
  } catch (error) {
    document.querySelector('#auth-note').textContent = `Не удалось отправить письмо: ${error.message}`;
  } finally {
    button.classList.remove('is-busy');
  }
});

document.querySelectorAll('[data-section]').forEach(button => button.addEventListener('click', () => {
  state.section = button.dataset.section;
  state.search = '';
  elements.directorySearch.value = '';
  renderDirectory();
}));

elements.directorySearch.addEventListener('input', event => {
  state.search = event.target.value;
  renderDirectory();
});

elements.directoryList.addEventListener('click', event => {
  const item = event.target.closest('[data-client-id]');
  if (!item) return;
  selectClient(item.dataset.clientId, item.dataset.requestId || null);
});

elements.projectList.addEventListener('change', async event => {
  const select = event.target.closest('[data-request-status]');
  if (!select) return;
  const request = state.overview.requests.find(item => item.id === select.dataset.requestStatus);
  if (!request || request.status === select.value) return;
  const previous = request.status;
  select.classList.add('is-busy');
  try {
    await backend.updateRequestStatus(request.id, select.value);
    request.status = select.value;
    request.updated_at = new Date().toISOString();
    buildClients();
    renderMetrics();
    renderDirectory();
    notify(`Статус ${request.display_id || 'заявки'} обновлён`);
  } catch (error) {
    select.value = previous;
    notify(`Не удалось изменить статус: ${error.message}`);
  } finally {
    select.classList.remove('is-busy');
  }
});

elements.messageForm.addEventListener('submit', async event => {
  event.preventDefault();
  const clientId = state.selectedClientId;
  const text = elements.messageInput.value.trim();
  if (!clientId || !text) return;
  const button = event.currentTarget.querySelector('button');
  button.classList.add('is-busy');
  elements.messageInput.disabled = true;
  try {
    const message = await backend.sendAdminMessage(clientId, text);
    elements.messageInput.value = '';
    state.messages.push(message);
    renderMessages();
    notify('Сообщение отправлено');
  } catch (error) {
    notify(`Не удалось отправить сообщение: ${error.message}`);
  } finally {
    button.classList.remove('is-busy');
    elements.messageInput.disabled = false;
    elements.messageInput.focus();
  }
});

elements.messageInput.addEventListener('input', event => {
  event.target.style.height = 'auto';
  event.target.style.height = `${Math.min(event.target.scrollHeight, 100)}px`;
});

document.querySelector('#refresh-button').addEventListener('click', () => {
  refreshOverview().catch(error => showStatus(`Не удалось обновить данные: ${error.message}`, 'error', 4500));
});

document.querySelector('#refresh-chat').addEventListener('click', () => loadMessages(state.selectedClientId));

async function signOut() {
  clearInterval(state.chatTimer);
  try { await backend.signOut(); } finally { showLogin(); }
}

document.querySelector('#logout-button').addEventListener('click', signOut);
document.querySelector('#access-logout').addEventListener('click', signOut);

async function boot() {
  showStatus('Проверяем доступ…');
  try {
    const session = await backend.init((event, user) => {
      if (event === 'SIGNED_IN' && user && !state.user) location.reload();
      if (event === 'SIGNED_OUT') {
        state.user = null;
        showLogin();
      }
    });

    if (!session.configured) {
      showAccessError('Сервер не настроен', 'Добавьте публичные параметры Supabase, чтобы открыть кабинет команды.');
      return;
    }
    if (!session.user) {
      showLogin();
      return;
    }

    state.user = session.user;
    state.overview = await backend.adminOverview();
    document.querySelector('#admin-email').textContent = state.user.email || 'Администратор';
    document.querySelector('#admin-name').textContent = state.user.user_metadata?.full_name || 'Команда Skala';
    document.querySelector('#admin-avatar').textContent = initials(state.user.user_metadata?.full_name || state.user.email || 'S');
    elements.authGate.hidden = true;
    elements.accessGate.hidden = true;
    elements.adminApp.hidden = false;
    elements.appStatus.hidden = true;
    renderAll();
    document.querySelector('#sync-time').textContent = `Обновлено ${formatTime(new Date())}`;
    if (state.selectedClientId) await loadMessages(state.selectedClientId);
    state.chatTimer = setInterval(() => {
      if (!document.hidden && state.selectedClientId) loadMessages(state.selectedClientId, { quiet: true });
    }, 12000);
  } catch (error) {
    const denied = /доступ только|permission|policy|admin/i.test(error.message || '');
    showAccessError(
      denied ? 'Нет доступа' : 'Не удалось открыть кабинет',
      denied ? 'Этот аккаунт не входит в команду Skala.' : `Проверьте подключение и попробуйте ещё раз. ${error.message || ''}`
    );
  }
}

boot();
