const fetch = require('node-fetch');

function fetchT(url, opts = {}, ms = 8000) {
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

    if (!id || !type) return res.status(400).send(errorPage("Paramètres manquants."));

    try {
        const tmdbRes = await fetchT(
            `https://api.themoviedb.org/3/${type}/${id}/external_ids?api_key=c73731cb90d86c751fba29b7d3c80558`
        );
        const { imdb_id: imdbId } = await tmdbRes.json();
        if (!imdbId) return res.status(404).send(errorPage("ID IMDb introuvable."));

        const streamQuery = type === 'tv' ? `${imdbId}:${season}:${episode}` : imdbId;

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
                if (s.infoHash && !seen.has(s.infoHash)) { seen.add(s.infoHash); allStreams.push(s); }
            }
        }
        if (allStreams.length === 0) return res.status(404).send(errorPage("Aucun torrent trouvé."));

        const isFR   = s => /french|truefrench|\bvf\b|vff|vfi|\bmulti\b/i.test(s.title || '');
        const is1080 = s => /1080/i.test(s.title || '');
        const fr = allStreams.filter(isFR);
        const nonFr = allStreams.filter(s => !isFR(s));
        const sorted = [...fr.filter(is1080), ...fr.filter(s => !is1080(s)), ...nonFr.filter(is1080), ...nonFr];
        const toTest = sorted.slice(0, 15);

        async function tryTorrent(stream) {
            try {
                const addRes = await fetchT(`${RD}/torrents/addMagnet`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${rdToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `magnet=${encodeURIComponent('magnet:?xt=urn:btih:' + stream.infoHash)}`
                }, 7000);
                const { id: torrentId } = await addRes.json();
                if (!torrentId) return null;

                await fetchT(`${RD}/torrents/selectFiles/${torrentId}`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${rdToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: 'files=all'
                }, 5000);

                let links = null, files = null;
                for (let i = 0; i < 3; i++) {
                    await new Promise(r => setTimeout(r, i === 0 ? 800 : 1500));
                    const infoRes = await fetchT(`${RD}/torrents/info/${torrentId}`, { headers: { 'Authorization': `Bearer ${rdToken}` } }, 5000);
                    const info = await infoRes.json();
                    if (['error','dead','virus','magnet_error'].includes(info.status)) {
                        fetchT(`${RD}/torrents/delete/${torrentId}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${rdToken}` } }).catch(() => {});
                        return null;
                    }
                    if (info.status === 'downloaded' && info.links?.length) { links = info.links; files = info.files; break; }
                    if (i === 1 && info.status === 'downloading' && (info.progress || 0) < 10) {
                        fetchT(`${RD}/torrents/delete/${torrentId}`, { method: 'DELETE', headers: { 'Authorization': `Bearer ${rdToken}` } }).catch(() => {});
                        return null;
                    }
                }
                if (!links?.length) return null;

                let bestLink = links[0];
                if (files?.length) {
                    const vids = files.filter(f => /\.(mkv|mp4|avi|m4v|mov)$/i.test(f.path) && f.selected).sort((a,b) => b.bytes - a.bytes);
                    if (vids.length && links[vids[0].id - 1]) bestLink = links[vids[0].id - 1];
                }

                const unRes = await fetchT(`${RD}/unrestrict/link`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${rdToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `link=${encodeURIComponent(bestLink)}`
                }, 7000);
                const { download } = await unRes.json();
                if (!download) return null;
                return { url: download, title: stream.title || '' };
            } catch (_) { return null; }
        }

        const frStreams = toTest.filter(isFR);
        const restStreams = toTest.filter(s => !isFR(s));

        const frResults = await Promise.all(frStreams.map(s => tryTorrent(s)));
        const frWinner = frResults.find(r => r !== null);

        let finalUrl = null, streamTitle = '';
        if (frWinner) {
            finalUrl = frWinner.url; streamTitle = frWinner.title;
        } else {
            await new Promise(r => setTimeout(r, 600));
            const restResults = await Promise.all(restStreams.map(s => tryTorrent(s)));
            const restWinner = restResults.find(r => r !== null);
            if (restWinner) { finalUrl = restWinner.url; streamTitle = restWinner.title; }
        }

        if (!finalUrl) {
            return res.status(404).send(errorPage(
                "Aucun stream en cache Real-Debrid.",
                `${allStreams.length} torrent(s) trouvé(s), dont ${fr.length} en français. Aucun en cache instantané. Essaie MafiaEmbed ou AutoEmbed FR.`
            ));
        }

        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.status(200).send(playerPage(finalUrl, streamTitle));

    } catch (err) {
        return res.status(500).send(errorPage("Erreur interne.", err.message));
    }
};

