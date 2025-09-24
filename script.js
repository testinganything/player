navigator.serviceWorker.register('./service-worker.js');

let ytcfg;

async function init() {
  const html = await (await fetch('./proxy/https://www.youtube.com')).text();
  const match = html.match(/ytcfg\.set\((.*?)\)/s);
  if (match) {
    ytcfg = JSON.parse(match[1]);
  } else {
    throw new Error('Could not find ytcfg');
  }
}
init();

async function searchVideos() {
  const query = document.getElementById('search-input').value;
  const url = `./proxy/https://www.youtube.com/youtubei/v1/search?key=${ytcfg.INNERTUBE_API_KEY}`;
  const body = {
    context: ytcfg.INNERTUBE_CONTEXT,
    query
  };
  const response = await fetch(url, { method: 'POST', body: JSON.stringify(body) });
  const data = await response.json();
  const contents = data.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents[0]?.itemSectionRenderer?.contents || [];
  const resultsDiv = document.getElementById('results');
  resultsDiv.innerHTML = '';
  contents.forEach(item => {
    if (item.videoRenderer) {
      const v = item.videoRenderer;
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `<img src="${v.thumbnail.thumbnails[0].url}"><p>${v.title.runs[0].text}</p>`;
      card.onclick = () => playVideo(v.videoId);
      resultsDiv.appendChild(card);
    }
  });
}

async function playVideo(videoId) {
  const player = document.getElementById('player');
  player.style.display = 'block';
  const unlocked = await getUnlockedPlayerResponse(videoId);
  const streamingData = unlocked.streamingData;
  let selectedFormat = streamingData.formats.find(f => f.mimeType.includes('video/mp4') && f.audioQuality && f.qualityLabel === '720p') ||
                       streamingData.formats.find(f => f.mimeType.includes('video/mp4') && f.audioQuality);
  if (!selectedFormat) throw new Error('No suitable format found');
  let formatUrl = selectedFormat.url;
  if (selectedFormat.signatureCipher) {
    formatUrl = await decodeSignature(videoId, selectedFormat.signatureCipher, selectedFormat.url, selectedFormat.sp || 'sig');
  }
  // Check for country restriction and proxy if needed
  if (formatUrl.includes('gcr=')) {
    const parsed = new URL(formatUrl);
    const proxyBase = 'https://phx.4everproxy.com/direct/';
    const encoded = btoa(parsed.host + parsed.port + parsed.pathname + parsed.search);
    formatUrl = proxyBase + encoded;
  }
  player.src = formatUrl;
  player.play();
}

