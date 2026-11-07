const Quiz = (() => {
  const $ = id => document.getElementById(id);
  const socket = io();
  const styles = document.createElement('style');
  styles.textContent = `
    body { background: radial-gradient(circle at 15% 10%, #145d6b 0, transparent 32%), radial-gradient(circle at 90% 20%, #552ca0 0, transparent 30%), linear-gradient(145deg,#071428,#131b3c 60%,#073d42) !important; min-height:100vh; background-attachment:fixed !important; }
    .wrap { position:relative; z-index:1; }
    .card { background:rgba(19,32,59,.88) !important; border:1px solid rgba(145,224,255,.23) !important; box-shadow:0 18px 50px #0004; backdrop-filter:blur(12px); }
    h1 { letter-spacing:-.03em; text-shadow:0 2px 24px #46f5c75e; }
    button, #hostBtn { transition:transform .15s,filter .15s,box-shadow .15s; }
    button:not(:disabled):hover, #hostBtn:hover { transform:translateY(-2px); filter:brightness(1.12); box-shadow:0 8px 20px #0004; }
    button:focus-visible, a:focus-visible, input:focus-visible { outline:3px solid #fff; outline-offset:3px; }
    .answer:nth-child(4n+1), .choice:nth-child(4n+1) { background:#b73f5b !important; }
    .answer:nth-child(4n+2), .choice:nth-child(4n+2) { background:#276fc2 !important; }
    .answer:nth-child(4n+3), .choice:nth-child(4n+3) { background:#a36a15 !important; }
    .answer:nth-child(4n+4), .choice:nth-child(4n+4) { background:#167f6b !important; }
    .audio-controls { display:flex; flex-wrap:wrap; gap:8px; margin:10px 0; }
    .audio-controls button { width:auto; margin:0; padding:9px 13px; font-size:14px; background:#344861; color:#fff; border:1px solid #7186a0; }
    .audio-controls button[aria-pressed=true] { background:#0c7960; }
    .game-progress { height:8px; background:#ffffff26; border-radius:12px; overflow:hidden; margin:12px 0; }
    .game-progress span { display:block; height:100%; background:linear-gradient(90deg,#39e6ae,#70baff); transition:width .3s; }
    @media (prefers-reduced-motion:reduce) { *, *::before, *::after { transition:none !important; animation:none !important; } }
  `;
  document.head.append(styles);
  const audioControls = document.createElement('div'); audioControls.className = 'audio-controls';
  const musicButton = document.createElement('button'), effectsButton = document.createElement('button');
  musicButton.type = effectsButton.type = 'button'; audioControls.append(musicButton, effectsButton);
  document.querySelector('main').prepend(audioControls);
  let audioContext, musicOn = false, effectsOn = false, musicTimer, musicStep = 0;
  function initAudio() {
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio) return false;
    try { audioContext ||= new Audio(); audioContext.resume().catch(() => {}); return true; } catch { return false; }
  }
  function tone(frequency, duration = .14, volume = .035, type = 'sine') {
    if (!audioContext || audioContext.state !== 'running') return;
    const now = audioContext.currentTime, oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
    oscillator.type = type; oscillator.frequency.setValueAtTime(frequency, now);
    gain.gain.setValueAtTime(.0001, now); gain.gain.exponentialRampToValueAtTime(volume, now + .025);
    gain.gain.exponentialRampToValueAtTime(.0001, now + duration); oscillator.connect(gain); gain.connect(audioContext.destination);
    oscillator.start(now); oscillator.stop(now + duration + .01);
  }
  function sound(kind) {
    if (!effectsOn) return;
    const notes = { click: [440], question: [392, 523], results: [523, 659], finished: [392, 523, 659, 784] }[kind] || [440];
    notes.forEach((note, index) => setTimeout(() => { if (effectsOn) tone(note, .18, .045, 'triangle'); }, index * 105));
  }
  function updateAudioButtons() {
    musicButton.textContent = musicOn ? '🎵 Muzyka: włączona' : '🎵 Włącz muzykę';
    effectsButton.textContent = effectsOn ? '🔊 Efekty: włączone' : '🔈 Włącz efekty';
    musicButton.setAttribute('aria-pressed', String(musicOn)); effectsButton.setAttribute('aria-pressed', String(effectsOn));
  }
  musicButton.onclick = () => {
    if (musicOn) { musicOn = false; clearInterval(musicTimer); }
    else if (initAudio()) {
      musicOn = true; const melody = [261.63, 329.63, 392, 523.25, 392, 329.63, 293.66, 349.23, 440, 523.25, 440, 349.23];
      const play = () => { if (musicOn && !document.hidden) tone(melody[musicStep++ % melody.length], .24, .018, 'sine'); };
      play(); musicTimer = setInterval(play, 300);
    } else { notice('Ta przeglądarka nie obsługuje muzyki.'); }
    updateAudioButtons();
  };
  effectsButton.onclick = () => { if (effectsOn) effectsOn = false; else if (initAudio()) { effectsOn = true; sound('click'); } else notice('Ta przeglądarka nie obsługuje efektów dźwiękowych.'); updateAudioButtons(); };
  document.addEventListener('click', event => { if (!audioControls.contains(event.target) && event.target.closest('button, #hostBtn')) sound('click'); });
  updateAudioButtons();
  const banner = document.createElement('p');
  banner.setAttribute('role', 'status'); banner.style.cssText = 'padding:12px;background:#334155;border-radius:12px';
  document.querySelector('main').prepend(banner);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const format = code => String(code || '').replace(/^(\d{3})(\d{3})$/, '$1-$2');
  const read = key => { try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; } };
  const save = (key, value) => { try { value ? sessionStorage.setItem(key, JSON.stringify(value)) : sessionStorage.removeItem(key); } catch {} };
  function rpc(event, data) {
    return new Promise((resolve, reject) => {
      if (!socket.connected) return reject(new Error('Brak połączenia z serwerem. Poczekaj na ponowne połączenie.'));
      socket.timeout(7000).emit(event, data, (err, result) => {
        if (err) reject(new Error('Serwer nie odpowiedział. Sprawdź połączenie i spróbuj ponownie.'));
        else if (result?.error) reject(new Error(result.error));
        else resolve(result);
      });
    });
  }
  const notice = text => { banner.textContent = text; };
  socket.on('connect', () => notice('Połączono z serwerem.'));
  socket.on('disconnect', () => notice('Utracono połączenie. Trwa ponowne łączenie…'));
  socket.on('connect_error', () => notice('Nie można połączyć się z serwerem. Sprawdź, czy jest uruchomiony.'));
  return { $, socket, rpc, esc, format, read, save, notice, sound };
})();
