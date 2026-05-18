const fetch = require('node-fetch');

function fetchT(url, opts = {}, ms = 9000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

const RD = 'https://api.real-debrid.com/rest/1.0';

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');

    const { type, id, season, episode } = req.query;
    const rdToken = process.env.REAL_DEBRID_TOKEN;

    if (!id || !type) {
        return res.status(400).send(errorPage("Paramètres manquants."));
    }

    try {
        // ── 1. TMDB → IMDb ───────────────────────────────────────────────────
        const tmdbRes = await fetchT(
            `https://api.themoviedb.org/3/${type}/${id}/external_ids?api_key=c73731cb90d86c751fba29b7d3c80558`
        );
        const { imdb_id: imdbId } = await tmdbRes.json();
        if (!imdbId) return res.status(404).send(errorPage("ID IMDb introuvable."));

        const streamQuery = type === 'tv' ? `${imdbId}:${season}:${episode}` : imdbId;

        // ── 2. Torrents via Torrentio ─────────────────────────────────────────
        const configs = [
            `https://torrentio.strem.fun/providers=yts,eztv,rarbg,1337x,torrent9,cpasbien,kickass,btdig,magnetdl|qualityfilter=scr,cam/stream/${type}/${streamQuery}.json`,
            `https://torrentio.strem.fun/stream/${type}/${streamQuery}.json`,
        ];

        const torrentResults = await Promise.allSettled(
            configs.map(u => fetchT(u, {}, 10000).then(r => r.json()).catch(() => ({ streams: [] })))
        );

        const seen = new Set();
        const allStreams = [];
        for (const r of torrentResults) {
            if (r.status !== 'fulfilled') continue;
            for (const s of (r.value?.streams || [])) {
                if (s.infoHash && !seen.has(s.infoHash)) {
                    seen.add(s.infoHash);
                    allStreams.push(s);
                }
            }
        }

        if (allStreams.length === 0) {
            return res.status(404).send(errorPage("Aucun torrent trouvé.", "Ce contenu n'est pas indexé sur Torrentio."));
        }

        // ── 3. Tri : FR 1080p → FR → 1080p → reste ───────────────────────────
        const isFR   = s => /french|truefrench|\bvf\b|vff|vfi|\bmulti\b/i.test(s.title || '');
        const is1080 = s => /1080/i.test(s.title || '');
        const fr    = allStreams.filter(isFR);
        const nonFr = allStreams.filter(s => !isFR(s));
        const sorted = [
            ...fr.filter(is1080),
            ...fr.filter(s => !is1080(s)),
            ...nonFr.filter(is1080),
            ...nonFr,
        ];

        // ── 4. Ajout RD + poll ───────────────────────────────────────────────
        const toTest = sorted.slice(0, 8);
        let finalUrl = null;
        let streamTitle = '';

        for (const stream of toTest) {
            try {
                const magnet = `magnet:?xt=urn:btih:${stream.infoHash}`;

                const addRes = await fetchT(`${RD}/torrents/addMagnet`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${rdToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `magnet=${encodeURIComponent(magnet)}`
                });
                const { id: torrentId } = await addRes.json();
                if (!torrentId) continue;

                await fetchT(`${RD}/torrents/selectFiles/${torrentId}`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${rdToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: 'files=all'
                });

                let links = null;
                let files = null;
                for (let attempt = 0; attempt < 6; attempt++) {
                    await new Promise(r => setTimeout(r, attempt === 0 ? 500 : 2000));
                    const infoRes = await fetchT(`${RD}/torrents/info/${torrentId}`, {
                        headers: { 'Authorization': `Bearer ${rdToken}` }
                    });
                    const info = await infoRes.json();

                    if (['error', 'dead', 'virus', 'magnet_error'].includes(info.status)) break;

                    if (info.status === 'downloaded' && info.links?.length) {
                        links = info.links;
                        files = info.files;
                        break;
                    }

                    if (info.status === 'downloading' && attempt >= 2 && (info.progress || 0) < 5) {
                        fetchT(`${RD}/torrents/delete/${torrentId}`, {
                            method: 'DELETE',
                            headers: { 'Authorization': `Bearer ${rdToken}` }
                        }).catch(() => {});
                        break;
                    }
                }

                if (!links?.length) continue;

                let bestLink = links[0];
                if (files?.length) {
                    const vids = files
                        .filter(f => /\.(mkv|mp4|avi|m4v|mov)$/i.test(f.path) && f.selected)
                        .sort((a, b) => b.bytes - a.bytes);
                    if (vids.length && links[vids[0].id - 1]) bestLink = links[vids[0].id - 1];
                }

                const unRes = await fetchT(`${RD}/unrestrict/link`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${rdToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `link=${encodeURIComponent(bestLink)}`
                });
                const { download, filename, filesize } = await unRes.json();
                if (!download) continue;

                finalUrl = download;
                streamTitle = stream.title || '';
                break;

            } catch (_) { continue; }
        }

        if (!finalUrl) {
            return res.status(404).send(errorPage(
                "Aucun stream disponible.",
                `${allStreams.length} torrent(s) trouvé(s), dont ${fr.length} en français — aucun en cache Real-Debrid. Essaie MafiaEmbed ou AutoEmbed FR.`
            ));
        }

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(playerPage(finalUrl, streamTitle));

    } catch (err) {
        return res.status(500).send(errorPage("Erreur interne.", err.message));
    }
};

