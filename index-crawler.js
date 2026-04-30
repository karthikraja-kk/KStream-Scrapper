import * as cheerio from 'cheerio';
import { supabase, getSourceUrl } from './lib/supabase.js';
import { fetchHtml, delay } from './lib/fetch.js';

// Configuration
const TARGET_YEAR = process.env.TARGET_YEAR || '2026'; // Defaults to 2026 if not specified

async function getYearFolders() {
    const baseUrl = await getSourceUrl();
    console.log(`Discovery: Fetching home page from ${baseUrl}`);
    const html = await fetchHtml(baseUrl);
    const $ = cheerio.load(html);
    const folders = [];

    $('div.f').each((i, el) => {
        const link = $(el).find('a').first();
        const href = link.attr('href');
        const hasIcon = $(el).find('img[src*="folder.svg"]').length > 0;
        
        if (href && hasIcon) {
            const name = link.text().trim();
            const fullUrl = new URL(href, baseUrl).toString();
            // Filter: Name must contain a year
            if (/\d{4}/.test(name)) {
                folders.push({ name, url: fullUrl });
            }
        }
    });
    return folders;
}

async function getMoviesInFolder(folderUrl) {
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
            const hasIcon = $(el).find('img[src*="folder.svg"]').length > 0;
            
            if (href && hasIcon) {
                const name = link.text().trim();
                const fullUrl = new URL(href, currentUrl).toString();

                // Skip obviously non-movie folders or links back to other years
                const isYearLink = /Tamil \d{4} Movies/i.test(name);
                const isAudioLaunch = /Audio Launch/i.test(name);
                const isPageLink = /பக்கத்திற்குச் செல்ல/i.test(name);

                if (!globalSeenUrls.has(fullUrl) && !isYearLink && !isAudioLaunch && !isPageLink) {
                    allMovies.push({ name, url: fullUrl });
                    globalSeenUrls.add(fullUrl);
                    moviesOnPage++;
                }
            }
        });

        console.log(`  - Discovered ${moviesOnPage} unique movies on page ${pageNum}`);

        // Pagination: Find next page link in div.pagecontent
        let nextPageUrl = null;
        $('div.pagecontent a').each((i, el) => {
            const text = $(el).text().trim();
            const href = $(el).attr('href');
            if ((text.toLowerCase().includes('next') || text === '»') && href && href !== '#' && href !== '') {
                nextPageUrl = new URL(href, currentUrl).toString();
                return false;
            }
        });

        if (!nextPageUrl || nextPageUrl === currentUrl) break;
        currentUrl = nextPageUrl;
        pageNum++;
        await delay(1000); // Respectful delay between pages
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
    try {
        const folders = await getYearFolders();
        
        // Find the target year folder (restricted for testing)
        const targetFolder = folders.find(f => f.name.includes(TARGET_YEAR));
        
        if (!targetFolder) {
            console.error(`Error: Folder for year ${TARGET_YEAR} not found.`);
            return;
        }

        console.log(`\nProcessing target folder: ${targetFolder.name} (${targetFolder.url})`);
        const movies = await getMoviesInFolder(targetFolder.url);
        
        console.log(`\nDiscovery Complete: Found total of ${movies.length} movies.`);
        
        await addToQueue(movies, targetFolder.name);

    } catch (err) {
        console.error('Crawler Execution Error:', err.message);
    }
}

runIndexCrawler();
