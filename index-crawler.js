import * as cheerio from 'cheerio';
import { getSourceUrl, checkRateLimit, startRefresh, finishRefresh, getFolderState, updateFolderState } from './lib/supabase.js';
import { fetchHtml, delay } from './lib/fetch.js';

const BATCH_SIZE = 50;
const BATCH_DELAY_MS = 15000;
const FOLDER_DELAY_MS = 5000;
const PAGE_DELAY_MS = 1500;

async function discoverFolders(baseUrl) {
    const html = await fetchHtml(baseUrl);
    const $ = cheerio.load(html);
    const folders = [];

    $('a').each((i, el) => {
        const href = $(el).attr('href');
        const text = $(el).text().trim();
        if (href && /\/20\d{2}\//.test(href)) {
            folders.push({
                name: text,
                url: new URL(href, baseUrl).toString(),
                folderName: href.replace(/\//g, '').replace(/^\//, '')
            });
        }
    });

    return folders;
}

function getPriority(folder, currentYear) {
    const year = parseInt(folder.folderName);
    if (year === currentYear) return 1;
    if (year === currentYear - 1) return 2;
    return 3;
}

async function discoverMoviesInFolder(folderUrl) {
    const html = await fetchHtml(folderUrl);
    const $ = cheerio.load(html);
    const movies = [];

    $('a').each((i, el) => {
        const href = $(el).attr('href');
        if (href && !href.includes('../') && href.endsWith('/')) {
            movies.push(href);
        }
    });

    return movies;
}

async function queueMovies(movies, folder, priority) {
    if (movies.length === 0) return 0;

    const queueData = movies.map(url => ({
        url,
        folder,
        status: 'pending',
        priority
    }));

    const { error } = await supabase
        .from('scrape_queue')
        .upsert(queueData, { onConflict: 'url', ignoreDuplicates: true });

    if (error) console.error('Queue error:', error.message);
    return movies.length;
}

async function crawlIndex() {
    console.log('Starting Index Crawler...');

    const isRateLimited = await checkRateLimit(15);
    if (isRateLimited) {
        console.log('Rate limited, skipping crawl.');
        return;
    }

    const triggerBy = process.env.TRIGGER_BY || 'scheduler';
    await startRefresh(triggerBy);

    try {
        const baseUrl = await getSourceUrl();
        console.log(`Source: ${baseUrl}`);

        const folders = await discoverFolders(baseUrl);
        console.log(`Found ${folders.length} year folders`);

        if (folders.length === 0) {
            throw new Error('No folders found');
        }

        const currentYear = new Date().getFullYear();
        folders.sort((a, b) => getPriority(a, currentYear) - getPriority(b, currentYear));

        let totalQueued = 0;

        for (const folder of folders) {
            const priority = getPriority(folder, currentYear);
            console.log(`[${folder.folderName}] Priority ${priority}...`);

            const movies = await discoverMoviesInFolder(folder.url);
            const movieCount = movies.length;
            console.log(`[${folder.folderName}] Found ${movieCount} movies`);

            if (movieCount === 0) continue;

            await queueMovies(movies, folder.folderName, priority);
            totalQueued += movieCount;

            await updateFolderState(folder.folderName, movieCount);

            if (totalQueued >= BATCH_SIZE) {
                console.log(`Batch limit reached (${BATCH_SIZE}), pausing ${BATCH_DELAY_MS / 1000}s...`);
                await delay(BATCH_DELAY_MS);
                totalQueued = 0;
            } else {
                await delay(FOLDER_DELAY_MS);
            }
        }

        await finishRefresh('completed');
        console.log('Index Crawler finished.');
    } catch (err) {
        console.error('Crawler Error:', err.message);
        await finishRefresh('failed');
    }
}

import { supabase } from './lib/supabase.js';
crawlIndex();