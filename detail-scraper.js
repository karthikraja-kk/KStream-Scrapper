import * as cheerio from 'cheerio';
import { supabase } from './lib/supabase.js';
import { fetchHtml, randomDelay } from './lib/fetch.js';

// Configuration
const NUM_WORKERS = 1; 
const MOVIE_DELAY_MS = 1000;

function extractMetadata(html, movieUrl) {
    const $ = cheerio.load(html);
    let title = $('h1').first().text().trim() || $('title').text().split('|')[0].trim();
    title = title.replace(/ Tamil Full Movie Download.*$/i, '').trim();
    const yearMatch = title.match(/\((\d{4})\)/);
    
    // Extract Slug (part after domain)
    const urlObj = new URL(movieUrl);
    const slug = urlObj.pathname;

    const posterUrl = $('picture source').first().attr('srcset') || $('picture img').attr('src') || '';
    const posterFullUrl = posterUrl ? (posterUrl.startsWith('http') ? posterUrl.split(' ')[0] : `https://moviesda19.com${posterUrl.split(' ')[0]}`) : null;

    let meta = { director: null, starring: null, genres: null, rating: null, language: null, type: null };
    $('ul.movie-info li').each((i, el) => {
        const strong = $(el).find('strong').text().toLowerCase();
        const span = $(el).find('span').text().trim();
        if (strong.includes('director')) meta.director = [span];
        if (strong.includes('starring')) meta.starring = span.split(/[,|&]/).map(c => c.trim());
        if (strong.includes('genres')) meta.genres = span.split(',').map(g => g.trim());
        if (strong.includes('movie rating')) meta.rating = span.replace('/10', '');
        if (strong.includes('language')) meta.language = span;
        if (strong.includes('quality')) meta.type = span;
    });

    return {
        slug,
        movie_url: movieUrl,
        movie_name: title.replace(/\s*\(\d{4}\)/, '').replace(/\s+Tamil\s*Movie.*$/i, '').trim(),
        year: yearMatch ? parseInt(yearMatch[1]) : null,
        synopsis: $('.movie-synopsis').text().replace(/Synopsis:/i, '').trim() || null,
        ...meta,
        poster_url: posterFullUrl
    };
}

function parseSize(text) {
    const match = text.match(/File Size:\s*([\d.]+)\s*(MB|GB)/i);
    if (!match) return 0;
    const value = parseFloat(match[1]);
    return match[2].toUpperCase() === 'GB' ? value * 1024 : value;
}

async function extractFinalLinks(qualityPageUrl) {
    try {
        const html = await fetchHtml(qualityPageUrl);
        const $ = cheerio.load(html);
        let largestPage = null; let maxMB = -1;

        $('div.folder').each((i, el) => {
            const link = $(el).find('a[href*="/download/"]').first();
            let sizeMB = 0;
            $(el).find('li').each((j, li) => {
                if ($(li).text().includes('File Size:')) sizeMB = parseSize($(li).text());
            });
            if (link.attr('href') && sizeMB > maxMB) { maxMB = sizeMB; largestPage = new URL(link.attr('href'), qualityPageUrl).toString(); }
        });

        if (!largestPage) return { download1: null, stream1: null, download2: null, stream2: null, duration: null, size: null };

        const html1 = await fetchHtml(largestPage);
        const $1 = cheerio.load(html1);
        let duration = null;
        $1('.details, li, div').each((i, el) => {
            if ($(el).text().includes('Duration:')) duration = $(el).text().match(/Duration:\s*(.+)/i)?.[1].trim();
        });

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
                const watchNode = $3(`.dlink a:contains("Watch Online Server ${serverNum}")`);
                if (watchNode.length > 0) {
                    const wHtml = await fetchHtml(new URL(watchNode.attr('href'), finalRedirectUrl).toString());
                    const $w = cheerio.load(wHtml);
                    stream = $w('source').attr('src') || $w('video').attr('src');
                }
                return { dl, watch: stream };
            } catch (e) { return { dl: null, watch: null }; }
        }

        const s1 = await followChain(1);
        const s2 = await followChain(2);
        return { download1: s1.dl, stream1: s1.watch, download2: s2.dl, stream2: s2.watch, duration, size: maxMB > 0 ? `${maxMB.toFixed(2)} MB` : null };
    } catch (err) { return { download1: null, stream1: null, download2: null, stream2: null, duration: null, size: null }; }
}