function playerPage(videoUrl, title) {
    const safe = escapeHtml(title);
    const key  = escapeHtml('zxe_' + title.replace(/\W+/g,'_').substring(0,50));
    const vu   = escapeHtml(videoUrl);
    const vj   = JSON.stringify(videoUrl);
    const kj   = JSON.stringify(key);
    return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZxePlayer</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/plyr/3.7.8/plyr.min.css">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html,body{width:100%;height:100%;background:#000;overflow:hidden;font-family:sans-serif}
.plyr{width:100%;height:100%;--plyr-color-main:#1e90ff;--plyr-video-background:#000}
.plyr__video-wrapper{height:100%}#pw{width:100%;height:100%}
#loader{position:fixed;inset:0;background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1rem;z-index:99;transition:opacity .5s}
#loader.gone{opacity:0;pointer-events:none}
.spin{width:48px;height:48px;border-radius:50%;border:3px solid rgba(30,144,255,.2);border-top-color:#1e90ff;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
#loader p{font-size:.85rem;color:rgba(255,255,255,.5)}
#loader small{font-size:.72rem;color:rgba(255,255,255,.2)}
#badge{position:fixed;top:.7rem;left:.8rem;z-index:200;background:rgba(30,144,255,.9);color:#fff;font-size:.68rem;font-weight:700;padding:.22rem .55rem;border-radius:50px;letter-spacing:.06em;pointer-events:none}
#titbar{position:fixed;top:.65rem;left:5.5rem;right:.8rem;z-index:200;font-size:.73rem;color:rgba(255,255,255,.3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
#ac3{display:none;position:fixed;bottom:80px;left:50%;transform:translateX(-50%);background:rgba(245,197,24,.95);color:#000;border-radius:10px;padding:.6rem 1.2rem;font-size:.82rem;font-weight:600;z-index:300;text-align:center;max-width:360px;line-height:1.6;box-shadow:0 4px 20px rgba(0,0,0,.5)}
#ac3 a{color:#000;font-weight:700;text-decoration:underline;cursor:pointer}
#errbox{position:fixed;inset:0;background:#030508;display:none;flex-direction:column;align-items:center;justify-content:center;color:#e8eef8;gap:.7rem;text-align:center;padding:2rem}
#errbox .i{font-size:2.2rem}#errbox h2{font-size:.93rem}#errbox p{font-size:.79rem;color:#8ea4c8;max-width:320px;line-height:1.55}
</style></head><body>
<div id="loader"><div class="spin"></div><p>Connexion Real-Debrid…</p><small>${safe}</small></div>
<div id="badge">RD ⚡</div><div id="titbar">${safe}</div>
<div id="pw"><video id="vid" playsinline crossorigin="anonymous"><source src="${vu}" type="video/mp4"><source src="${vu}"></video></div>
<div id="ac3">🔇 Audio AC3/Dolby — non supporté par le navigateur.<br>
<a onclick="openVlc()">▶ Ouvrir dans VLC</a> &nbsp;|&nbsp; <a onclick="document.getElementById('ac3').style.display='none'">✕</a></div>
<div id="errbox"><div class="i">⚠️</div><h2>Lien expiré</h2><p>Les liens RD expirent. Ferme et réouvre le lecteur pour en générer un nouveau.</p></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/plyr/3.7.8/plyr.min.js"></script>
<script>
const VIDEO_URL=${vj},KEY=${kj};
const player=new Plyr('#vid',{controls:['play-large','play','rewind','fast-forward','progress','current-time','duration','mute','volume','settings','fullscreen'],settings:['speed'],speed:{selected:1,options:[0.5,0.75,1,1.25,1.5,2]},i18n:{play:'Lecture',pause:'Pause',mute:'Muet',unmute:'Son',fullscreen:'Plein écran',exitFullscreen:'Quitter',speed:'Vitesse',normal:'Normale',settings:'Paramètres'}});
const loader=document.getElementById('loader'),err=document.getElementById('errbox'),ac3=document.getElementById('ac3'),vid=document.getElementById('vid');
player.on('canplay',()=>{loader.classList.add('gone');setTimeout(()=>loader.style.display='none',500);});
player.on('loadedmetadata',()=>{try{const s=parseFloat(sessionStorage.getItem(KEY));if(s>10&&s<player.duration-30)player.currentTime=s;}catch(e){}player.play().catch(()=>{});});
setInterval(()=>{if(player.currentTime>5)try{sessionStorage.setItem(KEY,player.currentTime);}catch(e){}},5000);
vid.addEventListener('error',e=>{const c=vid.error?.code;if(c===3||c===4){loader.style.display='none';ac3.style.display='block';}else{loader.style.display='none';err.style.display='flex';}});
setTimeout(()=>{if(!loader.classList.contains('gone'))loader.querySelector('p').textContent='Chargement… encore un instant.';},15000);
function openVlc(){window.location.href='vlc://'+VIDEO_URL;setTimeout(()=>{if(confirm('VLC ne s\\'a pas ouvert. Copier le lien ?'))navigator.clipboard.writeText(VIDEO_URL).catch(()=>prompt('Lien direct :',VIDEO_URL));},2000);}
</script></body></html>`;
}

function errorPage(msg, detail='') {
    return `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><style>*{box-sizing:border-box;margin:0;padding:0}html,body{width:100%;height:100%;background:#030508;display:flex;align-items:center;justify-content:center;font-family:sans-serif}.b{text-align:center;padding:2rem;max-width:420px}.i{font-size:2rem;margin-bottom:.8rem}h2{color:#e8eef8;font-size:.93rem;margin-bottom:.5rem;line-height:1.4}p{color:#8ea4c8;font-size:.8rem;line-height:1.6}</style></head><body><div class="b"><div class="i">⚠️</div><h2>${escapeHtml(msg)}</h2>${detail?`<p>${escapeHtml(detail)}</p>`:''}</div></body></html>`;
}

function escapeHtml(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');}
