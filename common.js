const Quiz = (() => {
  const $ = id => document.getElementById(id);
  const socket = io();
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
  return { $, socket, rpc, esc, format, read, save, notice };
})();
