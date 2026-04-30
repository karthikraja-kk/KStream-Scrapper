import * as cheerio from 'cheerio';
import { supabase } from './lib/supabase.js';
import { fetchHtml, delay } from './lib/fetch.js';
import { cpus } from 'os';

// Configuration
const NUM_WORKERS = 1; // Reduced to 1 to avoid IP blocking

import { randomDelay } from './lib/fetch.js';

// --- STEP 5 Logic: Metadata ---
function extractMetadata(html, movieUrl) {
    const $ = cheerio.load(html);

    let title = $('h1').first().text().trim();
    if (!title) title = $('title').text().split('|')[0].trim();
    title = title.replace(/ Tamil Full Movie Download.*$/i, '').trim();

    const yearMatch = title.match(/\((\d{4})\)/);
    const year = yearMatch ? parseInt(yearMatch[1]) : null;

    const posterUrl = $('picture source').first().attr('srcset') || $('picture img').attr('src') || '';
    const posterFullUrl = posterUrl ? (posterUrl.startsWith('http') ? posterUrl.split(' ')[0] : `https://moviesda19.com${posterUrl.split(' ')[0]}`) : null;

    let directorText = '';
    let castText = '';
    let genreText = '';
    let ratingText = '';
    let languageText = '';
    let typeText = '';

    $('ul.movie-info li').each((i, el) => {
        const strong = $(el).find('strong').text().toLowerCase();
        const span = $(el).find('span').text().trim();
        if (strong.includes('director')) directorText = span;
        if (strong.includes('starring')) castText = span;
        if (strong.includes('genres')) genreText = span;
        if (strong.includes('movie rating')) ratingText = span.replace('/10', '');
        if (strong.includes('language')) languageText = span;
        if (strong.includes('quality')) typeText = span;
    });

    const synopsis = $('.movie-synopsis').text().replace(/Synopsis:/i, '').trim();

    return {
        movie_url: movieUrl,
        movie_name: title.replace(/\s*\(\d{4}\)/, '').replace(/\s+Tamil\s*Movie.*$/i, '').trim(),
        year,
        synopsis: synopsis || null,
        director: directorText ? [directorText] : null,
        cast_members: castText ? castText.split(/[,|&]/).map(c => c.trim()).filter(c => c) : null,
        genres: genreText ? genreText.split(',').map(g => g.trim()).filter(g => g) : null,
        type: typeText || null,
        language: languageText || null,
        rating: ratingText || null,
        poster_url: posterFullUrl
    };
}

function parseSize(text) {
    const match = text.match(/([\d.]+)\s*(MB|GB)/i);
    if (!match) return 0;
    const value = parseFloat(match[1]);
    return match[2].toUpperCase() === 'GB' ? value * 1024 : value;
}

// --- STEP 12/13/14 Logic: Links & Stream ---
async function extractFinalLinks(qualityPageUrl) {
    try {
        const html = await fetchHtml(qualityPageUrl);
        const $ = cheerio.load(html);
        
        let largestPage = null;
        let maxMB = -1;

        // Step 9: Selection of Largest File
        $('div.folder').each((i, el) => {
            const $f = $(el);
            const link = $f.find('a[href*="/download/"]').first();
            let sizeMB = 0;
            $f.find('li').each((j, li) => {
                if ($(li).text().includes('File Size:')) sizeMB = parseSize($(li).text());
            });
            if (link.attr('href') && sizeMB > maxMB) {
                maxMB = sizeMB;
                largestPage = new URL(link.attr('href'), qualityPageUrl).toString();
            }
        });

        if (!largestPage) return { download1: null, stream1: null, download2: null, stream2: null, duration: null, size: null };

        const html1 = await fetchHtml(largestPage);
        const $1 = cheerio.load(html1);

        // Step 11: Duration
        let duration = null;
        $1('.details, li, div').each((i, el) => {
            const text = $(el).text();
            if (text.includes('Duration:')) {
                const m = text.match(/Duration:\s*(.+)/i);
                if (m) duration = m[1].trim();
            }
        });

        const results = {
            download1: null, stream1: null,
            download2: null, stream2: null,
            duration,
            size: maxMB > 0 ? `${maxMB.toFixed(2)} MB` : null
        };

        async function followChain(serverNum) {
            try {
                const srvNode = $1(`.dlink a:contains("Server ${serverNum}")`);
                if (srvNode.length === 0) return { dl: null, watch: null };

                const srvUrl = new URL(srvNode.attr('href'), largestPage).toString();
                const html2 = await fetchHtml(srvUrl);
                const $2 = cheerio.load(html2);
                
                const finalRedirectNode = $2(`.dlink a:contains("Download Server ${serverNum}")`);
                if (finalRedirectNode.length === 0) return { dl: null, watch: null };

                const finalRedirectUrl = new URL(finalRedirectNode.attr('href'), srvUrl).toString();
                const html3 = await fetchHtml(finalRedirectUrl);
                const $3 = cheerio.load(html3);
                
                const dl = $3(`.dlink a:contains("Download Server ${serverNum}")`).attr('href');

                let stream = null;
                const watchLinkNode = $3(`.dlink a:contains("Watch Online Server ${serverNum}")`);
                if (watchLinkNode.length > 0) {
                    const watchUrl = new URL(watchLinkNode.attr('href'), finalRedirectUrl).toString();
                    const watchHtml = await fetchHtml(watchUrl);
                    const $w = cheerio.load(watchHtml);
                    stream = $w('source').attr('src') || $w('video').attr('src');
                }

                return { dl, watch: stream };
            } catch (err) {
                return { dl: null, watch: null };
            }
        }

        const srv1 = await followChain(1);
        results.download1 = srv1.dl;
        results.stream1 = srv1.watch;

        const srv2 = await followChain(2);
        results.download2 = srv2.dl;
        results.stream2 = srv2.watch;

        return results;
    } catch (err) {
        console.error(`  - Final Link Error for ${qualityPageUrl}: ${err.message}`);
        return { download1: null, stream1: null, download2: null, stream2: null, duration: null, size: null };
    }
}

