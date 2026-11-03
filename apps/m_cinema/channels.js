'use strict';
/**
 * Curated Cinema & Streaming channels for M-Cinema.
 */

const CATEGORIES = [
    {
        name: 'M Motorsport & Nurburgring',
        items: [
            {
                title: 'BMW M4 GT3 - 24h Nurburgring Pole Lap',
                channel: 'BMW M Motorsport',
                duration: '8:12',
                quality: '4K HDR',
                glow: '#00a3e0',
                views: '1.2M',
                desc: 'Full onboard camera with telemetry overlay through the Green Hell.'
            },
            {
                title: 'BMW M Hybrid V8 LMDh - Le Mans Night Stint',
                channel: 'FIA WEC Official',
                duration: '14:45',
                quality: '1080p 60',
                glow: '#e1001a',
                views: '840K',
                desc: 'Blistering pace down the Mulsanne straight at 335 km/h in the pitch dark.'
            },
            {
                title: 'BMW M8 GTE - The Sebring 12H V8 Rumble',
                channel: 'IMSA Official',
                duration: '10:22',
                quality: '1080p 60',
                glow: '#ffb703',
                views: '2.4M',
                desc: 'Unfiltered twin-turbo flat-plane crank V8 sound hitting the concrete bumps.'
            }
        ]
    },
    {
        name: 'Autobahn & Drag Races',
        items: [
            {
                title: 'BMW M850i xDrive (530 HP) - 320 km/h Autobahn GPS',
                channel: 'AutoTopNL',
                duration: '7:35',
                quality: '4K HDR',
                glow: '#163a8a',
                views: '3.1M',
                desc: 'Unrestricted German Autobahn full acceleration 100-200 and 200-300 km/h.'
            },
            {
                title: 'BMW M8 Comp vs Porsche 911 Turbo S vs Audi RS7',
                channel: 'carwow',
                duration: '16:18',
                quality: '4K 60',
                glow: '#ff0055',
                views: '5.8M',
                desc: 'Quarter-mile standing drag race, rolling race, and 100-0 braking test.'
            },
            {
                title: 'N63TU3 Custom Downpipes & Exhaust - Pure Sound',
                channel: 'ExhaustLab',
                duration: '5:50',
                quality: '1080p 60',
                glow: '#e1001a',
                views: '490K',
                desc: 'Cold start, heavy revs, sport plus overrun pops & launch control.'
            }
        ]
    },
    {
        name: 'Epic GT Road Trips',
        items: [
            {
                title: 'Conquering the Caucasus: Gombori Pass in the M850i',
                channel: 'Apex Georgia',
                duration: '18:40',
                quality: '4K HDR',
                glow: '#2af575',
                views: '310K',
                desc: 'Technical hairpins, high-speed elevation climbs, and mountain drone shots.'
            },
            {
                title: 'The Ultimate Grand Tourer: 1,000 km Non-Stop in BMW 8',
                channel: 'Top Gear',
                duration: '24:12',
                quality: '1080p',
                glow: '#00f0ff',
                views: '4.2M',
                desc: 'Crossing three European alpine passes in supreme acoustic comfort.'
            },
            {
                title: '50 Years of BMW M: The Story of the Most Powerful Letter',
                channel: 'BMW M',
                duration: '32:05',
                quality: '4K HDR',
                glow: '#00a3e0',
                views: '6.7M',
                desc: 'From the iconic M1, E30 M3, E39 M5 to modern twin-turbo M power.'
            }
        ]
    }
];

module.exports = { CATEGORIES };
