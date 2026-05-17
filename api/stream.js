const fetch = require('node-fetch');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');

    const { type, id, season, episode } = req.query;
    const rdToken = process.env.REAL_DEBRID_TOKEN;

    if (!id || !type) {
        return res.status(400).send(errorPage("Paramètres 'id' et 'type' manquants."));
    }

    try {
        // 1. Conversion TMDB -> IMDb
        const tmdbRes = await fetch(`https://api.themoviedb.org/3/${type}/${id}/external_ids?api_key=c73731cb90d86c751fba29b7d3c80558`);
        const tmdbData = await tmdbRes.json();
        const imdbId = tmdbData.imdb_id;

        if (!imdbId) return res.status(404).send(errorPage("Impossible de trouver l'ID IMDb."));

        let streamQuery = imdbId;
        if (type === 'tv') streamQuery += `:${season}:${episode}`;

        // 2. Recherche des torrents via Torrentio (providers FR en priorité)
        const torrentioUrl = `https://torrentio.strem.fun/providers=yts,eztv,rarbg,1337x,torrent9,cpasbien|qualityfilter=scr,cam/stream/${type}/${streamQuery}.json`;
        const torrentioRes = await fetch(torrentioUrl);
        const torrentioData = await torrentioRes.json();

        if (!torrentioData.streams || torrentioData.streams.length === 0) {
            return res.status(404).send(errorPage("Aucun torrent trouvé pour ce contenu."));
        }

        // 3. Filtrer : versions françaises en priorité, sinon toute la liste
        const frenchStreams = torrentioData.streams.filter(s =>
            s.title.toLowerCase().includes('french') ||
            s.title.toLowerCase().includes(' vf') ||
            s.title.toLowerCase().includes('vff') ||
            s.title.toLowerCase().includes('multi')
        );
        const streamsToTest = frenchStreams.length > 0 ? frenchStreams : torrentioData.streams;

        let finalDownloadUrl = null;
        let streamTitle = '';

        // 4. Boucle : on cherche un torrent en cache RD
        for (const stream of streamsToTest) {
            const infoHash = stream.infoHash;
            if (!infoHash) continue;

            const checkCacheRes = await fetch(
                `https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/${infoHash}`,
                { headers: { 'Authorization': `Bearer ${rdToken}` } }
            );
            const cacheData = await checkCacheRes.json();

            if (cacheData[infoHash]?.rd?.length > 0) {

                // Ajout du magnet
                const addMagnetRes = await fetch('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${rdToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `magnet=magnet:?xt=urn:btih:${infoHash}`
                });
                const magnetData = await addMagnetRes.json();
                if (!magnetData.id) continue;

                // Sélection des fichiers
                await fetch(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${magnetData.id}`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${rdToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: 'files=all'
                });

                // Infos du torrent
                const torrentInfoRes = await fetch(
                    `https://api.real-debrid.com/rest/1.0/torrents/info/${magnetData.id}`,
                    { headers: { 'Authorization': `Bearer ${rdToken}` } }
                );
                const torrentInfo = await torrentInfoRes.json();

                if (!torrentInfo.links?.length) continue;

                // On choisit le fichier vidéo le plus lourd (le film principal, pas les subs)
                let bestLink = torrentInfo.links[0];
                if (torrentInfo.files) {
                    const videoFiles = torrentInfo.files.filter(f =>
                        /\.(mkv|mp4|avi|m4v)$/i.test(f.path)
                    ).sort((a, b) => b.bytes - a.bytes);
                    if (videoFiles.length > 0) {
                        const idx = videoFiles[0].id - 1;
                        if (torrentInfo.links[idx]) bestLink = torrentInfo.links[idx];
                    }
                }

                // Débridage
                const unrestrictRes = await fetch('https://api.real-debrid.com/rest/1.0/unrestrict/link', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${rdToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `link=${encodeURIComponent(bestLink)}`
                });
                const finalData = await unrestrictRes.json();

                if (finalData.download) {
                    finalDownloadUrl = finalData.download;
                    streamTitle = stream.title || '';
                    break;
                }
            }
        }

        if (!finalDownloadUrl) {
            return res.status(404).send(errorPage(
                "Aucune version instantanée trouvée en cache Real-Debrid.",
                "Ce film n'est pas encore mis en cache. Essaie une autre source (MafiaEmbed, AutoEmbed FR)."
            ));
        }

        // 5. On retourne une PAGE HTML avec un lecteur vidéo — lisible en iframe !
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(200).send(playerPage(finalDownloadUrl, streamTitle));

    } catch (error) {
        res.status(500).send(errorPage("Erreur interne du scraper", error.message));
    }
};