async function scrapeMovieDetails(item) {
    console.log(`\nScraping: ${item.url}`);

    if (/web-series/i.test(item.url)) {
        console.log(`  - Skipping Web Series: ${item.url}`);
        await updateQueueStatus(item.id, 'skipped', 'Web Series excluded');
        return;
    }

    let movieDetails = { movie_url: item.url };
    let qualities = [];

    try {
        const html = await fetchHtml(item.url);
        movieDetails = extractMetadata(html, item.url);
        
        const $ = cheerio.load(html);
        let qualitySelectionUrl = null;
        $('div.f').each((i, el) => {
            if ($(el).find('img[src*="folder.svg"]').length > 0) {
                const link = $(el).find('a').first();
                qualitySelectionUrl = new URL(link.attr('href'), item.url).toString();
                return false;
            }
        });

        if (qualitySelectionUrl) {
            const qHtml = await fetchHtml(qualitySelectionUrl);
            const $q = cheerio.load(qHtml);
            $q('div.f').each((i, el) => {
                if ($q(el).find('img[src*="folder.svg"]').length > 0) {
                    const link = $q(el).find('a').first();
                    const name = link.text().trim();
                    const match = name.match(/\(([^)]+)\)/);
                    if (match) {
                        qualities.push({ 
                            label: match[1], 
                            url: new URL(link.attr('href'), qualitySelectionUrl).toString() 
                        });
                    }
                }
            });
        }
    } catch (err) {
        console.error(`  - Metadata Fetch Error: ${err.message}`);
    }

    if (qualities.length === 0) {
        console.log(`  - No qualities found. Marking as failed.`);
        await updateQueueStatus(item.id, 'error', 'No quality links found');
        return;
    }

    const mediaResults = [];
    let totalValidLinks = 0;
    let firstDuration = null;

    for (const q of qualities) {
        console.log(`  - Quality: ${q.label}...`);
        const links = await extractFinalLinks(q.url);
        if (links.download1 || links.download2 || links.stream1 || links.stream2) totalValidLinks++;
        if (!firstDuration) firstDuration = links.duration;

        mediaResults.push({
            quality: q.label,
            file_size: links.size,
            download1: links.download1,
            download2: links.download2,
            stream1: links.stream1,
            stream2: links.stream2
        });
        await randomDelay(3000, 7000);
        }
    if (totalValidLinks === 0) {
        console.log(`  - FAILURE: No valid links found. Not saving to DB.`);
        await updateQueueStatus(item.id, 'error', 'No valid download/stream links found');
        return;
    }

    console.log(`  - Success: Found links. Saving to DB...`);
    if (firstDuration) movieDetails.duration = firstDuration;
    
    const { data: movieRecord, error: movieError } = await supabase
        .from('movies')
        .upsert(movieDetails, { onConflict: 'movie_url' })
        .select('id')
        .single();
    
    if (movieError) {
        console.error(`  - DB Error (Movies): ${movieError.message}`);
        await updateQueueStatus(item.id, 'error', movieError.message);
        return;
    }

    const movieId = movieRecord.id;
    await supabase.from('media').delete().eq('movie_id', movieId);
    
    for (const m of mediaResults) {
        await supabase.from('media').insert({
            movie_id: movieId,
            quality: m.quality,
            file_size: m.file_size,
            download_url_1: m.download1,
            download_url_2: m.download2,
            watch_url_1: m.stream1,
            watch_url_2: m.stream2
        });
    }

    await updateQueueStatus(item.id, 'done');
    console.log(`  - Completed: ${movieDetails.movie_name || item.url}`);
}

async function getQueueItems(limit) {
    const { data, error } = await supabase
        .from('scrape_queue')
        .select('*')
        .eq('status', 'pending')
        .order('priority', { ascending: false })
        .limit(limit);
    if (error) throw error;
    return data;
}

async function updateQueueStatus(id, status, errorMsg = null) {
    await supabase
        .from('scrape_queue')
        .update({ status, error_msg: errorMsg, processed_at: new Date().toISOString() })
        .eq('id', id);
}

async function runDistributed() {
    console.log(`Starting Scraper Workers (${NUM_WORKERS})...`);
    while (true) {
        const items = await getQueueItems(NUM_WORKERS);
        if (items.length === 0) {
            console.log('No more pending items.');
            break;
        }
        console.log(`\nBatch: Processing ${items.length} items...`);
        await Promise.all(items.map(item => updateQueueStatus(item.id, 'processing')));
        await Promise.all(items.map(item => scrapeMovieDetails(item).catch(err => {
            console.error(`Critical error for ${item.url}: ${err.message}`);
            return updateQueueStatus(item.id, 'error', err.message);
        })));
        await delay(2000);
    }
}

runDistributed().catch(console.error);
