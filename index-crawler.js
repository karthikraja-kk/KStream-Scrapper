import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import fetch from 'node-fetch'; // Standard fetch in Node 18+, but using node-fetch for compatibility if needed

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SOURCE_BASE_URL = process.env.SOURCE_BASE_URL;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !SOURCE_BASE_URL) {
    console.error('Missing environment variables: SUPABASE_URL, SUPABASE_SERVICE_KEY, SOURCE_BASE_URL');
    process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchHtml(url) {
    const response = await fetch(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36',
        }
    });
    if (!response.ok) throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
    return response.text();
}

async function crawlIndex() {
    console.log('Starting Index Crawler...');
    
    try {
        const homeHtml = await homeFetchWithRetry(SOURCE_BASE_URL);
        const $ = cheerio.load(homeHtml);
        
        // TODO: adjust selector to match source site HTML for year folder links
        const folderLinks = [];
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().trim();
            // Heuristic to find year folders (e.g. "2024", "2025")
            if (href && /\/20\d{2}\//.test(href)) {
                folderLinks.push({ 
                    name: text, 
                    url: new URL(href, SOURCE_BASE_URL).toString(),
                    folderName: href.replace(/\//g, '')
                });
            }
        });

        console.log(`Found ${folderLinks.length} potential year folders.`);

        for (const folder of folderLinks) {
            console.log(`Processing folder: ${folder.folderName}...`);
            await processFolder(folder);
            await delay(1000); // Polite delay
        }

        console.log('Index Crawler finished.');
    } catch (err) {
        console.error('Crawler Error:', err.message);
    }
}

async function homeFetchWithRetry(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            return await fetchHtml(url);
        } catch (err) {
            if (i === retries - 1) throw err;
            console.warn(`Retry ${i + 1}/${retries} for ${url}`);
            await delay(2000);
        }
    }
}

async function processFolder(folder) {
    const currentYear = new Date().getFullYear().toString();
    const isCurrentYear = folder.folderName.includes(currentYear);
    
    try {
        const folderHtml = await fetchHtml(folder.url);
        const $ = cheerio.load(folderHtml);
        
        // TODO: adjust selector to match source site HTML for movie links
        const movieUrls = [];
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            if (href && !href.includes('../') && !href.endsWith('/')) {
                 movieUrls.push(new URL(href, folder.url).toString());
            }
        });

        const latestCount = movieUrls.length;
        console.log(`Found ${latestCount} movie links in ${folder.folderName}`);

        // Get folder state
        const { data: folderState } = await supabase
            .from('folder_state')
            .select('*')
            .eq('folder', folder.folderName)
            .single();

        const shouldQueueAll = isCurrentYear || !folderState || folderState.last_known_count !== latestCount;

        if (shouldQueueAll) {
            console.log(`Queueing ${movieUrls.length} URLs for ${folder.folderName}...`);
            
            // Priority 1 for current year, 2 for others
            const priority = isCurrentYear ? 1 : 2;
            
            const queueData = movieUrls.map(url => ({
                url,
                folder: folder.folderName,
                status: 'pending',
                priority
            }));

            // Batch insert, skipping duplicates via 'onConflict' if supported, 
            // or simply using a loop if it's cleaner. Supabase JS client doesn't directly
            // support 'ON CONFLICT DO NOTHING' for bulk inserts without a constraint.
            // We'll rely on a UNIQUE constraint on 'url' in the DB.
            const { error: queueError } = await supabase
                .from('scrape_queue')
                .upsert(queueData, { onConflict: 'url', ignoreDuplicates: true });

            if (queueError) console.error(`Error queueing for ${folder.folderName}:`, queueError.message);
        } else {
            console.log(`No changes in ${folder.folderName}, skipping.`);
        }

        // Update folder state
        await supabase
            .from('folder_state')
            .upsert({ 
                folder: folder.folderName, 
                last_scraped_at: new Date().toISOString(),
                last_known_count: latestCount
            }, { onConflict: 'folder' });

    } catch (err) {
        console.error(`Error processing folder ${folder.folderName}:`, err.message);
    }
}

crawlIndex();