async function getUnlockedPlayerResponse(videoId) {
  const sts = await getSignatureTimestamp(videoId);
  const basePayload = {
    playbackContext: { contentPlaybackContext: { signatureTimestamp: sts } },
    videoId
  };
  let response = await getPlayer({ ...basePayload, context: { client: { clientName: 'WEB', clientVersion: ytcfg.INNERTUBE_CONTEXT.client.clientVersion } } });
  if (response.playabilityStatus.status === 'OK') return response;
  const reason = response.playabilityStatus.status;
  const strategies = [
    { name: 'Content Warning Bypass', payload: { ...basePayload, playbackContext: { ...basePayload.playbackContext, contentPlaybackContext: { ...basePayload.playbackContext.contentPlaybackContext, contentCheckOk: true, racyCheckOk: true } }, context: { client: { clientName: 'WEB', clientVersion: ytcfg.INNERTUBE_CONTEXT.client.clientVersion } } } },
    { name: 'TV Embedded', payload: { ...basePayload, context: { client: { clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER', clientVersion: '2.0' }, thirdParty: { embedUrl: 'https://www.youtube.com/' } } } },
    { name: 'Creator + Auth', payload: { ...basePayload, context: { client: { clientName: 'WEB_CREATOR', clientVersion: '1.20220918', hl: 'en' } } } },
    { name: 'Account Proxy', endpoint: 'proxy', payload: { videoId, reason, clientName: 'WEB', clientVersion: ytcfg.INNERTUBE_CONTEXT.client.clientVersion, signatureTimestamp: sts, hl: 'en' } }
  ];
  for (let strategy of strategies) {
    let payload = strategy.payload;
    let url = strategy.endpoint === 'proxy' ? `https://youtube-proxy.zerody.one/get_player?video_id=${payload.videoId}&reason=${payload.reason}&clientName=${payload.clientName}&clientVersion=${payload.clientVersion}&signatureTimestamp=${payload.signatureTimestamp}&hl=${payload.hl}` : './proxy/https://www.youtube.com/youtubei/v1/player';
    const res = await fetch(url, { method: 'POST', body: JSON.stringify(payload) });
    const data = await res.json();
    if (data.playabilityStatus?.status === 'OK') {
      return data;
    }
  }
  throw new Error('Could not unlock video');
}

async function getPlayer(payload) {
  const url = './proxy/https://www.youtube.com/youtubei/v1/player';
  const res = await fetch(url, { method: 'POST', body: JSON.stringify(payload) });
  return await res.json();
}

async function getSignatureTimestamp(videoId) {
  const embedHtml = await (await fetch(`./proxy/https://www.youtube.com/embed/${videoId}`)).text();
  const match = embedHtml.match(/\/s\/player\/(\w+)\/player_ias.vflset\/en_US\/base.js/);
  if (!match) throw new Error('Could not find player URL');
  const playerUrl = `https://www.youtube.com/s/player/${match[1]}/player_ias.vflset/en_US/base.js`;
  const playerJs = await (await fetch(`./proxy/${playerUrl}`)).text();
  const stsMatch = playerJs.match(/signatureTimestamp:(\d+)/);
  if (!stsMatch) throw new Error('Could not find signatureTimestamp');
  return stsMatch[1];
}

async function decodeSignature(videoId, signatureCipher, baseUrl, sp) {
  const embedHtml = await (await fetch(`./proxy/https://www.youtube.com/embed/${videoId}`)).text();
  const match = embedHtml.match(/\/s\/player\/(\w+)\/player_ias.vflset\/en_US\/base.js/);
  if (!match) throw new Error('Could not find player URL');
  const playerUrl = `https://www.youtube.com/s/player/${match[1]}/player_ias.vflset/en_US/base.js`;
  const playerJs = await (await fetch(`./proxy/${playerUrl}`)).text();
  const funcMatch = playerJs.match(/([a-zA-Z0-9$_]{1,3})=function\(a\)\{a=a\.split\(""\);(.*?)return a\.join\(""\)}/s);
  if (!funcMatch) throw new Error('Could not find decoder function');
  const funcBody = funcMatch[2];
  const objMatch = funcBody.match(/([a-zA-Z0-9$_]{1,3})\./);
  if (!objMatch) throw new Error('Could not find transform object name');
  const objName = objMatch[1];
  const objRegex = new RegExp(`var ${objName.replace(/\$/g, '\\$')}=\\{([\\s\\S]*?)\\};`);
  const objMatch2 = playerJs.match(objRegex);
  if (!objMatch2) throw new Error('Could not find transform object');
  const objBody = objMatch2[1];
  const transforms = {};
  objBody.split(/,\s*(?![^(]*\))/).forEach(part => {
    const [key, body] = part.split(/:(?=function)/);
    const cleanKey = key.trim();
    let type;
    if (body.includes('a.reverse()')) type = 'reverse';
    else if (body.includes('a.splice(0,b)')) type = 'splice';
    else if (body.includes('var c=a[0];a[0]=a[b%a.length];a[b%a.length]=c')) type = 'swap';
    if (type) transforms[cleanKey] = type;
  });
  const operations = [];
  funcBody.split(';').forEach(line => {
    const methodMatch = line.match(/\.(.*?)\(a,(\d+)\)/);
    if (methodMatch) {
      const methodName = methodMatch[1].trim();
      const arg = parseInt(methodMatch[2]);
      const type = transforms[methodName];
      if (type) operations.push({ type, arg });
    }
  });
  let a = signatureCipher.split('');
  operations.forEach(op => {
    if (op.type === 'reverse') a = a.reverse();
    else if (op.type === 'splice') a = a.slice(op.arg);
    else if (op.type === 'swap') {
      const temp = a[0];
      a[0] = a[op.arg % a.length];
      a[op.arg % a.length] = temp;
    }
  });
  const decoded = a.join('');
  return decodeURIComponent(baseUrl) + '&' + sp + '=' + decoded;
}