async function scrapeMovieDetails(item) {
    console.log(`\nScraping: ${item.url}`);
    try {
        const html = await fetchHtml(item.url);
        const movieDetails = extractMetadata(html, item.url);
        
        const $ = cheerio.load(html);
        let qUrl = null;
        $('div.f').each((i, el) => { if ($(el).find('img[src*="folder.svg"]').length > 0) { qUrl = new URL($(el).find('a').first().attr('href'), item.url).toString(); return false; } });

        const qualities = [];
        if (qUrl) {
            const qHtml = await fetchHtml(qUrl);
            const $q = cheerio.load(qHtml);
            $q('div.f').each((i, el) => {
                if ($q(el).find('img[src*="folder.svg"]').length > 0) {
                    const name = $q(el).find('a').text().trim();
                    const match = name.match(/\(([^)]+)\)/);
                    if (match) qualities.push({ label: match[1], url: new URL($q(el).find('a').attr('href'), qUrl).toString() });
                }
            });
        }

        if (qualities.length === 0) return await updateQueueStatus(item.id, 'error', 'No quality links');

        const mediaResults = [];
        let firstDuration = null;
        for (const q of qualities) {
            console.log(`  - Quality: ${q.label}...`);
            const links = await extractFinalLinks(q.url);
            if (!firstDuration) firstDuration = links.duration;
            mediaResults.push({ quality: q.label, file_size: links.size, download1: links.download1, download2: links.download2, stream1: links.stream1, stream2: links.stream2 });
            await randomDelay(2000, 5000);
        }

        if (mediaResults.every(m => !m.download1 && !m.stream1)) return await updateQueueStatus(item.id, 'error', 'No valid links');

        if (firstDuration) movieDetails.duration = firstDuration;
        
        // SAVE TO STAGE
        await supabase.from('movies_stage').upsert(movieDetails, { onConflict: 'slug' });
        await supabase.from('media_stage').delete().eq('movie_url', item.url);
        for (const m of mediaResults) {
            await supabase.from('media_stage').insert({ 
                movie_url: item.url, 
                quality: m.quality, 
                file_size: m.file_size, 
                download_url_1: m.download1, 
                download_url_2: m.download2, 
                watch_url_1: m.stream1, 
                watch_url_2: m.stream2 
            });
        }

        await updateQueueStatus(item.id, 'done');
        console.log(`  - Staged: ${movieDetails.movie_name}`);
    } catch (err) {
        console.error(`  - Error for ${item.url}: ${err.message}`);
        await updateQueueStatus(item.id, 'error', err.message);
    }
}

async function getQueueItems(limit) {
    const { data, error } = await supabase.from('scrape_queue').select('*').eq('status', 'pending').order('priority', { ascending: false }).limit(limit);
    if (error) throw error;
    return data;
}

async function updateQueueStatus(id, status, errorMsg = null) {
    await supabase.from('scrape_queue').update({ status, error_msg: errorMsg, processed_at: new Date().toISOString() }).eq('id', id);
}

