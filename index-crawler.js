import * as cheerio from 'cheerio';
import { supabase, getSourceUrl } from './lib/supabase.js';
import { fetchHtml, delay } from './lib/fetch.js';

// Configuration
const REFRESH_TYPE = process.env.REFRESH_TYPE || 'quick'; // 'quick' or 'custom'
const TRIGGER_SOURCE = process.env.TRIGGER_SOURCE || 'Manual'; // 'Manual' or 'Scheduled'
const TARGET_YEAR = process.env.TARGET_YEAR; 
const CURRENT_YEAR = new Date().getFullYear().toString();

// Generate the descriptive log name
let LOG_NAME = TRIGGER_SOURCE; 
if (REFRESH_TYPE === 'custom' && TARGET_YEAR) {
    LOG_NAME = `custom-${TARGET_YEAR}`;
}

async function logRefreshStatus(status) {
    console.log(`Logging Status: ${status} for ${LOG_NAME}`);
    const { error } = await supabase
        .from('refresh_status')
        .insert({ status, trigger_by: LOG_NAME });
    if (error) console.error('Failed to log refresh status:', error.message);
}

async function cleanQueue() {
    console.log('Cleaning previous scrape queue...');
    const { error } = await supabase.from('scrape_queue').delete().neq('status', 'processing');
    if (error) console.error('Failed to clean queue:', error.message);
}

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
        console.log(`  Fetching page ${pageNum}: ${currentUrl}`);
        const html = await fetchHtml(currentUrl);
        const $ = cheerio.load(html);
        
        let moviesOnPage = 0;
        $('div.f').each((i, el) => {
            const link = $(el).find('a').first();
            const href = link.attr('href');
            if (href && $(el).find('img[src*="folder.svg"]').length > 0) {
                const fullUrl = new URL(href, currentUrl).toString();
                const name = link.text().trim();
                const isWebSeries = /web-series/i.test(fullUrl) || /Web Series/i.test(name);
                if (!globalSeenUrls.has(fullUrl) && !isWebSeries) {
                    allMovies.push({ name, url: fullUrl });
                    globalSeenUrls.add(fullUrl);
                    moviesOnPage++;
                }
            }
        });

        console.log(`  - Discovered ${moviesOnPage} unique movies on page ${pageNum}`);

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
    console.log(`\nAdding ${movies.length} movies to scrape_queue...`);
    for (const movie of movies) {
        await supabase.from('scrape_queue').upsert({ url: movie.url, folder: folderName, status: 'pending', priority: 1 }, { onConflict: 'url' });
    }
}

async function runIndexCrawler() {
    await logRefreshStatus('inprogress');
    try {
        await cleanQueue();
        const folders = await getYearFolders();
        
        let targetFolder = null;
        let fetchAll = false;

        if (REFRESH_TYPE === 'custom' && TARGET_YEAR) {
            console.log(`Mode: CUSTOM. Year: ${TARGET_YEAR}`);
            targetFolder = folders.find(f => f.name.includes(TARGET_YEAR));
            fetchAll = true;
        } else {
            console.log(`Mode: QUICK (${TRIGGER_SOURCE}). Targeting latest year (page 1 only).`);
            targetFolder = folders.find(f => f.name.includes(CURRENT_YEAR)) || folders[0];
            fetchAll = false;
        }

        if (!targetFolder) throw new Error(`Target folder for ${TARGET_YEAR || CURRENT_YEAR} not found.`);

        console.log(`\nProcessing folder: ${targetFolder.name}`);
        const movies = await getMoviesInFolder(targetFolder.url, fetchAll);
        await addToQueue(movies, targetFolder.name);

        await logRefreshStatus('completed');
        console.log('\nDiscovery Complete.');
    } catch (err) {
        await logRefreshStatus('failed');
        console.error('Crawler Error:', err.message);
    }
}

runIndexCrawler();
