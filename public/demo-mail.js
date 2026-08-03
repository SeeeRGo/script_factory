const loginView = document.getElementById('mail-login-view');
const mailboxView = document.getElementById('mailbox-view');
const loginForm = document.getElementById('mail-login-form');
const composeForm = document.getElementById('mail-compose-form');
const composePanel = document.getElementById('mail-compose-panel');
const success = document.getElementById('mail-send-success');
const inboxView = document.getElementById('mail-inbox-view');
const sentView = document.getElementById('mail-sent-view');
let messages = [];

async function api(path, options = {}) {
  const response = await fetch(`/demo/mail/api/${path}`, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || `Ошибка ${response.status}`);
  return data;
}

function setAuthenticated(account) {
  loginView.hidden = true;
  mailboxView.hidden = false;
  document.getElementById('mail-account').textContent = account;
}

function renderSent() {
  document.getElementById('mail-sent-count').textContent = String(messages.length);
  const list = document.getElementById('mail-sent-list');
  if (messages.length === 0) {
    list.innerHTML = '<p class="empty-mail">Отправленных писем пока нет.</p>';
    return;
  }
  list.replaceChildren(...messages.map((message) => {
    const row = document.createElement('div');
    row.className = 'message-row sent-message';
    row.dataset.messageId = message.message_id;
    row.dataset.subject = message.subject;
    const to = document.createElement('strong');
    to.textContent = message.to;
    const subject = document.createElement('span');
    subject.textContent = message.subject;
    const time = document.createElement('time');
    time.textContent = new Date(message.sent_at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    row.append(to, subject, time);
    return row;
  }));
}

function showFolder(folder) {
  const sent = folder === 'sent';
  inboxView.hidden = sent;
  sentView.hidden = !sent;
  document.getElementById('mail-folder-inbox').classList.toggle('active', !sent);
  document.getElementById('mail-folder-sent').classList.toggle('active', sent);
  if (sent) renderSent();
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.getElementById('mail-login-error');
  error.hidden = true;
  const values = Object.fromEntries(new FormData(loginForm));
  try {
    const state = await api('login', { method: 'POST', body: JSON.stringify(values) });
    setAuthenticated(state.account);
  } catch (requestError) {
    error.textContent = requestError.message;
    error.hidden = false;
  }
});

document.getElementById('mail-compose').addEventListener('click', () => {
  composePanel.hidden = false;
  success.hidden = true;
  document.getElementById('mail-to').focus();
});
document.getElementById('mail-compose-close').addEventListener('click', () => { composePanel.hidden = true; });
document.getElementById('mail-folder-inbox').addEventListener('click', () => showFolder('inbox'));
document.getElementById('mail-folder-sent').addEventListener('click', () => showFolder('sent'));

composeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = document.getElementById('mail-send-error');
  error.hidden = true;
  const values = Object.fromEntries(new FormData(composeForm));
  try {
    const data = await api('send', { method: 'POST', body: JSON.stringify(values) });
    messages.unshift(data.message);
    composePanel.hidden = true;
    composeForm.reset();
    success.hidden = false;
    showFolder('sent');
  } catch (requestError) {
    error.textContent = requestError.message;
    error.hidden = false;
  }
});

document.getElementById('mail-logout').addEventListener('click', async () => {
  await api('logout', { method: 'POST' });
  location.reload();
});

const state = await api('state');
if (state.authenticated) {
  messages = state.messages;
  setAuthenticated(state.account);
  renderSent();
}
