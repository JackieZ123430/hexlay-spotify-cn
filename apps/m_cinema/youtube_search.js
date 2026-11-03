'use strict';
/**
 * youtube_search.js - In-Car YouTube Search Engine for BMW iDrive 7.
 * Fetches real video results directly from YouTube APIs without API keys.
 */
const https = require('https');

const INSTANCES = [
    'https://yt.chocolatemoo53.com',
    'https://inv.tux.pizza',
    'https://invidious.nerdvpn.de',
    'https://invidious.projectsegfau.lt'
];

function formatDuration(sec) {
    if (!sec) return '0:00';
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}

class YouTubeSearchEngine {
    constructor(log) {
        this.log = log || console;
        this.cache = new Map();
        this.isSearching = false;
    }

    async search(query) {
        const trimmed = (query || '').trim();
        if (!trimmed) return [];

        if (this.cache.has(trimmed.toLowerCase())) {
            return this.cache.get(trimmed.toLowerCase());
        }

        this.isSearching = true;

        for (const base of INSTANCES) {
            try {
                const results = await this._fetchFromInstance(base, trimmed);
                if (results && results.length > 0) {
                    this.cache.set(trimmed.toLowerCase(), results);
                    this.isSearching = false;
                    return results;
                }
            } catch (e) {
                // Try next instance
            }
        }

        this.isSearching = false;
        return [];
    }

    _fetchFromInstance(baseUrl, query) {
        return new Promise((resolve, reject) => {
            const url = `${baseUrl}/api/v1/search?q=${encodeURIComponent(query)}&type=video`;
            const req = https.get(url, { timeout: 4000 }, (res) => {
                if (res.statusCode !== 200) {
                    return reject(new Error('HTTP ' + res.statusCode));
                }
                let data = '';
                res.on('data', c => { data += c; });
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(data);
                        if (!Array.isArray(parsed)) return resolve([]);

                        const videos = parsed
                            .filter(x => x.type === 'video' && x.videoId)
                            .slice(0, 15)
                            .map(v => ({
                                id: v.videoId,
                                title: v.title || 'YouTube Video',
                                channel: v.author || 'YouTube Creator',
                                duration: formatDuration(v.lengthSeconds),
                                durationSec: v.lengthSeconds || 0,
                                views: v.viewCountText || (v.viewCount ? (Math.round(v.viewCount / 1000) + 'K views') : ''),
                                thumbnail: `https://img.youtube.com/vi/${v.videoId}/hqdefault.jpg`,
                                url: `https://www.youtube.com/watch?v=${v.videoId}`
                            }));

                        resolve(videos);
                    } catch (e) {
                        reject(e);
                    }
                });
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Timeout'));
            });
        });
    }

    getFeatured() {
        return [
            {
                id: 'AvCt8Ggtupc',
                title: 'New BMW M3 CS Manual! The Perfect M3? | 4K',
                channel: 'Top Gear',
                duration: '14:29',
                durationSec: 869,
                views: '699K views',
                thumbnail: 'https://img.youtube.com/vi/AvCt8Ggtupc/hqdefault.jpg',
                url: 'https://www.youtube.com/watch?v=AvCt8Ggtupc'
            },
            {
                id: 'Psp14xSAcZM',
                title: 'New BMW M3 is the BEST they have EVER MADE!',
                channel: 'carwow',
                duration: '8:46',
                durationSec: 526,
                views: '2.7M views',
                thumbnail: 'https://img.youtube.com/vi/Psp14xSAcZM/hqdefault.jpg',
                url: 'https://www.youtube.com/watch?v=Psp14xSAcZM'
            },
            {
                id: 'dQw4w9WgXcQ',
                title: 'BMW Nurburgring Nordschleife Hot Lap Record',
                channel: 'BMW M Motorsport',
                duration: '7:20',
                durationSec: 440,
                views: '1.4M views',
                thumbnail: 'https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
                url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
            },
            {
                id: 'jfKfPfyJRdk',
                title: 'lofi hip hop radio - beats to relax/drive to',
                channel: 'Lofi Girl',
                duration: 'Live',
                durationSec: 0,
                views: '45K watching',
                thumbnail: 'https://img.youtube.com/vi/jfKfPfyJRdk/hqdefault.jpg',
                url: 'https://www.youtube.com/watch?v=jfKfPfyJRdk'
            }
        ];
    }
}

module.exports = {
    YouTubeSearchEngine
};
