self.addEventListener('fetch', event => {
  let url = event.request.url;
  if (url.includes('/proxy/')) {
    let realUrl = url.replace(self.location.origin + '/proxy/', '');
    event.respondWith(
      fetch(realUrl, {
        method: event.request.method,
        headers: event.request.headers,
        body: event.request.body,
        mode: 'cors',
        credentials: 'omit'
      })
    );
  }
});
