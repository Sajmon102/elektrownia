(() => {
  const { $, socket, rpc, esc, format, read, save, notice, sound } = Quiz;
  const pathCode = location.pathname.match(/^\/play\/(\d{3}-?\d{3})\/?$/)?.[1]?.replace('-', '');
  let session = read('quiz-player'), current, clockOffset = 0, pending = false;
  if (pathCode && session?.code !== pathCode) session = null;
  const code = document.createElement('input'); code.id = 'roomCode'; code.placeholder = 'Kod gry, np. 678-595'; code.inputMode = 'numeric'; code.maxLength = 7; code.setAttribute('aria-label', 'Kod gry');
  code.value = format(pathCode || session?.code || ''); $('name').before(code); $('name').setAttribute('aria-label', 'Twoje imię'); $('name').value = session?.name || '';
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:10px;align-items:stretch';
  const hostButton = document.createElement('a');
  hostButton.id = 'hostBtn'; hostButton.href = '/host?autostart=1'; hostButton.textContent = 'Hostuj';
  hostButton.style.cssText = 'display:flex;flex:1;align-items:center;justify-content:center;padding:17px;margin:7px 0;border-radius:12px;font-size:18px;font-weight:bold;background:#334155;color:white;text-decoration:none';
  $('joinBtn').before(actions); actions.append(hostButton, $('joinBtn')); $('joinBtn').style.flex = '1'; $('joinBtn').style.width = 'auto';
  $('join').querySelector('h2').textContent = 'Hostuj lub dołącz do gry';
  const timer = document.createElement('p'); timer.className = 'big'; $('game').append(timer);
  const meter = document.createElement('div'); meter.className = 'game-progress'; meter.setAttribute('aria-hidden', 'true'); meter.innerHTML = '<span></span>'; $('game').prepend(meter);
  const retry = document.createElement('button'); retry.textContent = 'Dołącz do kolejnej gry'; $('end').append(retry);
  const show = id => ['join', 'wait', 'game', 'end'].forEach(x => $(x).classList.toggle('hidden', x !== id));
  function reset(message) { session = current = null; pending = false; save('quiz-player', null); show('join'); $('msg').textContent = message; $('joinBtn').disabled = !socket.connected; }
  retry.onclick = async () => {
    try { await rpc('player:leave', {}); code.value = ''; reset('Wpisz kod nowej gry.'); }
    catch (err) { notice(err.message); }
  };
  code.addEventListener('input', () => { const digits = code.value.replace(/\D/g, '').slice(0, 6); code.value = digits.length > 3 ? digits.slice(0, 3) + '-' + digits.slice(3) : digits; });
  async function join(resume = false) {
    $('joinBtn').disabled = true;
    try {
      const r = await rpc('player:join', resume && session ? session : { code: code.value, name: $('name').value });
      session = { code: r.code, token: r.token, id: r.id, name: r.name }; save('quiz-player', session); $('msg').textContent = ''; render(r.state);
    } catch (err) { if (resume) reset(err.message); else $('msg').textContent = err.message; }
    finally { $('joinBtn').disabled = !socket.connected; }
  }
  $('joinBtn').disabled = true; $('joinBtn').onclick = () => join();
  [code, $('name')].forEach(input => input.addEventListener('keydown', e => { if (e.key === 'Enter' && !$('joinBtn').disabled) join(); }));
  document.querySelectorAll('[data-emoji]').forEach(b => { b.onclick = () => rpc('player:reaction', { emoji: b.dataset.emoji }).catch(err => notice(err.message)); });
  function tick() {
    const left = current?.deadline ? Math.max(0, Math.ceil((current.deadline - Date.now() - clockOffset) / 1000)) : 0;
    timer.textContent = current?.status === 'question' ? `⏱ ${left} s` : '';
    if (current?.status === 'countdown') $('question').textContent = String(left);
    const answered = current?.players.find(p => p.id === session?.id)?.answered;
    document.querySelectorAll('[data-answer]').forEach(b => { b.disabled = !socket.connected || pending || answered || left <= 0 || current?.status !== 'question'; });
  }
  function render(s) {
    if (!session || s.code !== session.code) return;
    if (current?.questionIndex !== s.questionIndex) pending = false;
    if (current?.status !== s.status || current?.questionIndex !== s.questionIndex) {
      if (['question', 'results', 'finished'].includes(s.status)) sound(s.status);
    }
    current = s; clockOffset = s.serverNow - Date.now();
    meter.firstElementChild.style.width = `${Math.max(0, Math.min(100, (s.questionIndex + 1) / s.total * 100))}%`;
    notice(!socket.connected ? 'Trwa ponowne łączenie…' : s.hostConnected ? `Quiz ${format(s.code)} • ${session.name}` : 'Prowadzący stracił połączenie. Czekamy na jego powrót…');
    if (s.status === 'lobby') show('wait');
    if (s.status === 'countdown') { show('game'); $('progress').textContent = 'Start za'; $('answers').innerHTML = ''; $('status').textContent = 'Przygotuj się!'; }
    if (s.status === 'question') {
      show('game'); $('progress').textContent = `Pytanie ${s.questionIndex + 1} z ${s.total}`; $('question').textContent = s.question.q;
      $('answers').innerHTML = s.question.a.map((a, i) => `<button class="answer" data-answer="${i}">${'ABCD'[i]}. ${esc(a)}</button>`).join('');
      $('status').textContent = s.players.find(p => p.id === session.id)?.answered ? 'Odpowiedź zapisana! Czekaj na wyniki.' : 'Wybierz jedną odpowiedź';
      document.querySelectorAll('[data-answer]').forEach(b => { b.onclick = async () => {
        pending = true; tick();
        const questionIndex = s.questionIndex;
        try { await rpc('player:answer', { answer: Number(b.dataset.answer), questionIndex }); }
        catch (err) { if (current?.questionIndex === questionIndex && current?.status === 'question') $('status').textContent = err.message; }
        finally { pending = false; tick(); }
      }; });
    }
    if (s.status === 'results') {
      show('game'); $('progress').textContent = `Wyniki pytania ${s.questionIndex + 1}`; $('question').textContent = 'Poprawna odpowiedź: ' + s.results.correctText; $('answers').innerHTML = '';
      const me = s.results.leaderboard.find(p => p.id === session.id);
      $('status').textContent = me ? `Miejsce: ${me.place} • Punkty: ${me.score}. Czekaj na prowadzącego.` : 'Czekaj na prowadzącego.';
    }
    if (s.status === 'finished') {
      show('end'); const me = s.leaderboard.find(p => p.id === session.id);
      $('place').textContent = me ? `Twoje miejsce: ${me.place}. Zdobyte punkty: ${me.score}. 🎉` : 'Dziękujemy za udział!';
    }
    tick();
  }
  socket.on('connect', () => { $('joinBtn').disabled = false; if (session) join(true); });
  socket.on('disconnect', () => { $('joinBtn').disabled = true; tick(); });
  socket.on('state', render); socket.on('room:closed', r => reset(r.message));
  setInterval(tick, 200);
})();
