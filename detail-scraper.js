import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import fetch from 'node-fetch';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing environment variables: SUPABASE_URL, SUPABASE_SERVICE_KEY');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchHtml(url, referer = null) {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36',
    };
    if (referer) headers['Referer'] = referer;

    const response = await fetch(url, { headers });
    if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
    return response.text();
}

async function scrapeDetails() {
    console.log('Starting Detail Scraper...');
    try {
        const { data: queueItems, error: queueError } = await supabase
            .from('scrape_queue')
            .select('*')
            .eq('status', 'pending')
            .order('priority', { ascending: true })
            .order('queued_at', { ascending: true })
            .limit(15);

        if (queueError) throw queueError;
        if (!queueItems || queueItems.length === 0) {
            console.log('No pending items in queue.');
            return;
        }

        console.log(`Processing ${queueItems.length} items from queue...`);
        for (const item of queueItems) {
            console.log(`Scraping: ${item.url}...`);
            await processMovie(item);
            await delay(800);
        }
    } catch (err) {
        console.error('Scraper Error:', err.message);
    }
}

async function resolveStreamUrl(initialUrl) {
    let currentUrl = initialUrl;
    let referer = null;
    let resolvedUrl = null;

    for (let i = 0; i < 3; i++) {
        try {
            const html = await fetchHtml(currentUrl, referer);
            
            // 1. Check for video source tag
            const $ = cheerio.load(html);
            // TODO: adjust selector to match source site HTML for video tags
            const videoSrc = $('video source').attr('src') || $('video').attr('src');
            if (videoSrc && (videoSrc.includes('.mp4') || videoSrc.includes('.m3u8'))) {
                resolvedUrl = videoSrc;
                break;
            }

            // 2. Check for JS patterns
            const patterns = [
                /(?:file|source|src|url)\s*[:=]\s*["'](https?:\/\/[^"'\s]+\.(?:mp4|m3u8)[^"']*)["']/i,
                /atob\(['"]([^'"]+)['"]\)/i
            ];
            for (const pattern of patterns) {
                const match = html.match(pattern);
                if (match && match[1]) {
                    if (pattern.source.includes('atob')) {
                        try {
                            const decoded = Buffer.from(match[1], 'base64').toString('utf-8');
                            if (decoded.startsWith('http') && (decoded.includes('.mp4') || decoded.includes('.m3u8'))) {
                                resolvedUrl = decoded;
                                break;
                            }
                        } catch (e) {}
                    } else {
                        resolvedUrl = match[1];
                        break;
                    }
                }
            }
            if (resolvedUrl) break;

            // 3. Check for iframes
            // TODO: adjust selector to match source site HTML for iframes
            const iframeSrc = $('iframe').attr('src');
            if (iframeSrc) {
                referer = currentUrl;
                currentUrl = new URL(iframeSrc, currentUrl).toString();
            } else {
                break;
            }
        } catch (e) {
            break;
        }
    }
    return resolvedUrl;
}

async function processMovie(item) {
    try {
        const html = await fetchHtml(item.url);
        const $ = cheerio.load(html);

        // TODO: adjust selector to match source site HTML for movie title
        const title = $('title').text().trim();

        // TODO: adjust selector to match source site HTML for year
        const yearMatch = title.match(/\((\d{4})\)/);
        const year = yearMatch ? parseInt(yearMatch[1]) : 0;

        // TODO: adjust selector to match source site HTML for genre (array)
        const genre = [];

        // TODO: adjust selector to match source site HTML for poster URL
        const poster_url = $('img').first().attr('src');

        // TODO: adjust selector to match source site HTML for watch link page
        const watchPageUrl = ''; 
        let stream_url = null;
        if (watchPageUrl) {
            stream_url = await resolveStreamUrl(watchPageUrl);
        }

        const movieData = {
            url: item.url,
            title,
            year,
            genre,
            poster_url,
            stream_url,
            folder: item.folder,
            scraped_at: new Date().toISOString()
        };

        const { error: upsertError } = await supabase
            .from('movies')
            .upsert(movieData, { onConflict: 'url' });

        if (upsertError) throw upsertError;

        await supabase
            .from('scrape_queue')
            .update({ status: 'done', processed_at: new Date().toISOString() })
            .eq('id', item.id);

        console.log(`Done: ${title}`);
    } catch (err) {
        console.error(`Error scraping ${item.url}:`, err.message);
        await supabase
            .from('scrape_queue')
            .update({ status: 'error', error_msg: err.message, processed_at: new Date().toISOString() })
            .eq('id', item.id);
    }
}

scrapeDetails();
