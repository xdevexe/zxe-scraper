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

        // ── 4. NOUVELLE MÉTHODE RD : addMagnet → selectFiles → poll → unrestrict
        // On prend les 8 meilleurs et on les teste en séquence
        const toTest = sorted.slice(0, 8);
        let finalUrl = null;
        let streamTitle = '';

        for (const stream of toTest) {
            try {
                const magnet = `magnet:?xt=urn:btih:${stream.infoHash}`;

                // Ajouter le magnet
                const addRes = await fetchT(`${RD}/torrents/addMagnet`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${rdToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `magnet=${encodeURIComponent(magnet)}`
                });
                const { id: torrentId, uri } = await addRes.json();
                if (!torrentId) continue;

                // Sélectionner tous les fichiers
                await fetchT(`${RD}/torrents/selectFiles/${torrentId}`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${rdToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: 'files=all'
                });

                // Poll le statut (max 6 tentatives × 2s = 12s)
                let links = null;
                let files = null;
                for (let attempt = 0; attempt < 6; attempt++) {
                    await new Promise(r => setTimeout(r, attempt === 0 ? 500 : 2000));

                    const infoRes = await fetchT(`${RD}/torrents/info/${torrentId}`, {
                        headers: { 'Authorization': `Bearer ${rdToken}` }
                    });
                    const info = await infoRes.json();

                    // Statuts terminaux d'échec → pas la peine d'attendre
                    if (['error', 'dead', 'virus', 'magnet_error'].includes(info.status)) {
                        break;
                    }

                    // Succès : le torrent est prêt
                    if (info.status === 'downloaded' && info.links?.length) {
                        links = info.links;
                        files = info.files;
                        break;
                    }

                    // "downloading" mais progression = 0 → pas en cache, trop lent → skip
                    if (info.status === 'downloading' && attempt >= 2 && (info.progress || 0) < 5) {
                        // Supprimer le torrent pour ne pas polluer le compte RD
                        fetchT(`${RD}/torrents/delete/${torrentId}`, {
                            method: 'DELETE',
                            headers: { 'Authorization': `Bearer ${rdToken}` }
                        }).catch(() => {});
                        break;
                    }
                }

                if (!links?.length) continue;

                // Choisir le plus gros fichier vidéo
                let bestLink = links[0];
                if (files?.length) {
                    const vids = files
                        .filter(f => /\.(mkv|mp4|avi|m4v|mov)$/i.test(f.path) && f.selected)
                        .sort((a, b) => b.bytes - a.bytes);
                    if (vids.length && links[vids[0].id - 1]) {
                        bestLink = links[vids[0].id - 1];
                    }
                }

                // Débrider le lien
                const unRes = await fetchT(`${RD}/unrestrict/link`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${rdToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `link=${encodeURIComponent(bestLink)}`
                });
                const { download } = await unRes.json();
                if (!download) continue;

                finalUrl = download;
                streamTitle = stream.title || '';
                break;

            } catch (_) { continue; }
        }

        // ── 5. Résultat ───────────────────────────────────────────────────────
        if (!finalUrl) {
            return res.status(404).send(errorPage(
                "Aucun stream disponible.",
                `${allStreams.length} torrent(s) trouvé(s), dont ${fr.length} en français — aucun n'est en cache instantané sur Real-Debrid. Essaie MafiaEmbed ou AutoEmbed FR.`
            ));
        }

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(playerPage(finalUrl, streamTitle));

    } catch (err) {
        return res.status(500).send(errorPage("Erreur interne.", err.message));
    }
};

// ─── LECTEUR HTML ─────────────────────────────────────────────────────────────
function playerPage(videoUrl, title) {
    const safe = escapeHtml(title);
    const key  = 'zxe_' + title.replace(/\W+/g, '_').substring(0, 50);
    return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZxePlayer</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%;background:#000;overflow:hidden}
video{width:100%;height:100%;display:block;background:#000;outline:none}
#loader{
  position:fixed;inset:0;background:#000;display:flex;flex-direction:column;
  align-items:center;justify-content:center;gap:.9rem;z-index:99;transition:opacity .5s
}
#loader.gone{opacity:0;pointer-events:none}
.spin{
  width:46px;height:46px;border-radius:50%;
  border:3px solid rgba(30,144,255,.2);border-top-color:#1e90ff;
  animation:spin .8s linear infinite
}
@keyframes spin{to{transform:rotate(360deg)}}
#loader p{font-family:sans-serif;font-size:.83rem;color:rgba(255,255,255,.55)}
#badge{
  position:fixed;top:.7rem;left:.8rem;z-index:20;
  background:rgba(30,144,255,.9);color:#fff;font-family:sans-serif;
  font-size:.68rem;font-weight:700;padding:.22rem .55rem;
  border-radius:50px;letter-spacing:.06em
}
#titbar{
  position:fixed;top:.65rem;left:5.5rem;right:.8rem;z-index:20;
  font-family:sans-serif;font-size:.73rem;color:rgba(255,255,255,.4);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis
}
#errbox{
  position:fixed;inset:0;background:#030508;display:none;flex-direction:column;
  align-items:center;justify-content:center;font-family:sans-serif;
  color:#e8eef8;gap:.7rem;text-align:center;padding:2rem
}
#errbox .eico{font-size:2.2rem}
#errbox h2{font-size:.93rem}
#errbox p{font-size:.79rem;color:#8ea4c8;max-width:320px;line-height:1.55}
</style>
</head>
<body>
<div id="loader"><div class="spin"></div><p>Connexion Real-Debrid…</p></div>
<div id="badge">RD ⚡</div>
<div id="titbar">${safe}</div>
<video id="vid" controls preload="auto" playsinline>
  <source src="${videoUrl}">
</video>
<div id="errbox">
  <div class="eico">⚠️</div>
  <h2>Lien expiré</h2>
  <p>Les liens Real-Debrid expirent après quelques heures. Ferme et réouvre le lecteur pour en générer un nouveau.</p>
</div>
<script>
const vid=document.getElementById('vid'),loader=document.getElementById('loader'),err=document.getElementById('errbox');
vid.addEventListener('canplay',()=>{loader.classList.add('gone');setTimeout(()=>loader.style.display='none',500);},{once:true});
vid.addEventListener('loadedmetadata',()=>{
  try{const s=parseFloat(sessionStorage.getItem('${escapeHtml(key)}'));if(s>10&&s<vid.duration-30)vid.currentTime=s;}catch(e){}
  vid.play().catch(()=>{});
});
vid.addEventListener('error',()=>{loader.style.display='none';err.style.display='flex';});
setInterval(()=>{if(vid.currentTime>5)try{sessionStorage.setItem('${escapeHtml(key)}',vid.currentTime);}catch(e){}},5000);
setTimeout(()=>{if(!loader.classList.contains('gone'))loader.querySelector('p').textContent='Chargement… encore un instant.';},15000);
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
