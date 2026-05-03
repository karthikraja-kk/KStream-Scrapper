import * as cheerio from 'cheerio';
import { supabase, getSourceUrl } from './lib/supabase.js';
import { fetchHtml, delay } from './lib/fetch.js';

// Configuration: mode can be 'quick' or 'custom'
const MODE = process.env.TRIGGER_BY || 'quick'; 
const TARGET_YEAR = process.env.TARGET_YEAR; // Provided for 'custom'
const CURRENT_YEAR = new Date().getFullYear().toString();

async function logRefreshStatus(status) {
    const { error } = await supabase
        .from('refresh_status')
        .insert({ status, trigger_by: MODE });
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
    // Sort descending by year
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
    let added = 0;
    for (const movie of movies) {
        const { error } = await supabase
            .from('scrape_queue')
            .upsert({ 
                url: movie.url, 
                folder: folderName,
                status: 'pending',
                priority: 1
            }, { onConflict: 'url' });
        
        if (!error) added++;
    }
    console.log(`Successfully queued ${added} movies.`);
}

async function runIndexCrawler() {
    await logRefreshStatus('inprogress');
    try {
        await cleanQueue();
        const folders = await getYearFolders();
        
        let targetFolder = null;
        let fetchAll = false;

        if (MODE === 'custom' && TARGET_YEAR) {
            console.log(`Mode: CUSTOM. Year: ${TARGET_YEAR}`);
            targetFolder = folders.find(f => f.name.includes(TARGET_YEAR));
            fetchAll = true;
        } else {
            console.log(`Mode: QUICK. Targeting latest year (page 1 only).`);
            targetFolder = folders.find(f => f.name.includes(CURRENT_YEAR)) || folders[0];
            fetchAll = false;
        }

        if (!targetFolder) {
            throw new Error(`Target folder not found.`);
        }

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
