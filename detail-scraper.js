import * as cheerio from 'cheerio';
import { fetchHtml, delay } from './lib/fetch.js';
import { supabase } from './lib/supabase.js';

const BATCH_SIZE = 50;
const BATCH_DELAY_MS = 15000;
const MOVIE_DELAY_MS = 1500;

async function getQueueItems(limit = 15) {
    const { data, error } = await supabase
        .from('scrape_queue')
        .select('*')
        .eq('status', 'pending')
        .order('priority', { ascending: true })
        .order('queued_at', { ascending: true })
        .limit(limit);

    if (error) throw error;
    return data || [];
}

async function updateQueueStatus(id, status, errorMsg = null) {
    await supabase
        .from('scrape_queue')
        .update({
            status,
            error_msg: errorMsg,
            processed_at: new Date().toISOString()
        })
        .eq('id', id);
}

function extractMovieDetails(html, url) {
    const $ = cheerio.load(html);

    const title = $('title').text().trim() || '';
    const yearMatch = title.match(/\((\d{4})\)/);
    const year = yearMatch ? parseInt(yearMatch[1]) : null;

    const posterUrl = $('img').first().attr('src') || '';

    const synopsis = $('meta[name="description"]').attr('content') || '';

    const durationMatch = html.match(/(\d{2}:\d{2}:\d{2})/);
    const duration = durationMatch ? durationMatch[1] : '';

    const genre = [];
    $('.genre a, .genres a').each((i, el) => {
        const text = $(el).text().trim();
        if (text) genre.push(text);
    });

    const director = [];
    $('a[href*="director"], .director a').each((i, el) => {
        const text = $(el).text().trim();
        if (text) director.push(text);
    });

    const cast = [];
    $('a[href*="cast"], .cast a').each((i, el) => {
        const text = $(el).text().trim();
        if (text) cast.push(text);
    });

    const rating = $('[itemprop="ratingValue"], .rating').text().trim() || '';

    const type = '';

    const language = '';

    return {
        movie_url: url,
        movie_name: title.replace(/\s*\(\d{4}\)/, '').trim(),
        year,
        duration,
        synopsis,
        director: director.length > 0 ? director : null,
        cast_members: cast.length > 0 ? cast : null,
        genres: genre.length > 0 ? genre : null,
        type,
        language,
        rating,
        poster_url: posterUrl
    };
}

function extractMediaDetails(html, movieId) {
    const $ = cheerio.load(html);
    const media = [];

    $('a[href*="1080p"], a[href*="720p"], a[href*="original"]').each((i, el) => {
        const href = $(el).attr('href');
        const text = $(el).text().trim().toLowerCase();

        let quality = '1080p';
        if (text.includes('720p')) quality = '720p';
        else if (text.includes('original')) quality = 'Original';
        else if (text.includes('480p')) quality = '480p';

        if (href) {
            media.push({
                movie_id: movieId,
                quality,
                download_url_1: href
            });
        }
    });

    if (media.length === 0) {
        media.push({
            movie_id: movieId,
            quality: 'Unknown',
            download_url_1: ''
        });
    }

    return media;
}

async function scrapeMovieDetails(item) {
    const html = await fetchHtml(item.url);
    const movieDetails = extractMovieDetails(html, item.url);

    const { data: existingMovie } = await supabase
        .from('movies')
        .select('id')
        .eq('movie_url', item.url)
        .single();

    let movieId;

    if (existingMovie) {
        await supabase
            .from('movies')
            .update(movieDetails)
            .eq('id', existingMovie.id);
        movieId = existingMovie.id;
    } else {
        const { data: newMovie, error } = await supabase
            .from('movies')
            .insert(movieDetails)
            .select('id')
            .single();

        if (error) throw error;
        movieId = newMovie.id;
    }

    await supabase
        .from('media')
        .delete()
        .eq('movie_id', movieId);

    const mediaDetails = extractMediaDetails(html, movieId);

    if (mediaDetails.length > 0) {
        await supabase
            .from('media')
            .insert(mediaDetails);
    }

    return movieDetails.movie_name;
}

async function scrapeDetails() {
    console.log('Starting Detail Scraper...');

    try {
        const queueItems = await getQueueItems(BATCH_SIZE);
        console.log(`Processing ${queueItems.length} items from queue...`);

        if (queueItems.length === 0) {
            console.log('No pending items.');
            return;
        }

        let processed = 0;

        for (const item of queueItems) {
            try {
                console.log(`Scraping: ${item.url}...`);
                const title = await scrapeMovieDetails(item);
                console.log(`Done: ${title}`);

                await updateQueueStatus(item.id, 'done');
                processed++;

                if (processed % BATCH_SIZE === 0) {
                    console.log(`Batch limit reached, pausing ${BATCH_DELAY_MS / 1000}s...`);
                    await delay(BATCH_DELAY_MS);
                } else {
                    await delay(MOVIE_DELAY_MS);
                }
            } catch (err) {
                console.error(`Error: ${item.url}: ${err.message}`);
                await updateQueueStatus(item.id, 'error', err.message);
            }
        }

        console.log(`Detail Scraper finished. Processed ${processed} movies.`);
    } catch (err) {
        console.error('Scraper Error:', err.message);
    }
}

scrapeDetails();