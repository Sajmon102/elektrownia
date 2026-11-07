(() => {
  const { $, socket, rpc, esc, format, read, save, notice } = Quiz;
  let session = read('quiz-host'), current, clockOffset = 0;
  const entry = document.createElement('p'); $('roomInfo').prepend(entry);
  const help = document.createElement('p');
  help.className = 'muted'; help.textContent = 'Telefon i komputer muszą być w tej samej sieci Wi-Fi. Dla osób z innych sieci użyj serwera z publicznym adresem. Przy kilku kartach sieciowych ustaw PUBLIC_URL na adres dostępny dla uczniów.';
  $('roomInfo').append(help);
  $('qr').alt = 'Zeskanuj, aby dołączyć do tego quizu';
  const timer = document.createElement('p'); timer.className = 'big'; $('game').append(timer);
  const end = document.createElement('button'); end.textContent = 'Zamknij quiz / nowa gra'; end.className = 'secondary'; end.hidden = true; document.querySelector('main').append(end);
  const show = id => ['lobby', 'game', 'results', 'finished'].forEach(x => $(x).classList.toggle('hidden', x !== id));
  function table(list) { return '<table><tr><th>Miejsce</th><th>Uczeń</th><th>Punkty</th></tr>' + list.map(p => `<tr><td>${p.place}</td><td>${esc(p.name)}</td><td>${p.score}</td></tr>`).join('') + '</table>'; }
  function reset(message) {
    session = current = null; save('quiz-host', null); show('lobby'); $('roomInfo').classList.add('hidden');
    $('create').hidden = false; $('create').disabled = !socket.connected; end.hidden = true; $('count').textContent = '0'; notice(message);
  }
  function accept(r) {
    session = { code: r.code, token: r.token }; save('quiz-host', session);
    $('code').textContent = format(r.code); $('qr').src = r.qr; $('joinLink').href = r.joinUrl; $('joinLink').textContent = r.joinUrl;
    entry.textContent = `Otwórz ${r.entryUrl} i wpisz kod ${format(r.code)} lub zeskanuj QR.`;
    $('roomInfo').classList.remove('hidden'); $('create').hidden = true; end.hidden = false; render(r.state);
  }
  async function action(button, event, data, after) {
    button.disabled = true;
    try { const result = await rpc(event, data); if (after) after(result); }
    catch (err) { notice(err.message); }
    finally { button.disabled = !socket.connected; if (current) controls(); }
  }
  $('create').disabled = true;
  $('create').onclick = () => action($('create'), 'host:create', {}, accept);
  $('start').onclick = () => action($('start'), 'host:start', { code: session?.code });
  $('close').onclick = () => action($('close'), 'host:close-question', { code: session?.code });
  $('next').onclick = () => action($('next'), 'host:next', { code: session?.code, questionIndex: current?.questionIndex });
  end.onclick = () => action(end, 'host:end', { code: session?.code });
  function controls() {
    $('start').disabled = !socket.connected || current?.status !== 'lobby' || !current.players.some(p => p.connected);
    $('close').disabled = !socket.connected || current?.status !== 'question';
    $('next').disabled = !socket.connected || current?.status !== 'results';
    end.disabled = !socket.connected;
  }
  function tick() {
    const left = current?.deadline ? Math.max(0, Math.ceil((current.deadline - Date.now() - clockOffset) / 1000)) : 0;
    timer.textContent = current?.status === 'question' ? `⏱ ${left} s` : '';
    if (current?.status === 'countdown') $('choices').textContent = String(left);
  }
  function render(s) {
    if (!session || s.code !== session.code) return;
    current = s; clockOffset = s.serverNow - Date.now(); controls();
    $('count').textContent = s.players.filter(p => p.connected).length;
    $('players').innerHTML = s.players.map(p => `<span class="player">${esc(p.name)}${p.connected ? '' : ' (rozłączony)'} ${p.answered ? '✓' : ''}</span>`).join('');
    if (s.status === 'lobby') { show('lobby'); $('msg').textContent = 'Czekamy na uczniów…'; }
    if (s.status === 'countdown') { show('game'); $('question').textContent = 'Przygotuj się…'; $('progress').textContent = 'Start za'; $('answerProgress').textContent = ''; }
    if (s.status === 'question') {
      show('game'); $('progress').textContent = `Pytanie ${s.questionIndex + 1} z ${s.total}`; $('question').textContent = s.question.q;
      $('choices').innerHTML = s.question.a.map((a, i) => `<div class="choice">${'ABCD'[i]}. ${esc(a)}</div>`).join('');
      $('answerProgress').textContent = `Odpowiedziało: ${s.players.filter(p => p.answered).length} / ${s.players.length}`;
    }
    if (s.status === 'results') {
      show('results'); const r = s.results; $('correct').textContent = 'Poprawna odpowiedź: ' + r.correctText;
      $('bars').innerHTML = r.counts.map((n, i) => `<div class="barrow"><b>${'ABCD'[i]}</b><div class="bar"><div class="fill" style="width:${n / Math.max(1, ...r.counts) * 100}%"></div></div><b>${n}</b></div>`).join('');
      $('topTable').innerHTML = table(r.leaderboard.slice(0, 5)); $('restTable').innerHTML = r.leaderboard.length > 5 ? table(r.leaderboard.slice(5)) : '';
      $('next').textContent = s.questionIndex === s.total - 1 ? 'Pokaż końcowe wyniki 🏆' : 'Następne pytanie';
    }
    if (s.status === 'finished') {
      show('finished'); const b = s.leaderboard;
      $('podium').innerHTML = '<div class="podium">' + [1, 0, 2].filter(i => b[i]).map(i => `<div class="pod ${['gold', 'silver', 'bronze'][i]}">${['🥇', '🥈', '🥉'][i]}<br>${esc(b[i].name)}<br>${b[i].score} pkt</div>`).join('') + '</div>';
      $('allRanks').innerHTML = table(b);
    }
    tick();
  }
  socket.on('connect', async () => {
    $('create').disabled = !!session;
    if (session) { try { accept(await rpc('host:resume', session)); } catch (err) { reset(err.message); } }
    else if (new URLSearchParams(location.search).get('autostart') === '1') {
      history.replaceState(null, '', '/host');
      $('create').click();
    }
  });
  socket.on('disconnect', () => { $('create').disabled = true; controls(); });
  socket.on('state', render);
  socket.on('reaction', r => { $('reaction').textContent = `${r.emoji} ${r.name}`; });
  socket.on('room:closed', r => reset(r.message));
  setInterval(tick, 200);
})();
