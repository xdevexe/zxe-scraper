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

        // 2. Recherche des torrents via Torrentio
        const torrentioUrl = `https://torrentio.strem.fun/providers=yts,eztv,rarbg,1337x,torrent9,cpasbien|qualityfilter=scr,cam/stream/${type}/${streamQuery}.json`;
        const torrentioRes = await fetch(torrentioUrl);
        const torrentioData = await torrentioRes.json();

        if (!torrentioData.streams || torrentioData.streams.length === 0) {
            return res.status(404).json({ error: "Aucun torrent trouvé pour ce contenu." });
        }

        // 3. Filtrer et trier pour mettre toutes les versions françaises (VF, FRENCH, VFF, MULTI) en haut de la liste
        const frenchStreams = torrentioData.streams.filter(s => 
            s.title.toLowerCase().includes('french') || 
            s.title.toLowerCase().includes(' vf') || 
            s.title.toLowerCase().includes('vff') ||
            s.title.toLowerCase().includes('multi')
        );

        // Si aucun flux n'est étiqueté français, on garde toute la liste (internationale/multi) pour ne pas bloquer le film
        const streamsToTest = frenchStreams.length > 0 ? frenchStreams : torrentioData.streams;

        let finalDownloadUrl = null;

        // 4. Boucle magique : on teste les torrents un par un jusqu'à en trouver un déjà en cache
        for (const stream of streamsToTest) {
            const infoHash = stream.infoHash;

            // On demande à Real-Debrid si ce hash précis est instantané (cached)
            const checkCacheRes = await fetch(`https://api.real-debrid.com/rest/1.0/torrents/instantAvailability/${infoHash}`, {
                headers: { 'Authorization': `Bearer ${rdToken}` }
            });
            const cacheData = await checkCacheRes.json();

            // Structure de réponse RD : si le hash contient des données de fichiers, il est instantané !
            if (cacheData[infoHash] && cacheData[infoHash].rd && cacheData[infoHash].rd.length > 0) {
                
                // Le torrent est en cache ! On l'ajoute immédiatement
                const addMagnetRes = await fetch('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${rdToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `magnet=magnet:?xt=urn:btih:${infoHash}`
                });
                const magnetData = await addMagnetRes.json();

                // Sélection des fichiers immédiate
                await fetch(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${magnetData.id}`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${rdToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: 'files=all'
                });

                // Récupération instantanée des infos
                const torrentInfoRes = await fetch(`https://api.real-debrid.com/rest/1.0/torrents/info/${magnetData.id}`, {
                    headers: { 'Authorization': `Bearer ${rdToken}` }
                });
                const torrentInfo = await torrentInfoRes.json();

                if (torrentInfo.links && torrentInfo.links.length > 0) {
                    const premiumLink = torrentInfo.links[0]; 

                    // Débridage ultra-rapide
                    const unrestrictRes = await fetch('https://api.real-debrid.com/rest/1.0/unrestrict/link', {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${rdToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                        body: `link=${premiumLink}`
                    });
                    const finalData = await unrestrictRes.json();

                    if (finalData.download) {
                        finalDownloadUrl = finalData.download;
                        break; // On a notre vidéo instantanée, on arrête de chercher !
                    }
                }
            }
        }

        // 5. Si après avoir tout fouillé, aucun flux français n'est en cache, on renvoie une erreur propre
        if (!finalDownloadUrl) {
            return res.status(404).json({ 
                error: "Aucune version instantanée trouvée.", 
                details: "Toutes les versions françaises nécessitent un téléchargement complet. Utilise une source de secours gratuite (Smashy, AutoEmbed) pour ce film spécifique." 
            });
        }

        // Redirection directe vers le film (ZÉRO ATTENTE !)
        res.redirect(finalDownloadUrl);

    } catch (error) {
        res.status(500).json({ error: "Erreur interne du scraper", details: error.message });
    }
};
