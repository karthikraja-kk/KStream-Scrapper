import * as cheerio from 'cheerio';
import { randomUUID } from 'crypto';
import { supabase, getSourceUrl, resolveBaseUrl } from './lib/supabase.js';
import { fetchHtml, delay } from './lib/fetch.js';

const RUN_ID = randomUUID().split('-')[0];

function log(level, ...args) {
    const ts = new Date().toISOString();
    console.log(`[${RUN_ID}] [${ts}] [${level}]`, ...args);
}

// Configuration
const REFRESH_TYPE = process.env.REFRESH_TYPE || 'quick';
const TRIGGER_SOURCE = process.env.TRIGGER_SOURCE || 'Manual';
const TARGET_YEAR = process.env.TARGET_YEAR;
const CURRENT_YEAR = new Date().getFullYear().toString();

let LOG_NAME = TRIGGER_SOURCE;
if (REFRESH_TYPE === 'custom' && TARGET_YEAR) {
    LOG_NAME = `custom-${TARGET_YEAR}`;
}

let activeRunId = null;

async function acquireLock() {
    log('INFO', 'Acquiring scraper lock...');

    const { data, error } = await supabase
        .from('refresh_status')
        .insert({ status: 'inprogress', trigger_by: LOG_NAME })
        .select('id')
        .single();

    if (error) {
        const isLockConflict = error.code === '23505' || error.message?.toLowerCase().includes('duplicate key');
        if (isLockConflict) {
            log('ERROR', '[BLOCK] Scraper is already running. New trigger rejected.');
            process.exit(1);
        }
        throw error;
    }

    activeRunId = data?.id;
    log('INFO', `Lock acquired${activeRunId ? ` (refresh_status.id=${activeRunId})` : ''}.`);
}

async function cleanStaging() {
    log('INFO', 'Cleaning staging tables...');
    await supabase.from('movies_stage').delete().neq('slug', '');
    await supabase.from('media_stage').delete().neq('movie_url', '');
}

async function logRefreshStatus(status) {
    log('INFO', `Logging status: ${status} for ${LOG_NAME}`);

    if (!activeRunId) {
        return;
    }

    const { error } = await supabase
        .from('refresh_status')
        .update({ status })
        .eq('id', activeRunId);

    if (error) {
        log('ERROR', 'Failed to update status:', error.message);
    }
}

async function cleanQueue() {
    log('INFO', 'Cleaning previous scrape queue...');
    const { error } = await supabase.from('scrape_queue').delete().neq('status', 'processing');
    if (error) {
        log('ERROR', 'Failed to clean queue:', error.message);
    }
}

// Fail-safe: Ensure status is updated to failed on crash
process.on('uncaughtException', async (err) => {
    log('ERROR', 'CRITICAL UNCAUGHT ERROR:', err.message);
    if (activeRunId) {
        await supabase.from('refresh_status').update({ status: 'failed' }).eq('id', activeRunId);
    }
    process.exit(1);
});

async function getYearFolders() {
    const baseUrl = await getSourceUrl();
    const html = await fetchHtml(baseUrl);
    const $ = cheerio.load(html);
    const folders = [];
    $('div.f').each((i, el) => {
        const link = $(el).find('a').first();
        const href = link.attr('href');
        if (href && $(el).find('img[src*="folder.svg"]').length > 0 && /\d{4}/.test(link.text())) {
            folders.push({ name: link.text().trim(), url: new URL(href, baseUrl).toString() });
        }
    });
    return folders.sort((a, b) => parseInt(b.name.match(/\d{4}/)[0]) - parseInt(a.name.match(/\d{4}/)[0]));
}

async function getMoviesInFolder(folderUrl, fetchAllPages) {
    let allMovies = [];
    let currentUrl = folderUrl;
    let pageNum = 1;
    const globalSeenUrls = new Set();

    while (currentUrl) {
        log('INFO', `Fetching page ${pageNum}: ${currentUrl}`);
        const html = await fetchHtml(currentUrl);
        const $ = cheerio.load(html);

        let moviesOnPage = 0;
        $('div.f').each((i, el) => {
            const link = $(el).find('a').first();
            const href = link.attr('href');
            const hasIcon = $(el).find('img[src*="folder.svg"]').length > 0;

            if (href && hasIcon) {
                const name = link.text().trim();
                const fullUrl = new URL(href, currentUrl).toString();

                // STRICT FILTERS
                const isYearLink = /Tamil \d{4} Movies|Moviesda \d{4} Movies/i.test(name);
                const isPageLink = /பக்கத்திற்குச் செல்ல|Page Tags/i.test(name);
                const isMoviesdaMeta = /Moviesda Download|Tamil Full Movie Download/i.test(name);
                const isWebSeries = /web-series/i.test(fullUrl) || /Web Series/i.test(name);

                if (!globalSeenUrls.has(fullUrl) && !isYearLink && !isPageLink && !isMoviesdaMeta && !isWebSeries) {
                    allMovies.push({ name, url: fullUrl });
                    globalSeenUrls.add(fullUrl);
                    moviesOnPage++;
                }
            }
        });

        log('INFO', `Discovered ${moviesOnPage} unique movies on page ${pageNum}`);

        if (!fetchAllPages) break;

        let nextPageUrl = null;
        $('div.pagecontent a').each((i, el) => {
            const text = $(el).text().trim();
            const href = $(el).attr('href');
            if ((text.toLowerCase().includes('next') || text === '»') && href && href !== '#') {
                nextPageUrl = new URL(href, currentUrl).toString();
                return false;
            }
        });

        if (!nextPageUrl || nextPageUrl === currentUrl) break;
        currentUrl = nextPageUrl;
        pageNum++;
        await delay(1000);
    }
    return allMovies;
}

async function addToQueue(movies, folderName) {
    log('INFO', `Adding ${movies.length} movies to scrape_queue...`);
    for (const movie of movies) {
        await supabase.from('scrape_queue').upsert({ url: movie.url, folder: folderName, status: 'pending', priority: 1 }, { onConflict: 'url' });
    }
}

async function runIndexCrawler() {
    try {
        await resolveBaseUrl();
        await acquireLock();
        await cleanStaging();
        await cleanQueue();

        const folders = await getYearFolders();
        let targetFolder = null;
        let fetchAll = false;

        if (REFRESH_TYPE === 'custom' && TARGET_YEAR) {
            targetFolder = folders.find(f => f.name.includes(TARGET_YEAR));
            fetchAll = true;
        } else {
            targetFolder = folders.find(f => f.name.includes(CURRENT_YEAR)) || folders[0];
            fetchAll = false;
        }

        if (!targetFolder) throw new Error('Target folder not found.');

        log('INFO', `Processing folder: ${targetFolder.name}`);
        const movies = await getMoviesInFolder(targetFolder.url, fetchAll);
        await addToQueue(movies, targetFolder.name);

        log('INFO', `Discovery complete: ${movies.length} movies queued from ${targetFolder.name}`);
    } catch (err) {
        log('ERROR', 'Crawler Error:', err.message);
        await logRefreshStatus('failed');
        process.exit(1);
    }
}

runIndexCrawler();
