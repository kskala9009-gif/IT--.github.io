(function () {
  const MAX_FILE_SIZE = 10 * 1024 * 1024;
  const MAX_REQUEST_FILES = 5;
  const MAX_MESSAGE_LENGTH = 4000;
  const FILE_TYPES = Object.freeze({
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  });

  let client = null;
  let currentUser = null;
  let messageChannel = null;
  let authSubscription = null;
  let captchaWidgetId = null;
  let captchaToken = '';
  let captchaContainer = null;
  let captchaWaitTimer = null;
  let captchaWaitAttempts = 0;

  const config = () => window.SKALA_SUPABASE || {};

  const captchaConfigured = () => Boolean(String(config().turnstileSiteKey || '').trim());

  function mountCaptcha(container) {
    captchaContainer = container || null;
    if (!captchaContainer) return;
    clearTimeout(captchaWaitTimer);
    captchaWaitAttempts = 0;

    if (!captchaConfigured()) {
      captchaContainer.hidden = true;
      return;
    }

    captchaContainer.hidden = false;
    const render = () => {
      if (!window.turnstile?.render) {
        captchaWaitAttempts += 1;
        if (captchaWaitAttempts >= 100) {
          captchaContainer.textContent = 'Не удалось загрузить проверку безопасности. Обновите страницу.';
          return;
        }
        captchaWaitTimer = window.setTimeout(render, 150);
        return;
      }
      if (captchaWidgetId !== null) return;
      captchaWidgetId = window.turnstile.render(captchaContainer, {
        sitekey: String(config().turnstileSiteKey).trim(),
        theme: 'dark',
        callback: token => { captchaToken = String(token || ''); },
        'expired-callback': () => { captchaToken = ''; },
        'error-callback': () => { captchaToken = ''; }
      });
    };
    render();
  }

  function resetCaptcha() {
    captchaToken = '';
    if (captchaWidgetId !== null && window.turnstile?.reset) {
      window.turnstile.reset(captchaWidgetId);
    }
  }

  const configured = () => {
    const { url, publishableKey } = config();
    try {
      return new URL(String(url || '')).protocol === 'https:' && Boolean(String(publishableKey || '').trim());
    } catch {
      return false;
    }
  };

  const requireClient = () => {
    if (!client || !currentUser) throw new Error('Сначала войдите в приложение');
    return client;
  };

  const cleanFileName = value => {
    const cleaned = String(value || 'file')
      .normalize('NFKD')
      .replace(/[^a-zA-Z0-9а-яА-Я._-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(-120);
    return cleaned || 'file';
  };

  const originalFileName = value => String(value || 'file').trim().slice(-255) || 'file';

  function validateFile(file) {
    if (!(file instanceof Blob)) throw new Error('Не удалось прочитать выбранный файл');
    if (file.size > MAX_FILE_SIZE) throw new Error('Файл должен быть не больше 10 МБ');
    if (file.size <= 0) throw new Error('Нельзя отправить пустой файл');
    const name = originalFileName(file.name);
    const extension = name.toLowerCase().match(/\.[^.]+$/)?.[0] || '';
    const expectedType = FILE_TYPES[extension];
    const suppliedType = String(file.type || '').trim().toLowerCase();
    const normalizedType = suppliedType === 'image/jpg' ? 'image/jpeg' : suppliedType;
    if (!expectedType || (normalizedType && normalizedType !== expectedType)) {
      throw new Error('Разрешены только JPG, PNG, WEBP, PDF и DOCX');
    }
    return {
      name,
      contentType: expectedType
    };
  }

  async function removeObjectQuietly(api, path) {
    if (!path) return;
    try {
      const { error } = await api.storage.from('skala-files').remove([path]);
      if (error) console.warn('Не удалось удалить незавершённую загрузку', error);
    } catch (error) {
      console.warn('Не удалось удалить незавершённую загрузку', error);
    }
  }

  async function assertAdmin(api) {
    const { data, error } = await api.from('profiles')
      .select('role')
      .eq('id', currentUser.id)
      .maybeSingle();
    if (error) throw error;
    if (data?.role !== 'admin') throw new Error('Доступ только для команды Skala');
  }

  async function init(onAuthChange) {
    if (!configured()) return { configured: false, user: null };
    if (!window.supabase?.createClient) throw new Error('Не удалось загрузить модуль сервера');

    if (authSubscription) authSubscription.unsubscribe();
    authSubscription = null;

    const { url, publishableKey } = config();
    client = window.supabase.createClient(url, publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });

    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    currentUser = data.session?.user || null;

    const authListener = client.auth.onAuthStateChange((event, session) => {
      const previousUserId = currentUser?.id || null;
      currentUser = session?.user || null;

      if (messageChannel && previousUserId !== (currentUser?.id || null)) {
        const oldChannel = messageChannel;
        messageChannel = null;
        void client.removeChannel(oldChannel);
      }

      window.setTimeout(() => onAuthChange?.(event, currentUser), 0);
    });
    authSubscription = authListener.data.subscription;

    return { configured: true, user: currentUser };
  }

  async function signIn(email, { shouldCreateUser = true } = {}) {
    if (!client) throw new Error('Сервер ещё не настроен');
    const normalizedEmail = String(email || '').trim().toLowerCase();
    if (!normalizedEmail) throw new Error('Укажите email');
    if (captchaConfigured() && !captchaToken) throw new Error('Подтвердите, что вы не робот');

    const redirectTo = `${location.origin}${location.pathname}`;
    const { error } = await client.auth.signInWithOtp({
      email: normalizedEmail,
      options: {
        emailRedirectTo: redirectTo,
        shouldCreateUser: Boolean(shouldCreateUser),
        captchaToken: captchaToken || undefined
      }
    });
    if (error) throw error;
  }

  async function signOut() {
    if (!client) return;
    if (messageChannel) await client.removeChannel(messageChannel);
    messageChannel = null;

    const { error } = await client.auth.signOut();
    if (error) throw error;
    currentUser = null;
  }

  async function loadWorkspace() {
    const api = requireClient();
    const userId = currentUser.id;
    const [profileResult, requestsResult, messagesResult] = await Promise.all([
      api.from('profiles').select('id,full_name,phone,role').eq('id', userId).maybeSingle(),
      api.from('requests').select('*').order('created_at', { ascending: false }),
      api.from('messages').select('*').eq('client_id', userId).order('created_at', { ascending: true })
    ]);

    if (profileResult.error) throw profileResult.error;
    if (requestsResult.error) throw requestsResult.error;
    if (messagesResult.error) throw messagesResult.error;
    if (!profileResult.data) throw new Error('Профиль не создан. Выполните настройку базы ещё раз');

    return {
      user: currentUser,
      profile: profileResult.data,
      requests: requestsResult.data || [],
      messages: messagesResult.data || []
    };
  }

  async function loadMessages() {
    const api = requireClient();
    const { data, error } = await api.from('messages')
      .select('*')
      .eq('client_id', currentUser.id)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
  }

  async function saveProfile(profile) {
    const api = requireClient();
    const payload = {
      full_name: String(profile?.name || '').trim().slice(0, 160),
      phone: String(profile?.phone || '').trim().slice(0, 80)
    };
    const { data, error } = await api.from('profiles')
      .update(payload)
      .eq('id', currentUser.id)
      .select('id,full_name,phone,role')
      .single();
    if (error) throw error;
    return data;
  }

  async function createRequest(item, files) {
    const api = requireClient();
    const selectedFiles = Array.from(files || []).map(file => ({ file, ...validateFile(file) }));
    if (selectedFiles.length > MAX_REQUEST_FILES) {
      throw new Error(`К одной заявке можно прикрепить не больше ${MAX_REQUEST_FILES} файлов`);
    }
    const payload = {
      display_id: String(item.id || '').trim(),
      user_id: currentUser.id,
      contact_name: String(item.name || '').trim(),
      phone: String(item.phone || '').trim(),
      email: String(item.email || '').trim(),
      project_type: String(item.type || '').trim(),
      budget: String(item.budget || 'Пока не определён').trim(),
      idea: String(item.idea || '').trim(),
      deadline: item.deadline || null,
      reference_url: String(item.reference || '').trim(),
      styles: Array.isArray(item.styles) ? item.styles.map(String) : []
    };

    const { data: request, error } = await api.from('requests')
      .insert(payload)
      .select()
      .single();
    if (error) throw error;

    for (const selected of selectedFiles) {
      const path = `${currentUser.id}/requests/${request.id}/${crypto.randomUUID()}-${cleanFileName(selected.name)}`;
      const uploaded = await api.storage.from('skala-files').upload(path, selected.file, {
        contentType: selected.contentType,
        upsert: false
      });
      if (uploaded.error) throw uploaded.error;

      const recorded = await api.from('request_files').insert({
        request_id: request.id,
        owner_id: currentUser.id,
        storage_path: path,
        file_name: selected.name,
        content_type: selected.contentType,
        size_bytes: selected.file.size
      });
      if (recorded.error) {
        await removeObjectQuietly(api, path);
        throw recorded.error;
      }
    }

    const systemMessage = await api.from('messages').insert({
      client_id: currentUser.id,
      sender_id: currentUser.id,
      request_id: request.id,
      kind: 'system',
      body: `Создана заявка ${payload.display_id}: ${payload.project_type}`
    });
    if (systemMessage.error) throw systemMessage.error;

    return request;
  }

  async function sendMessage(text, file) {
    const api = requireClient();
    const body = String(text || '').trim();
    if (body.length > MAX_MESSAGE_LENGTH) throw new Error('Сообщение слишком длинное');
    if (!body && !file) throw new Error('Напишите сообщение или выберите файл');

    let attachmentPath = null;
    let attachmentName = null;
    let kind = 'text';

    if (file) {
      const details = validateFile(file);
      attachmentName = details.name;
      attachmentPath = `${currentUser.id}/chat/${crypto.randomUUID()}-${cleanFileName(details.name)}`;
      const uploaded = await api.storage.from('skala-files').upload(attachmentPath, file, {
        contentType: details.contentType,
        upsert: false
      });
      if (uploaded.error) throw uploaded.error;
      kind = 'file';
    }

    const messageBody = body || `Вложение: ${attachmentName}`;
    const { data, error } = await api.from('messages').insert({
      client_id: currentUser.id,
      sender_id: currentUser.id,
      body: messageBody,
      kind,
      attachment_path: attachmentPath,
      attachment_name: attachmentName
    }).select().single();

    if (error) {
      await removeObjectQuietly(api, attachmentPath);
      throw error;
    }
    return data;
  }

  async function subscribeToMessages(onMessage) {
    const api = requireClient();
    if (messageChannel) await api.removeChannel(messageChannel);

    const channel = api.channel(`skala-chat-${currentUser.id}`)
      .on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `client_id=eq.${currentUser.id}`
      }, payload => onMessage?.(payload.new));
    messageChannel = channel;

    return new Promise((resolve, reject) => {
      let settled = false;
      channel.subscribe(status => {
        if (status === 'SUBSCRIBED' && !settled) {
          settled = true;
          resolve(channel);
          return;
        }
        if (!settled && ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
          settled = true;
          if (messageChannel === channel) messageChannel = null;
          void api.removeChannel(channel);
          reject(new Error('Не удалось подключить обновления чата'));
        }
      });
    });
  }

  async function adminOverview() {
    const api = requireClient();
    await assertAdmin(api);

    const [requestsResult, profilesResult] = await Promise.all([
      api.from('requests').select('*').order('created_at', { ascending: false }),
      api.from('profiles').select('id,full_name,phone,created_at').order('created_at', { ascending: false })
    ]);
    if (requestsResult.error) throw requestsResult.error;
    if (profilesResult.error) throw profilesResult.error;
    return { requests: requestsResult.data || [], profiles: profilesResult.data || [], me: currentUser };
  }

  async function adminMessages(clientId) {
    const api = requireClient();
    await assertAdmin(api);
    if (!clientId) throw new Error('Не выбран клиент');

    const { data, error } = await api.from('messages')
      .select('*')
      .eq('client_id', clientId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
  }

  async function sendAdminMessage(clientId, text) {
    const api = requireClient();
    await assertAdmin(api);
    const body = String(text || '').trim();
    if (!clientId) throw new Error('Не выбран клиент');
    if (!body) throw new Error('Напишите сообщение');
    if (body.length > MAX_MESSAGE_LENGTH) throw new Error('Сообщение слишком длинное');

    const { data, error } = await api.from('messages').insert({
      client_id: clientId,
      sender_id: currentUser.id,
      body,
      kind: 'text'
    }).select().single();
    if (error) throw error;
    return data;
  }

  async function updateRequestStatus(requestId, status) {
    const api = requireClient();
    await assertAdmin(api);
    const nextStatus = String(status || '').trim();
    if (!requestId) throw new Error('Не выбрана заявка');
    if (!nextStatus || nextStatus.length > 120) throw new Error('Некорректный статус');

    const { data, error } = await api.from('requests')
      .update({ status: nextStatus })
      .eq('id', requestId)
      .select('id,status,updated_at')
      .single();
    if (error) throw error;
    return data;
  }

  window.SkalaBackend = {
    configured,
    mountCaptcha,
    resetCaptcha,
    init,
    signIn,
    signOut,
    loadWorkspace,
    loadMessages,
    saveProfile,
    createRequest,
    sendMessage,
    subscribeToMessages,
    adminOverview,
    adminMessages,
    sendAdminMessage,
    updateRequestStatus,
    get user() { return currentUser; }
  };
})();