async function finalizeRun() {
    console.log('\n--- Finalizing Run: Syncing Staging to Production ---');
    // Using Postgres anonymous code block (DO) to run the sync without needing a predefined function
    const syncSql = `
        DO $$
        BEGIN
            -- 1. Sync Movies (Match on Slug)
            INSERT INTO movies (slug, movie_url, movie_name, year, duration, synopsis, director, cast_members, genres, type, language, rating, poster_url)
            SELECT 
                s.slug, s.movie_url, s.movie_name, s.year, s.duration, s.synopsis, s.director, s.cast_members, s.genres, s.type, s.language, s.rating, s.poster_url
            FROM movies_stage s
            ON CONFLICT (slug) DO UPDATE SET
                movie_url = EXCLUDED.movie_url,
                movie_name = COALESCE(EXCLUDED.movie_name, movies.movie_name),
                year = COALESCE(EXCLUDED.year, movies.year),
                duration = COALESCE(EXCLUDED.duration, movies.duration),
                synopsis = COALESCE(EXCLUDED.synopsis, movies.synopsis),
                director = COALESCE(EXCLUDED.director, movies.director),
                cast_members = COALESCE(EXCLUDED.cast_members, movies.cast_members),
                genres = COALESCE(EXCLUDED.genres, movies.genres),
                type = COALESCE(EXCLUDED.type, movies.type),
                language = COALESCE(EXCLUDED.language, movies.language),
                rating = COALESCE(EXCLUDED.rating, movies.rating),
                poster_url = COALESCE(EXCLUDED.poster_url, movies.poster_url),
                updated_at = NOW();

            -- 2. Sync Media
            DELETE FROM media 
            WHERE movie_id IN (SELECT id FROM movies WHERE slug IN (SELECT slug FROM movies_stage));

            INSERT INTO media (movie_id, quality, file_size, watch_url_1, watch_url_2, download_url_1, download_url_2)
            SELECT 
                m.id, ms.quality, ms.file_size, ms.watch_url_1, ms.watch_url_2, ms.download_url_1, ms.download_url_2
            FROM media_stage ms
            JOIN movies m ON ms.movie_url = m.movie_url;

            -- 3. Cleanup Stage
            TRUNCATE movies_stage;
            TRUNCATE media_stage;
        END $$;
    `;

    // Note: Supabase JS client doesn't support raw SQL 'DO' blocks directly through .query() easily.
    // We will keep calling the RPC and assume the user has run the SQL from the plan.
    // If the RPC fails, we log it clearly.
    const { error } = await supabase.rpc('sync_movies_and_media');
    
    const { data: activeRun } = await supabase.from('refresh_status').select('id').eq('status', 'inprogress').order('refresh_time', { ascending: false }).limit(1).single();
    
    if (activeRun) {
        const finalStatus = error ? 'failed' : 'completed';
        await supabase.from('refresh_status').update({ status: finalStatus }).eq('id', activeRun.id);
    }

    if (error) throw new Error(`Sync RPC Failed. Ensure you ran the SQL in Supabase Editor. Error: ${error.message}`);
    console.log('Production tables successfully synchronized.');
}

async function runDistributed() {
    console.log(`Starting Scraper Workers (${NUM_WORKERS})...`);
    
    process.on('uncaughtException', async (err) => {
        console.error('CRITICAL ERROR:', err.message);
        const { data: activeRun } = await supabase.from('refresh_status').select('id').eq('status', 'inprogress').limit(1).single();
        if (activeRun) await supabase.from('refresh_status').update({ status: 'failed' }).eq('id', activeRun.id);
        process.exit(1);
    });

    try {
        while (true) {
            const items = await getQueueItems(NUM_WORKERS);
            if (items.length === 0) break;
            await Promise.all(items.map(item => updateQueueStatus(item.id, 'processing')));
            await Promise.all(items.map(item => scrapeMovieDetails(item)));
            await randomDelay(2000, 4000);
        }
        await finalizeRun();
    } catch (err) {
        console.error('Run failed:', err.message);
        const { data: activeRun } = await supabase.from('refresh_status').select('id').eq('status', 'inprogress').limit(1).single();
        if (activeRun) await supabase.from('refresh_status').update({ status: 'failed' }).eq('id', activeRun.id);
    }
}

runDistributed();
