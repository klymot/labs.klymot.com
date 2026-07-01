const API = 'https://api.klymot.com/api/v1/usage';

function send(path, referrer, utmSource, utmMedium, utmCampaign) {
  if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') return;
  const blob = new Blob([JSON.stringify({
    path,
    referrer: referrer ?? '',
    utm_source:   utmSource   ?? '',
    utm_medium:   utmMedium   ?? '',
    utm_campaign: utmCampaign ?? '',
  })], { type: 'text/plain' });
  if (navigator.sendBeacon) {
    navigator.sendBeacon(API, blob);
  } else {
    fetch(API, { method: 'POST', body: blob, keepalive: true }).catch(() => {});
  }
}

export function sendPageBeacon() {
  const p = new URLSearchParams(location.search);
  send(
    'labs.klymot.com' + location.pathname,
    document.referrer,
    p.get('utm_source')   || '',
    p.get('utm_medium')   || '',
    p.get('utm_campaign') || '',
  );
}

export function sendFeatureBeacon(feature) {
  send('/__feature__/' + feature, '');
}