// ─── LECTEUR HTML avec VLC.js fallback pour AC3/MKV ──────────────────────────
function playerPage(videoUrl, title) {
    const safe = escapeHtml(title);
    const key  = 'zxe_' + title.replace(/\W+/g, '_').substring(0, 50);
    const safeKey = escapeHtml(key);

    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZxePlayer</title>
<!-- Plyr CSS -->
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/plyr/3.7.8/plyr.min.css">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%;background:#000;overflow:hidden;font-family:sans-serif}

/* Plyr full-height */
.plyr{width:100%;height:100%;--plyr-color-main:#1e90ff;--plyr-video-background:#000}
.plyr__video-wrapper{height:100%}
#player-wrap{width:100%;height:100%}

#loader{
  position:fixed;inset:0;background:#000;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:1rem;z-index:99;transition:opacity .5s
}
#loader.gone{opacity:0;pointer-events:none}
.spin{
  width:48px;height:48px;border-radius:50%;
  border:3px solid rgba(30,144,255,.2);border-top-color:#1e90ff;
  animation:spin .8s linear infinite
}
@keyframes spin{to{transform:rotate(360deg)}}
#loader p{font-size:.85rem;color:rgba(255,255,255,.5);text-align:center;max-width:280px;line-height:1.5}
#loader small{font-size:.72rem;color:rgba(255,255,255,.25)}

#badge{
  position:fixed;top:.7rem;left:.8rem;z-index:200;
  background:rgba(30,144,255,.9);color:#fff;
  font-size:.68rem;font-weight:700;padding:.22rem .55rem;
  border-radius:50px;letter-spacing:.06em;pointer-events:none
}
#titbar{
  position:fixed;top:.65rem;left:5.5rem;right:.8rem;z-index:200;
  font-size:.73rem;color:rgba(255,255,255,.35);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none
}

/* Bandeau son AC3 */
#ac3-banner{
  display:none;position:fixed;bottom:80px;left:50%;transform:translateX(-50%);
  background:rgba(245,197,24,.95);color:#000;border-radius:10px;
  padding:.6rem 1.2rem;font-size:.82rem;font-weight:600;z-index:300;
  text-align:center;max-width:360px;line-height:1.5;box-shadow:0 4px 20px rgba(0,0,0,.5)
}
#ac3-banner a{color:#000;font-weight:700;text-decoration:underline;cursor:pointer}

#errbox{
  position:fixed;inset:0;background:#030508;display:none;flex-direction:column;
  align-items:center;justify-content:center;
  color:#e8eef8;gap:.7rem;text-align:center;padding:2rem
}
#errbox .eico{font-size:2.2rem}
#errbox h2{font-size:.93rem}
#errbox p{font-size:.79rem;color:#8ea4c8;max-width:320px;line-height:1.55}
</style>
</head>
<body>

<div id="loader">
  <div class="spin"></div>
  <p>Connexion Real-Debrid…</p>
  <small>${safe}</small>
</div>

<div id="badge">RD ⚡</div>
<div id="titbar">${safe}</div>

<div id="player-wrap">
  <video id="vid" playsinline crossorigin="anonymous">
    <source src="${videoUrl}" type="video/mp4">
    <source src="${videoUrl}" type="video/x-matroska">
    <source src="${videoUrl}">
  </video>
</div>

<div id="ac3-banner">
  🔇 Son AC3/Dolby détecté — le navigateur ne le supporte pas nativement.<br>
  <a onclick="openVlc()">▶ Ouvrir dans VLC</a> &nbsp;|&nbsp;
  <a onclick="document.getElementById('ac3-banner').style.display='none'">✕ Fermer</a>
