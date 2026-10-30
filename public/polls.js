const symbols = ['▲', '◆', '●', '■'];
const letters = ['A', 'B', 'C', 'D'];

export function createPollScreen({ root, role, onVote, onDismiss, onError }) {
  const headingId = `${root.id}-question`;
  root.innerHTML = `<div class="poll-meta"><span class="poll-eyebrow">ОПИТУВАННЯ · 10 СЕКУНД</span><span class="poll-clock" role="timer" aria-label="Залишилось секунд">10</span></div>
    <progress class="poll-time" max="10000" value="10000" aria-label="Час для голосування"></progress>
    <h2 id="${headingId}" tabindex="-1"></h2><p class="poll-status" role="status"></p>
    <div class="poll-answers"></div><div class="poll-bottom"><span class="poll-total"></span><button type="button" class="poll-dismiss" hidden></button></div>`;
  root.setAttribute('aria-labelledby', headingId);
  const question = root.querySelector('h2');
  const clock = root.querySelector('.poll-clock');
  const progress = root.querySelector('.poll-time');
  const status = root.querySelector('.poll-status');
  const total = root.querySelector('.poll-total');
  const answers = root.querySelector('.poll-answers');
  const dismiss = root.querySelector('.poll-dismiss');
  let state;
  let receivedAt = 0;
  let pollId;
  let pendingPollId = null;
  let dismissingPollId = null;
  let timer;

  function remaining() {
    return Math.max(0, state.poll.endsAt - state.serverTime - (performance.now() - receivedAt));
  }

  function render() {
    if (!state?.poll) return;
    const poll = state.poll;
    const open = poll.status === 'open';
    const milliseconds = open ? remaining() : 0;
    const clockText = open ? String(Math.ceil(milliseconds / 1000)) : '✓';
    if (clock.textContent !== clockText) {
      clock.textContent = clockText;
      clock.setAttribute('aria-label', open ? `Залишилось секунд: ${clockText}` : 'Голосування завершено');
    }
    progress.value = milliseconds;
    root.dataset.phase = poll.status;
    const message = !open ? 'Результати голосування' : milliseconds === 0 ? 'Час вичерпано. Очікуємо результати…'
      : poll.vote !== null ? 'Ваш голос зараховано. Очікуємо результати!' : role === 'host' ? 'Учасники обирають відповідь на телефонах' : 'Оберіть одну відповідь';
    if (status.textContent !== message) status.textContent = message;
    const totalText = `Голосів: ${poll.total}`;
    if (total.textContent !== totalText) total.textContent = totalText;
    dismiss.hidden = role !== 'host';
    const dismissText = open ? 'Скасувати опитування' : 'До слайдів';
    if (dismiss.textContent !== dismissText) dismiss.textContent = dismissText;
    dismiss.disabled = dismissingPollId === poll.id;
    for (const [index, button] of [...answers.children].entries()) {
      button.disabled = role === 'host' || !open || milliseconds === 0 || pendingPollId === poll.id || poll.vote !== null;
      button.classList.toggle('is-selected', poll.vote === index);
      if (role === 'viewer') button.setAttribute('aria-pressed', String(poll.vote === index));
      const selection = button.querySelector('.poll-selection');
      selection.hidden = poll.vote !== index;
      const result = button.querySelector('.poll-result');
      result.hidden = open;
      if (!open) {
        const count = poll.counts[index];
        const percentage = poll.total ? Math.round(count / poll.total * 100) : 0;
        result.querySelector('span').textContent = `${count} · ${percentage}%`;
        result.querySelector('progress').value = percentage;
      }
    }
  }

  dismiss.addEventListener('click', async () => {
    if (!state?.poll || dismissingPollId === state.poll.id) return;
    if (state.poll.status === 'open' && !confirm('Скасувати опитування без показу результатів?')) return;
    const currentId = state.poll.id;
    dismissingPollId = currentId;
    render();
    try { await onDismiss(currentId); }
    catch (error) { if (state.poll?.id === currentId) onError(error.message); }
    finally { if (dismissingPollId === currentId) dismissingPollId = null; render(); }
  });

  return {
    update(nextState) {
      state = nextState;
      receivedAt = performance.now();
      const poll = state.poll;
      root.hidden = !poll;
      root.closest('.stage').classList.toggle('poll-active', Boolean(poll));
      if (!poll) { clearInterval(timer); timer = null; pollId = null; return; }
      if (pollId !== poll.id) {
        pollId = poll.id;
        question.textContent = poll.question;
        answers.replaceChildren();
        for (const [index, option] of poll.options.entries()) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = `poll-answer poll-color-${index}`;
          button.dataset.answer = index;
          button.innerHTML = `<span class="poll-symbol" aria-hidden="true">${symbols[index]}</span><span class="poll-answer-copy"><span class="poll-answer-text"></span><span class="poll-selection" hidden>Ваш вибір</span></span><span class="poll-result" hidden><span></span><progress max="100" value="0" aria-label="Частка голосів"></progress></span>`;
          button.querySelector('.poll-answer-text').textContent = `${letters[index]}. ${option}`;
          button.addEventListener('click', async () => {
            if (pendingPollId === poll.id || state.poll?.id !== poll.id || state.poll.vote !== null || remaining() === 0) return;
            pendingPollId = poll.id;
            render();
            try { await onVote(poll.id, index); }
            catch (error) { if (state.poll?.id === poll.id) onError(error.message); }
            finally { if (pendingPollId === poll.id) pendingPollId = null; render(); }
          });
          answers.append(button);
        }
      }
      if (poll.status === 'open' && !timer) timer = setInterval(render, 100);
      if (poll.status === 'results') { clearInterval(timer); timer = null; }
      render();
    },
  };
}

