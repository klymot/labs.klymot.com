const API = 'https://api.klymot.com/api/v1/usage';

function send(path, referrer) {
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return;
  const blob = new Blob([JSON.stringify({ path, referrer: referrer ?? '' })], { type: 'text/plain' });
  if (navigator.sendBeacon) {
    navigator.sendBeacon(API, blob);
  } else {
    fetch(API, { method: 'POST', body: blob, keepalive: true }).catch(() => {});
  }
}

export function sendPageBeacon() {
  send('labs.klymot.com' + location.pathname, document.referrer);
}

export function sendFeatureBeacon(feature) {
  send('/__feature__/' + feature, '');
}
