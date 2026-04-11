import * as cheerio from 'cheerio';
import { fetchHtml, delay } from './lib/fetch.js';
import { supabase } from './lib/supabase.js';

const BATCH_SIZE = 50;
const BATCH_DELAY_MS = 15000;
const MOVIE_DELAY_MS = 1500;

async function getQueueItems(limit = 50) {
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

    let title = $('li > strong:contains("Movie:") span').text().trim();
    if (!title) title = $('title').text().trim().split('|')[0].trim();

    const yearMatch = title.match(/\((\d{4})\)/);
    const year = yearMatch ? parseInt(yearMatch[1]) : null;

    const posterUrl = $('picture img').attr('src') || $('img[alt*="Poster"]').attr('src') || $('img').first().attr('src') || '';

    const synopsis = $('.movie-synopsis span').last().text().trim() || 
                   $('meta[name="description"]').attr('content') || '';

    const durationMatch = html.match(/Duration:.*?(\d{2}:\d{2}:\d{2})/);
    const duration = durationMatch ? durationMatch[1] : '';

    const genreText = $('li > strong:contains("Genres:") span').text().trim();
    const genres = genreText ? genreText.split(',').map(g => g.trim()).filter(g => g) : [];

    const directorText = $('li > strong:contains("Director:") span').text().trim();
    const director = directorText ? directorText.split(',').map(d => d.trim()).filter(d => d) : [];

    const castText = $('li > strong:contains("Starring:") span').text().trim();
    const cast = castText ? castText.split(',').map(c => c.trim()).filter(c => c) : [];

    const ratingText = $('li > strong:contains("Movie Rating:") span').text().trim();
    const rating = ratingText ? ratingText.replace('/10', '').trim() : '';

    return {
        movie_url: url,
        movie_name: title.replace(/\s*\(\d{4}\)/, '').trim(),
        year,
        duration,
        synopsis,
        director: director.length > 0 ? director : null,
        cast_members: cast.length > 0 ? cast : null,
        genres: genres.length > 0 ? genres : null,
        type: '',
        language: 'Tamil',
        rating,
        poster_url: posterUrl
    };
}

function extractQualityLinks(html, baseUrl) {
    const $ = cheerio.load(html);
    const qualities = [];

    $('a[href*="1080p"], a[href*="720p"], a[href*="original"], a[href*="hd-movie"], a[href*="hd-web"]').each((i, el) => {
        const href = $(el).attr('href');
        const text = $(el).text().toLowerCase();

        let quality = '1080p';
        if (text.includes('720p')) quality = '720p';
        else if (text.includes('1080p') || text.includes('4k')) quality = '1080p';
        else if (text.includes('original')) quality = 'Original';
        else if (text.includes('480p')) quality = '480p';
        else if (text.includes('360p')) quality = '360p';

        if (href) {
            qualities.push({
                quality,
                url: new URL(href, baseUrl).toString()
            });
        }
    });

    return qualities;
}

async function scrapeQualityPage(qualityUrl) {
    const html = await fetchHtml(qualityUrl);
    const $ = cheerio.load(html);

    const downloadUrls = [];
    $('.download a').each((i, el) => {
        const href = $(el).attr('href');
        if (href && href.startsWith('http')) {
            downloadUrls.push(href);
        }
    });

    const watchUrls = [];
    $('a:contains("Watch Online")').each((i, el) => {
        const href = $(el).attr('href');
        if (href && href.startsWith('http')) {
            watchUrls.push(href);
        }
    });

    const durationMatch = html.match(/Duration:.*?(\d{2}:\d{2}:\d{2})/);
    const duration = durationMatch ? durationMatch[1] : '';

    return {
        download_url_1: downloadUrls[0] || '',
        download_url_2: downloadUrls[1] || '',
        watch_url_1: watchUrls[0] || '',
        watch_url_2: watchUrls[1] || '',
        duration
    };
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

    const qualities = extractQualityLinks(html, item.url);

    if (qualities.length === 0) {
        await supabase.from('media').insert({
            movie_id: movieId,
            quality: 'Unknown',
            download_url_1: ''
        });
    } else {
        for (const q of qualities) {
            try {
                const mediaDetails = await scrapeQualityPage(q.url);
                await supabase.from('media').insert({
                    movie_id: movieId,
                    quality: q.quality,
                    download_url_1: mediaDetails.download_url_1,
                    download_url_2: mediaDetails.download_url_2,
                    watch_url_1: mediaDetails.watch_url_1,
                    watch_url_2: mediaDetails.watch_url_2
                });
            } catch (e) {
                await supabase.from('media').insert({
                    movie_id: movieId,
                    quality: q.quality,
                    download_url_1: q.url
                });
            }
        }
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