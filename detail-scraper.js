import * as cheerio from 'cheerio';
import { fetchHtml, delay } from './lib/fetch.js';
import { supabase, getSourceUrl, startRefresh, finishRefresh } from './lib/supabase.js';

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

async function cleanQueue() {
    await supabase.from('scrape_queue').delete().neq('status', 'pending');
    console.log('Cleaned old queue items');
}

function extractMovieDetails(html, url) {
    const $ = cheerio.load(html);

    let title = $('h1').first().text().trim();
    if (!title) title = $('title').text().split('|')[0].trim();
    title = title.replace(/ Tamil Full Movie Download.*$/i, '').trim();

    const yearMatch = title.match(/\((\d{4})\)/);
    const year = yearMatch ? parseInt(yearMatch[1]) : null;

    const posterUrl = $('picture img').attr('src') || '';
    const posterFullUrl = posterUrl.startsWith('http') ? posterUrl : `https://moviesda18.com${posterUrl}`;

    const synopsis = $('.movie-synopsis span').last().text().trim() || '';

    const directorText = $('li > strong:contains("Director:") span').text().trim();
    const director = directorText ? [directorText] : [];

    const castText = $('li > strong:contains("Starring:") span').text().trim();
    const cast = castText ? castText.split(',').map(c => c.trim()).filter(c => c) : [];

    const genreText = $('li > strong:contains("Genres:") span').text().trim();
    const genres = genreText ? genreText.split(',').map(g => g.trim()).filter(g => g) : [];

    const ratingText = $('li > strong:contains("Movie Rating:") span').text().trim();
    const rating = ratingText ? ratingText.replace('/10', '').trim() : '';

    const languageText = $('li > strong:contains("Language:") span').text().trim();

    const typeText = $('li > strong:contains("Quality:") span').text().trim();

    return {
        movie_url: url,
        movie_name: title.replace(/\s*\(\d{4}\)/, '').trim(),
        year,
        synopsis,
        director: director.length > 0 ? director : null,
        cast_members: cast.length > 0 ? cast : null,
        genres: genres.length > 0 ? genres : null,
        type: typeText || '',
        language: languageText || 'Tamil',
        rating,
        poster_url: posterFullUrl
    };
}

async function findQualityLinks(html, baseUrl) {
    const $ = cheerio.load(html);
    const qualities = [];

    $('a[href*="-movie/"]').each((i, el) => {
        const href = $(el).attr('href');
        const text = $(el).text().trim().toLowerCase();

        if (href && !href.includes('../') && href.endsWith('/')) {
            let quality = 'Unknown';

            if (text.includes('720p') || text.includes('hd')) quality = '720p';
            else if (text.includes('1080p')) quality = '1080p';
            else if (text.includes('360p')) quality = '360p';
            else if (text.includes('original')) quality = 'Original';
            else if (text.includes('hq') || text.includes('predvd')) quality = 'HQ PreDVD';
            else if (text.includes('dvdrip') || text.includes('dvd')) quality = 'DVDRip';
            else if (text.includes('webrip') || text.includes('web')) quality = 'WEBRip';

            if (quality !== 'Unknown') {
                qualities.push({
                    quality,
                    url: new URL(href, baseUrl).toString()
                });
            }
        }
    });

    return qualities;
}

async function getDownloadLinks(qualityPageUrl) {
    if (!qualityPageUrl) return { download_url_1: '', watch_url_1: '' };

    try {
        const html = await fetchHtml(qualityPageUrl);
        const $ = cheerio.load(html);

        let downloadUrl = '';
        let watchUrl = '';

        $('a[href*="download"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href && href.startsWith('http') && !downloadUrl) {
                downloadUrl = href;
            } else if (href && href.startsWith('http') && href.includes('stream') && !watchUrl) {
                watchUrl = href;
            }
        });

        if (!downloadUrl) {
            $('a[href*="/download/"]').each((i, el) => {
                const href = $(el).attr('href');
                if (href) {
                    const fullUrl = new URL(href, qualityPageUrl).toString();
                    downloadUrl = fullUrl;
                }
            });
        }

        return { download_url_1: downloadUrl, watch_url_1: watchUrl };
    } catch (e) {
        return { download_url_1: '', watch_url_1: '' };
    }
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

    const qualityLinks = await findQualityLinks(html, item.url);

    if (qualityLinks.length === 0) {
        await supabase.from('media').insert({
            movie_id: movieId,
            quality: 'Unknown',
            download_url_1: ''
        });
    } else {
        for (const q of qualityLinks) {
            const downloadLinks = await getDownloadLinks(q.url);
            await supabase.from('media').insert({
                movie_id: movieId,
                quality: q.quality,
                download_url_1: downloadLinks.download_url_1 || q.url,
                watch_url_1: downloadLinks.watch_url_1
            });
            await delay(500);
        }
    }

    return movieDetails.movie_name;
}

async function scrapeDetails() {
    console.log('Starting Detail Scraper...');

    try {
        await cleanQueue();

        const queueItems = await getQueueItems(BATCH_SIZE);
        console.log(`Processing ${queueItems.length} items from queue...`);

        if (queueItems.length === 0) {
            console.log('No pending items.');
            await finishRefresh('completed');
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
        await finishRefresh('completed');
    } catch (err) {
        console.error('Scraper Error:', err.message);
        await finishRefresh('failed');
    }
}

scrapeDetails();