// ─── PAGE LECTEUR ────────────────────────────────────────────────────────────
function playerPage(videoUrl, title) {
    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ZxePlayer</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  html,body{width:100%;height:100%;background:#000;overflow:hidden}
  video{
    width:100%;height:100%;
    display:block;
    background:#000;
  }
  #controls{
    position:fixed;bottom:0;left:0;right:0;
    padding:.6rem 1rem;
    background:linear-gradient(to top,rgba(0,0,0,.85),transparent);
    display:flex;align-items:center;gap:.8rem;
    opacity:0;transition:opacity .3s;
  }
  body:hover #controls{opacity:1}
  button{
    background:rgba(30,144,255,.8);border:none;color:#fff;
    border-radius:50px;padding:.35rem .9rem;font-size:.82rem;
    font-weight:600;cursor:pointer;transition:background .2s;
  }
  button:hover{background:rgba(30,144,255,1)}
  #progress{
    flex:1;height:4px;border-radius:2px;
    background:rgba(255,255,255,.25);cursor:pointer;
    appearance:none;accent-color:#1e90ff;
  }
  #time{font-size:.78rem;color:rgba(255,255,255,.8);white-space:nowrap;font-family:monospace}
  #title{
    position:fixed;top:.8rem;left:1rem;
    font-size:.75rem;color:rgba(255,255,255,.55);
    font-family:sans-serif;max-width:60%;
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
  }
  #loading{
    position:fixed;inset:0;display:flex;flex-direction:column;
    align-items:center;justify-content:center;background:#000;
    color:#fff;font-family:sans-serif;gap:.8rem;z-index:99;
  }
  #loading.hidden{display:none}
  .spinner{
    width:40px;height:40px;border:3px solid rgba(30,144,255,.3);
    border-top-color:#1e90ff;border-radius:50%;
    animation:spin .8s linear infinite;
  }
  @keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>

<div id="loading">
  <div class="spinner"></div>
  <span>Chargement via Real-Debrid…</span>
</div>

<div id="title">${escapeHtml(title)}</div>

<video id="vid" controls preload="metadata" crossorigin="anonymous">
  <source src="${videoUrl}" type="video/mp4">
</video>

<div id="controls">
  <button onclick="togglePlay()">▶ / ⏸</button>
  <input id="progress" type="range" min="0" max="100" value="0" step="0.1"
    oninput="seek(this.value)">
  <span id="time">0:00 / 0:00</span>
  <button onclick="toggleFullscreen()">⛶</button>
</div>

<script>
const vid = document.getElementById('vid');
const prog = document.getElementById('progress');
const timeEl = document.getElementById('time');
const loading = document.getElementById('loading');

vid.addEventListener('canplay', () => loading.classList.add('hidden'));
vid.addEventListener('error', () => {
  loading.innerHTML = '<p style="color:#e24b4a;font-size:.95rem">Erreur de lecture. Essaie une autre source.</p>';
});

vid.addEventListener('timeupdate', () => {
  if (!vid.duration) return;
  prog.value = (vid.currentTime / vid.duration) * 100;
  timeEl.textContent = fmt(vid.currentTime) + ' / ' + fmt(vid.duration);
});

function fmt(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return h > 0
    ? h + ':' + String(m).padStart(2,'0') + ':' + String(sec).padStart(2,'0')
    : m + ':' + String(sec).padStart(2,'0');
}

function togglePlay() { vid.paused ? vid.play() : vid.pause(); }
function seek(v) { vid.currentTime = (v / 100) * vid.duration; }
function toggleFullscreen() {
  document.fullscreenElement ? document.exitFullscreen() : vid.requestFullscreen();
}

// Sauvegarder la progression toutes les 5s
setInterval(() => {
  if (vid.currentTime > 10) {
    try { sessionStorage.setItem('zxe_progress_${escapeHtml(title.replace(/\s+/g,'_'))}', vid.currentTime); } catch(e){}
  }
}, 5000);

// Restaurer la progression si dispo
try {
  const saved = sessionStorage.getItem('zxe_progress_${escapeHtml(title.replace(/\s+/g,'_'))}');
  if (saved && parseFloat(saved) > 10) {
    vid.addEventListener('loadedmetadata', () => { vid.currentTime = parseFloat(saved); });
  }
} catch(e){}
</script>
</body>
</html>`;
}

// ─── PAGE ERREUR ─────────────────────────────────────────────────────────────
function errorPage(msg, detail = '') {
    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:100%;height:100%;background:#030508;display:flex;align-items:center;justify-content:center;font-family:sans-serif}
  .box{text-align:center;padding:2rem;max-width:400px}
  .icon{font-size:2.5rem;margin-bottom:1rem}
  h2{color:#e8eef8;font-size:1rem;margin-bottom:.6rem}
  p{color:#8ea4c8;font-size:.82rem;line-height:1.5}
</style>
</head>
<body>
<div class="box">
  <div class="icon">⚠️</div>
  <h2>${escapeHtml(msg)}</h2>
  ${detail ? `<p>${escapeHtml(detail)}</p>` : ''}
</div>
</body>
</html>`;
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g,'&amp;')
        .replace(/</g,'&lt;')
        .replace(/>/g,'&gt;')
        .replace(/"/g,'&quot;')
        .replace(/'/g,'&#039;');
}
