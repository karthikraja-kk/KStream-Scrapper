import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import fetch from 'node-fetch';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const SOURCE_BASE_URL = process.env.SOURCE_BASE_URL;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing environment variables: SUPABASE_URL, SUPABASE_SERVICE_KEY');
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

async function scrapeDetails() {
    console.log('Starting Detail Scraper...');
    
    try {
        // Fetch 15 pending rows ordered by priority and queued_at
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
            await delay(800); // Polite delay
        }

        console.log('Detail Scraper finished.');
    } catch (err) {
        console.error('Scraper Error:', err.message);
    }
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
        
        // TODO: adjust selector to match source site HTML for stream/file URL
        const stream_url = ''; 

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

        // Mark as done
        await supabase
            .from('scrape_queue')
            .update({ status: 'done', processed_at: new Date().toISOString() })
            .eq('id', item.id);

        console.log(`Done: ${title}`);
    } catch (err) {
        console.error(`Error scraping ${item.url}:`, err.message);
        
        // Mark as error
        await supabase
            .from('scrape_queue')
            .update({ status: 'error', error_msg: err.message, processed_at: new Date().toISOString() })
            .eq('id', item.id);
    }
}

scrapeDetails();
