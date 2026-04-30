import * as cheerio from 'cheerio';
import { supabase, getSourceUrl } from './lib/supabase.js';
import { fetchHtml, delay } from './lib/fetch.js';

// Configuration: mode can be 'user', 'scheduler', or 'full'
const MODE = process.env.TRIGGER_BY || 'user'; 

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
                }
            }
        });

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
    for (const movie of movies) {
        await supabase.from('scrape_queue').upsert({ url: movie.url, folder: folderName, status: 'pending', priority: 1 }, { onConflict: 'url' });
    }
    console.log(`Successfully queued ${movies.length} movies.`);
}

async function runIndexCrawler() {
    await logRefreshStatus('inprogress');
    try {
        await cleanQueue();
        const folders = await getYearFolders();
        
        let targetFolders = [];
        if (MODE === 'full') {
            targetFolders = folders;
        } else {
            // Latest year
            targetFolders = [folders[0]];
        }

        const fetchAll = (MODE !== 'user');

        for (const folder of targetFolders) {
            console.log(`\nProcessing folder: ${folder.name}`);
            const movies = await getMoviesInFolder(folder.url, fetchAll);
            await addToQueue(movies, folder.name);
        }

        await logRefreshStatus('completed');
        console.log('\nDiscovery Complete.');
    } catch (err) {
        await logRefreshStatus('failed');
        console.error('Crawler Error:', err.message);
    }
}

runIndexCrawler();