export function createPollLibrary({ root, onStart, onChange }) {
  const storageKey = 'slidesync-polls-v1';
  root.innerHTML = `<div class="poll-library-heading"><div><p class="eyebrow">ЗАПИТАЙТЕ АУДИТОРІЮ</p><h2>Швидкі опитування</h2></div><button type="button" id="poll-new">+ Створити</button></div>
    <p class="small muted">2 або 4 відповіді · 10 секунд · результати на всіх екранах</p>
    <p class="small muted">Збережені питання залишаються в цьому браузері ноутбука. Після перезапуску сервера голоси не зберігаються.</p>
    <p id="poll-library-message" class="small" role="status"></p><div id="poll-list" class="poll-list"></div>
    <form id="poll-form" class="poll-editor" hidden><h3 id="poll-editor-title">Нове опитування</h3>
      <label for="poll-question">Запитання</label><textarea id="poll-question" maxlength="200" rows="2" required placeholder="Що обговоримо далі?"></textarea>
      <label for="poll-options-count">Кількість відповідей</label><select id="poll-options-count"><option value="2">2 відповіді</option><option value="4">4 відповіді</option></select>
      <div class="poll-option-fields"></div><p id="poll-editor-error" class="error" role="alert" hidden></p>
      <div class="poll-editor-actions"><button type="submit" class="primary" id="poll-save">Зберегти опитування</button><button type="button" id="poll-discard">Закрити редактор</button></div></form>`;
  const find = (selector) => root.querySelector(selector);
  const form = find('#poll-form');
  const message = find('#poll-library-message');
  const error = find('#poll-editor-error');
  const list = find('#poll-list');
  const fields = find('.poll-option-fields');
  let bank = [];
  let editing = null;
  let state;
  let starting = false;
  for (let index = 0; index < 4; index += 1) {
    const label = document.createElement('label');
    label.className = `poll-option-field poll-field-${index}`;
    label.textContent = `${symbols[index]} Відповідь ${letters[index]}`;
    const input = document.createElement('input');
    input.id = `poll-option-${index}`;
    input.maxLength = 100;
    input.type = 'text';
    label.append(input);
    fields.append(label);
  }
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    if (!Array.isArray(saved) || saved.length > 50 || saved.some((poll) => !poll || typeof poll.id !== 'string'
      || typeof poll.question !== 'string' || !poll.question.trim() || poll.question.length > 200
      || !Array.isArray(poll.options) || ![2, 4].includes(poll.options.length)
      || poll.options.some((option) => typeof option !== 'string' || !option.trim() || option.length > 100))) throw new Error();
    bank = saved;
  } catch { message.textContent = 'Не вдалося прочитати збережені опитування. Можна створити нові.'; }

  function persist() {
    try { localStorage.setItem(storageKey, JSON.stringify(bank)); message.textContent = 'Опитування збережено в цьому браузері.'; }
    catch { message.textContent = 'Сховище браузера недоступне. Опитування збережено лише до закриття цієї вкладки.'; }
    renderList();
  }

  function updateButtons() {
    for (const button of list.querySelectorAll('.poll-start')) button.disabled = starting || state?.poll?.status === 'open';
  }

  function optionCount() {
    const count = Number(find('#poll-options-count').value);
    for (const [index, field] of [...fields.children].entries()) {
      field.hidden = index >= count;
      field.querySelector('input').required = index < count;
      field.querySelector('input').disabled = index >= count;
    }
  }

  function edit(poll) {
    editing = poll?.id ?? null;
    find('#poll-editor-title').textContent = poll ? 'Редагувати опитування' : 'Нове опитування';
    find('#poll-question').value = poll?.question ?? '';
    find('#poll-options-count').value = String(poll?.options.length ?? 2);
    for (let index = 0; index < 4; index += 1) find(`#poll-option-${index}`).value = poll?.options[index] ?? '';
    optionCount();
    error.hidden = true;
    form.hidden = false;
    find('#poll-question').focus();
  }

  function renderList() {
    list.replaceChildren();
    if (!bank.length) {
      const empty = document.createElement('p');
      empty.className = 'small muted';
      empty.textContent = 'Питань ще немає. Створіть перше опитування.';
      list.append(empty);
    }
    for (const poll of bank) {
      const card = document.createElement('article');
      card.className = 'poll-card';
      const title = document.createElement('h3');
      title.textContent = poll.question;
      const detail = document.createElement('p');
      detail.className = 'small muted';
      detail.textContent = `${poll.options.length} відповіді · 10 секунд`;
      const actions = document.createElement('div');
      actions.className = 'poll-card-actions';
      for (const [action, caption] of [['start', 'Запустити · 10 с'], ['edit', 'Редагувати'], ['duplicate', 'Копія'], ['delete', 'Видалити']]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `poll-${action}${action === 'start' ? ' primary' : ''}`;
        button.textContent = caption;
        button.addEventListener('click', async () => {
          if (action === 'edit') { edit(poll); return; }
          if (action === 'duplicate') {
            if (bank.length >= 50) { message.textContent = 'Максимум 50 опитувань. Видаліть зайві.'; return; }
            const copy = { ...poll, id: crypto.randomUUID(), options: [...poll.options] };
            bank.push(copy);
            persist();
            edit(copy);
            return;
          }
          if (action === 'delete') {
            if (!confirm('Видалити це збережене опитування?')) return;
            bank = bank.filter((entry) => entry.id !== poll.id);
            if (editing === poll.id) { editing = null; form.hidden = true; }
            persist();
            return;
          }
          if (starting || state?.poll?.status === 'open') return;
          starting = true;
          updateButtons();
          try { await onStart({ question: poll.question, options: poll.options }); }
          catch (failure) { message.textContent = failure.message; }
          finally { starting = false; updateButtons(); }
        });
        actions.append(button);
      }
      card.append(title, detail, actions);
      list.append(card);
    }
    updateButtons();
    onChange?.(bank.map((poll) => ({ ...poll, options: [...poll.options] })));
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const question = find('#poll-question').value.trim();
    const options = Array.from({ length: Number(find('#poll-options-count').value) }, (_, index) => find(`#poll-option-${index}`).value.trim());
    if (!question || options.some((option) => !option) || new Set(options.map((option) => option.toLocaleLowerCase())).size !== options.length) {
      error.textContent = 'Додайте запитання та різні, непорожні відповіді.';
      error.hidden = false;
      return;
    }
    if (!editing && bank.length >= 50) { error.textContent = 'Максимум 50 опитувань. Видаліть зайві.'; error.hidden = false; return; }
    const poll = { id: editing ?? crypto.randomUUID(), question, options };
    if (editing) bank = bank.map((entry) => entry.id === editing ? poll : entry);
    else bank.push(poll);
    persist();
    form.hidden = true;
    editing = null;
  });
  find('#poll-new').addEventListener('click', () => edit());
  find('#poll-discard').addEventListener('click', () => { form.hidden = true; editing = null; });
  find('#poll-options-count').addEventListener('change', optionCount);
  renderList();
  return { update(nextState) { state = nextState; updateButtons(); } };
}
