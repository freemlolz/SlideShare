export function createPollLauncher({ root, onStart, onManage, onDismiss }) {
  root.innerHTML = `<section class="poll-launcher-panel" id="poll-launcher-panel" aria-label="Швидкий запуск опитувань" hidden>
    <div class="poll-launcher-handle"><div><strong>Швидкий запуск</strong><span>Лише ведучому · перетягніть за заголовок</span></div><button type="button" id="poll-launcher-close" aria-label="Згорнути віджет опитувань">×</button></div>
    <div class="poll-launcher-body"><p class="poll-launcher-status" role="status"></p><p class="poll-launcher-error error" role="alert" hidden></p><div class="poll-launcher-list"></div>
    <button type="button" class="poll-launcher-return" hidden>Повернутися до слайдів</button><button type="button" class="poll-launcher-manage">Створити / редагувати питання</button>
    <p class="poll-launcher-hint">Учасники бачать лише запущене питання та результати.</p></div></section>
    <button type="button" id="poll-launcher-toggle" class="poll-launcher-toggle" aria-expanded="false" aria-controls="poll-launcher-panel"><span aria-hidden="true">▤</span><span class="poll-launcher-caption">Опитування</span><span class="poll-launcher-count">0</span></button>`;
  const panel = root.querySelector('.poll-launcher-panel');
  const toggle = root.querySelector('#poll-launcher-toggle');
  const close = root.querySelector('#poll-launcher-close');
  const list = root.querySelector('.poll-launcher-list');
  const status = root.querySelector('.poll-launcher-status');
  const error = root.querySelector('.poll-launcher-error');
  const caption = root.querySelector('.poll-launcher-caption');
  const count = root.querySelector('.poll-launcher-count');
  const returnButton = root.querySelector('.poll-launcher-return');
  const handle = root.querySelector('.poll-launcher-handle');
  let state;
  let starting = false;
  let dismissing = false;
  let position = null;
  let drag = null;

  function clampPosition() {
    if (!position) return;
    const box = root.getBoundingClientRect();
    const width = document.documentElement.clientWidth;
    position.left = Math.max(8, Math.min(position.left, width - box.width - 8));
    position.top = Math.max(8, Math.min(position.top, innerHeight - box.height - 8));
    root.style.left = `${position.left}px`;
    root.style.top = `${position.top}px`;
    root.style.right = 'auto';
    root.style.bottom = 'auto';
  }

  function setOpen(open) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    root.classList.toggle('is-open', open);
    clampPosition();
  }

  function updateButtons() {
    const open = state?.poll?.status === 'open';
    const supported = state && Object.hasOwn(state, 'poll');
    const text = !supported ? 'Зачекайте з’єднання з оновленим сервером.' : open ? 'Голосування триває. Результати з’являться автоматично.'
      : state.poll ? 'Результати на екранах. Поверніться до слайдів або запустіть наступне питання.' : 'Оберіть питання — учасники матимуть 10 секунд.';
    if (status.textContent !== text) status.textContent = text;
    const label = open ? 'Голосування' : state?.poll ? 'Результати' : 'Опитування';
    if (caption.textContent !== label) caption.textContent = label;
    for (const button of list.querySelectorAll('button')) button.disabled = !supported || open || starting;
    returnButton.hidden = state?.poll?.status !== 'results';
    returnButton.disabled = dismissing;
  }

  toggle.addEventListener('click', () => setOpen(panel.hidden));
  close.addEventListener('click', () => { setOpen(false); toggle.focus(); });
  root.querySelector('.poll-launcher-manage').addEventListener('click', async () => {
    try { await onManage(); setOpen(false); }
    catch (failure) { error.textContent = failure.message; error.hidden = false; }
  });
  returnButton.addEventListener('click', async () => {
    if (dismissing || !state?.poll) return;
    dismissing = true;
    error.hidden = true;
    updateButtons();
    try { await onDismiss(state.poll.id); setOpen(false); }
    catch (failure) { error.textContent = failure.message; error.hidden = false; }
    finally { dismissing = false; updateButtons(); }
  });
  handle.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('button')) return;
    const box = root.getBoundingClientRect();
    drag = { pointerId: event.pointerId, offsetX: event.clientX - box.left, offsetY: event.clientY - box.top };
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', (event) => {
    if (drag?.pointerId !== event.pointerId) return;
    position = { left: event.clientX - drag.offsetX, top: event.clientY - drag.offsetY };
    clampPosition();
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    handle.addEventListener(name, () => { drag = null; });
  }
  window.addEventListener('resize', clampPosition);
  document.addEventListener('fullscreenchange', clampPosition);
  new ResizeObserver(clampPosition).observe(root);

  return {
    setPolls(polls) {
      list.replaceChildren();
      count.textContent = String(polls.length);
      if (!polls.length) {
        const empty = document.createElement('p');
        empty.className = 'poll-launcher-empty';
        empty.textContent = 'Ще немає збережених питань. Додайте їх кнопкою нижче.';
        list.append(empty);
      }
      for (const poll of polls) {
        const card = document.createElement('article');
        card.className = 'poll-launcher-item';
        const title = document.createElement('h3');
        title.textContent = poll.question;
        const detail = document.createElement('p');
        detail.textContent = `${poll.options.length} відповіді · 10 с`;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'poll-launcher-start';
        button.textContent = '▶ Запустити';
        button.setAttribute('aria-label', `Запустити: ${poll.question}`);
        button.addEventListener('click', async () => {
          if (starting || state?.poll?.status === 'open') return;
          starting = true;
          error.hidden = true;
          updateButtons();
          try { await onStart({ question: poll.question, options: [...poll.options] }); setOpen(false); }
          catch (failure) { error.textContent = failure.message; error.hidden = false; }
          finally { starting = false; updateButtons(); }
        });
        card.append(title, detail, button);
        list.append(card);
      }
      updateButtons();
      clampPosition();
    },
    update(nextState) { state = nextState; updateButtons(); },
  };
}