</div>

<div id="errbox">
  <div class="eico">⚠️</div>
  <h2>Erreur de lecture</h2>
  <p>Le lien a expiré ou le format n'est pas supporté. Ferme et réouvre le lecteur pour en générer un nouveau.</p>
</div>

<!-- Plyr JS -->
<script src="https://cdnjs.cloudflare.com/ajax/libs/plyr/3.7.8/plyr.min.js"></script>
<script>
const VIDEO_URL = ${JSON.stringify(videoUrl)};
const KEY = ${JSON.stringify(key)};
const TITLE = ${JSON.stringify(title)};

// Init Plyr
const player = new Plyr('#vid', {
  controls: ['play-large','play','rewind','fast-forward','progress','current-time','duration','mute','volume','captions','settings','fullscreen'],
  settings: ['quality','speed'],
  keyboard: { focused: true, global: true },
  tooltips: { controls: true },
  invertTime: false,
  speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
  i18n: {
    play: 'Lecture', pause: 'Pause', mute: 'Muet',
    unmute: 'Activer le son', fullscreen: 'Plein écran',
    exitFullscreen: 'Quitter le plein écran', speed: 'Vitesse',
    normal: 'Normale', settings: 'Paramètres'
  }
});

const loader = document.getElementById('loader');
const errbox = document.getElementById('errbox');
const banner = document.getElementById('ac3-banner');
const vid    = document.getElementById('vid');

// Masquer loader dès que la vidéo peut jouer
player.on('canplay', () => {
  loader.classList.add('gone');
  setTimeout(() => loader.style.display = 'none', 500);
});

// Restaurer position
player.on('loadedmetadata', () => {
  try {
    const saved = parseFloat(sessionStorage.getItem(KEY));
    if (saved > 10 && saved < player.duration - 30) player.currentTime = saved;
  } catch(e) {}
  player.play().catch(() => {});
});

// Sauvegarder position
setInterval(() => {
  if (player.currentTime > 5) {
    try { sessionStorage.setItem(KEY, player.currentTime); } catch(e) {}
  }
}, 5000);

// Détecter erreur audio AC3 / format non supporté
vid.addEventListener('error', (e) => {
  const err = vid.error;
  // MEDIA_ERR_DECODE (4) ou MEDIA_ERR_SRC_NOT_SUPPORTED (3) → probablement AC3
  if (err && (err.code === 3 || err.code === 4)) {
    loader.style.display = 'none';
    banner.style.display = 'block';
  } else {
    loader.style.display = 'none';
    errbox.style.display = 'flex';
  }
});

// Timeout loader
setTimeout(() => {
  if (!loader.classList.contains('gone')) {
    loader.querySelector('p').textContent = 'Chargement… encore un instant.';
  }
}, 15000);

// Ouvrir dans VLC (protocole vlc://)
function openVlc() {
  // Essaie de lancer VLC via le protocole URI
  const vlcUrl = 'vlc://' + VIDEO_URL;
  window.location.href = vlcUrl;

  // Fallback : proposer de copier le lien
  setTimeout(() => {
    if (confirm('VLC ne s\\'a pas ouvert automatiquement.\\nCopier le lien direct pour l\\'ouvrir manuellement dans VLC ?')) {
      navigator.clipboard.writeText(VIDEO_URL).then(() => {
        alert('Lien copié ! Dans VLC : Média → Ouvrir un flux réseau → Colle le lien.');
      }).catch(() => {
        prompt('Copie ce lien et ouvre-le dans VLC :', VIDEO_URL);
      });
    }
  }, 2000);
}
</script>
</body>
</html>`;
}

function errorPage(msg, detail = '') {
    return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">
<style>*{box-sizing:border-box;margin:0;padding:0}html,body{width:100%;height:100%;background:#030508;display:flex;align-items:center;justify-content:center;font-family:sans-serif}.b{text-align:center;padding:2rem;max-width:420px}.i{font-size:2rem;margin-bottom:.8rem}h2{color:#e8eef8;font-size:.93rem;margin-bottom:.5rem;line-height:1.4}p{color:#8ea4c8;font-size:.8rem;line-height:1.6}</style>
</head><body><div class="b"><div class="i">⚠️</div><h2>${escapeHtml(msg)}</h2>${detail ? `<p>${escapeHtml(detail)}</p>` : ''}</div></body></html>`;
}

function escapeHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}
