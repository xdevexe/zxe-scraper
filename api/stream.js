const fetch = require('node-fetch');

module.exports = async (req, res) => {
    // Permettre à ton site d'appeler cette API (CORS)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');

    const { type, id, season, episode } = req.query;
    // Récupère ta clé Real-Debrid stockée de manière sécurisée sur Vercel
    const rdToken = process.env.REAL_DEBRID_TOKEN; 

    if (!id || !type) {
        return res.status(400).json({ error: "Paramètres 'id' et 'type' manquants." });
    }

    try {
        // 1. Convertir l'ID TMDB en ID IMDb (nécessaire pour la recherche de torrents)
        const tmdbRes = await fetch(`https://api.themoviedb.org/3/${type}/${id}/external_ids?api_key=c73731cb90d86c751fba29b7d3c80558`);
        const tmdbData = await tmdbRes.json();
        const imdbId = tmdbData.imdb_id;

        if (!imdbId) return res.status(404).json({ error: "Impossible de trouver l'ID IMDb pour ce contenu." });

        // Formatage de la recherche selon s'il s'agit d'un film ou d'une série
        let streamQuery = imdbId;
        if (type === 'tv') streamQuery += `:${season}:${episode}`;

        // 2. Interroger l'indexeur Torrentio (Configuré pour chercher de la Haute Définition)
        const torrentioUrl = `https://torrentio.strem.fun/providers=yts,eztv,rarbg,1337x,torrent9,cpasbien|qualityfilter=scr,cam/stream/${type}/${streamQuery}.json`;
        const torrentioRes = await fetch(torrentioUrl);
        const torrentioData = await torrentioRes.json();

        if (!torrentioData.streams || torrentioData.streams.length === 0) {
            return res.status(404).json({ error: "Aucun torrent trouvé pour ce contenu." });
        }

        // 3. Filtrer pour trouver en priorité les flux contenant "FRENCH", "VF" ou "VFF"
        let bestStream = torrentioData.streams.find(s => 
            s.title.toLowerCase().includes('french') || 
            s.title.toLowerCase().includes(' vf') || 
            s.title.toLowerCase().includes('vff')
        );

        // Si aucun flux n'est explicitement marqué VF, on prend le premier flux disponible (Multi/International)
        if (!bestStream) bestStream = torrentioData.streams[0];

        // Extraire le hash (Magnet) du torrent
        const infoHash = bestStream.infoHash;

        // 4. Envoyer le fichier à Real-Debrid pour ajout
        const addMagnetRes = await fetch('https://api.real-debrid.com/rest/1.0/torrents/addMagnet', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${rdToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `magnet=magnet:?xt=urn:btih:${infoHash}`
        });
        const magnetData = await addMagnetRes.json();

        // 5. Sélectionner automatiquement les fichiers vidéos à l'intérieur du torrent
        await fetch(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${magnetData.id}`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${rdToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'files=all'
        });

        // 6. Récupérer les détails du torrent débridé
        const torrentInfoRes = await fetch(`https://api.real-debrid.com/rest/1.0/torrents/info/${magnetData.id}`, {
            headers: { 'Authorization': `Bearer ${rdToken}` }
        });
        const torrentInfo = await torrentInfoRes.json();

        // Prendre le premier lien premium généré
        const premiumLink = torrentInfo.links[0]; 

        // 7. Débrider le lien pour obtenir le flux vidéo final direct
        const unrestrictRes = await fetch('https://api.real-debrid.com/rest/1.0/unrestrict/link', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${rdToken}`, 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `link=${premiumLink}`
        });
        const finalData = await unrestrictRes.json();

        // Rediriger le lecteur iframe directement vers la vidéo débridée (sans pub, 1080p)
        res.redirect(finalData.download);

    } catch (error) {
        res.status(500).json({ error: "Erreur interne du scraper", details: error.message });
    }
};