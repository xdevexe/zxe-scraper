const fetch = require('node-fetch');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');

    const { type, id, season, episode } = req.query;
    const rdToken = process.env.REAL_DEBRID_TOKEN; 

    if (!id || !type) {
        return res.status(400).json({ error: "Paramètres 'id' et 'type' manquants." });
    }

    try {
        // 1. Conversion TMDB -> IMDb
        const tmdbRes = await fetch(`https://api.themoviedb.org/3/${type}/${id}/external_ids?api_key=c73731cb90d86c751fba29b7d3c80558`);
        const tmdbData = await tmdbRes.json();
        const imdbId = tmdbData.imdb_id;

        if (!imdbId) return res.status(404).json({ error: "Impossible de trouver l'ID IMDb." });

        let streamQuery = imdbId;
        if (type === 'tv') streamQuery += `:${season}:${episode}`;

        // 2. Recherche du torrent
        const torrentioUrl = `https://torrentio.strem.fun/providers=yts,eztv,rarbg,1337x,torrent9,cpasbien|qualityfilter=scr,cam/stream/${type}/${streamQuery}.json`;
        const torrentioRes = await fetch(torrentioUrl);
        const torrentioData = await torrentioRes.json();

        if (!torrentioData.streams || torrentioData.streams.length === 0) {
            return res.status(404).json({ error: "Aucun torrent trouvé pour ce contenu." });
        }

        // Priorité VF / FRENCH
        let bestStream = torrentioData.streams.find(s => 
            s.title.toLowerCase().includes('french') || 
            s.title.toLowerCase().includes(' vf') || 
            s.title.toLowerCase().includes('vff')
        );

        if (!bestStream) bestStream = torrentioData.streams[0];
        const infoHash = bestStream.infoHash;

        // 3. Ajout du Magnet sur Real-Debrid
        const addMagnetRes = await fetch('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${rdToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `magnet=magnet:?xt=urn:btih:${infoHash}`
        });
        const magnetData = await addMagnetRes.json();

        // 4. Sélection des fichiers
        await fetch(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${magnetData.id}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${rdToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'files=all'
        });

        // 5. Attendre un court instant que l'API génère les liens ou vérifie le statut
        let torrentInfo;
        let attempts = 0;
        while (attempts < 5) {
            const torrentInfoRes = await fetch(`https://api.real-debrid.com/rest/1.0/torrents/info/${magnetData.id}`, {
                headers: { 'Authorization': `Bearer ${rdToken}` }
            });
            torrentInfo = await torrentInfoRes.json();
            
            // Si le torrent est déjà disponible et qu'on a des liens, on sort de la boucle
            if (torrentInfo.links && torrentInfo.links.length > 0) {
                break;
            }
            
            // Attendre 1,5 seconde avant de réessayer
            await new Promise(resolve => setTimeout(resolve, 1500));
            attempts++;
        }

        // Sécurité si le torrent n'est pas encore téléchargé sur RD
        if (!torrentInfo.links || torrentInfo.links.length === 0) {
            return res.status(202).json({ 
                error: "Le film est en cours de mise en cache sur Real-Debrid.", 
                progress: `${torrentInfo.progress || 0}%`,
                details: "Ce torrent n'était pas encore stocké. Relance la vidéo dans une minute, le temps que Real-Debrid finisse de le télécharger." 
            });
        }

        const premiumLink = torrentInfo.links[0]; 

        // 6. Débrider le lien final
        const unrestrictRes = await fetch('https://api.real-debrid.com/rest/1.0/unrestrict/link', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${rdToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `link=${premiumLink}`
        });
        const finalData = await unrestrictRes.json();

        if (!finalData.download) {
            return res.status(500).json({ error: "Échec du débridage du lien premium." });
        }

        // Redirection vers le flux vidéo propre
        res.redirect(finalData.download);

    } catch (error) {
        res.status(500).json({ error: "Erreur interne du scraper", details: error.message });
    }
};
