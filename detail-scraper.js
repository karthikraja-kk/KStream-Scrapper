import * as cheerio from 'cheerio';
import { fetchHtml, delay } from './lib/fetch.js';
import { supabase, getSourceUrl, startRefresh, finishRefresh } from './lib/supabase.js';
import { cpus } from 'os';
import { fork } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const BATCH_SIZE = 10;
const MOVIE_DELAY_MS = 300;
const NUM_WORKERS = Math.max(1, Math.min(cpus().length - 1, 4));

// Check if running as worker
const isWorker = process.env.WORKER_MODE === 'true';

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

    let title = $('h1').first().text().trim();
    if (!title) title = $('title').text().split('|')[0].trim();
    title = title.replace(/ Tamil Full Movie Download.*$/i, '').trim();

    const yearMatch = title.match(/\((\d{4})\)/);
    const year = yearMatch ? parseInt(yearMatch[1]) : null;

    const posterUrl = $('picture img').attr('src') || $('picture source').first().attr('srcset') || '';
    const posterFullUrl = posterUrl.startsWith('http') ? posterUrl : `https://moviesda18.com${posterUrl}`;

    let directorText = '';
    let castText = '';
    let genreText = '';
    let ratingText = '';
    let languageText = '';
    let typeText = '';
    let durationText = '';

    $('ul.movie-info li').each((i, el) => {
        const strong = $(el).find('strong').text();
        const span = $(el).find('span').text().trim();
        if (strong.includes('Director')) directorText = span;
        if (strong.includes('Starring')) castText = span;
        if (strong.includes('Genres')) genreText = span;
        if (strong.includes('Movie Rating')) ratingText = span;
        if (strong.includes('Language')) languageText = span;
        if (strong.includes('Quality')) typeText = span;
        if (strong.includes('Run Time') || strong.includes('Duration')) durationText = span;
    });

    if (!durationText) {
        const bodyText = $('body').text();
        const match = bodyText.match(/(\d+)\s*(?:min|minute|mins|hour|hr|hrs?)/i);
        if (match) {
            const num = parseInt(match[1]);
            const unit = match[2].toLowerCase();
            if (unit.startsWith('h')) {
                durationText = num + 'h';
            } else {
                durationText = num + 'm';
            }
        }
    }

    if (!durationText) {
        $('li, span, div, p').each((i, el) => {
            const text = $(el).text();
            if (text.match(/^\d+\s*(?:min|hour|hr)/i)) {
                const match = text.match(/^(\d+)\s*(min|hour|hr)/i);
                if (match) {
                    const num = parseInt(match[1]);
                    const unit = match[2].toLowerCase();
                    if (unit.startsWith('h')) {
                        durationText = num + 'h';
                    } else {
                        durationText = num + 'm';
                    }
                    return false;
                }
            }
        });
    }

    const synopsisText = $('.movie-synopsis').text().replace(/Synopsis:/i, '').trim();
    const synopsis = synopsisText || null;

    const director = directorText ? [directorText] : [];
    const cast = castText ? castText.split(',').map(c => c.trim()).filter(c => c) : [];
    const genres = genreText ? genreText.split(',').map(g => g.trim()).filter(g => g) : [];
    const rating = ratingText ? ratingText.replace('/10', '').trim() : '';
    const poster = posterFullUrl || null;

    return {
        movie_url: url,
        movie_name: (title.replace(/\s*\(\d{4}\)/, '').replace(/\s+Tamil\s*Movie.*$/i, '') || null),
        year,
        duration: durationText || null,
        synopsis,
        director: director.length > 0 ? director : null,
        cast_members: cast.length > 0 ? cast : null,
        genres: genres.length > 0 ? genres : null,
        type: typeText || null,
        language: languageText || null,
        rating: rating || null,
        poster_url: poster
    };
}

async function findQualityLinks(html, baseUrl) {
    const $ = cheerio.load(html);
    const qualities = [];

    let typePageUrl = '';
    $('div.f').each((i, el) => {
        const img = $(el).find('img[src*="folder"]');
        if (img.length > 0) {
            const link = $(el).find('a').first();
            const href = link.attr('href');
            if (href) {
                typePageUrl = new URL(href, baseUrl).toString();
                return false;
            }
        }
    });

    if (!typePageUrl) {
        let title = $('h1').first().text().trim();
        let movieName = title.replace(/\s*\(\d{4}\)/, '').replace(/\s+Tamil\s*Movie.*$/i, '').trim().toLowerCase();
        movieName = movieName.replace(/\d+/g, '').replace(/\s+/g, ' ').trim();

        if (movieName) {
            $('a[href*="-movie/"]').each((i, el) => {
                const href = $(el).attr('href');
                const text = $(el).text().trim().toLowerCase();
                if (text.includes(movieName) && !text.includes('1080p') && !text.includes('720p') && !text.includes('360p') && !text.includes('hd')) {
                    typePageUrl = new URL(href, baseUrl).toString();
                    return false;
                }
            });
        }
    }

    if (!typePageUrl) {
        let title = $('h1').first().text().trim();
        let movieName = title.replace(/\s*\(\d{4}\)/, '').replace(/\s+Tamil\s*Movie.*$/i, '').trim().toLowerCase();
        movieName = movieName.replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
        
        if (movieName) {
            const slug = movieName.replace(/\s+/g, '-');
            const baseUrlOrigin = new URL(baseUrl).origin;
            const possibleUrls = [
                `${baseUrlOrigin}/${slug}-original-movie/`,
                `${baseUrlOrigin}/${slug}-hq-predvd-movie/`
            ];
            
            for (const url of possibleUrls) {
                try {
                    const checkHtml = await fetchHtml(url);
                    const $check = cheerio.load(checkHtml);
                    const pageTitle = $check('title').text().toLowerCase();
                    if (pageTitle.includes('movie') || pageTitle.includes('download')) {
                        typePageUrl = url;
                        break;
                    }
                } catch (e) {}
            }
        }
    }

    if (!typePageUrl) return [];

    try {
        const typeHtml = await fetchHtml(typePageUrl);
        const $type = cheerio.load(typeHtml);

        $type('div.f').each((i, el) => {
            const img = $(el).find('img[src*="folder"]');
            if (img.length > 0) {
                const link = $(el).find('a').first();
                const href = link.attr('href');
                const text = link.text().trim().toLowerCase();
                
                if (href) {
                    let quality = 'Unknown';
                    const resMatch = text.match(/(\d+)x(\d+)/);
                    if (resMatch) {
                        const height = parseInt(resMatch[2]);
                        if (height >= 1080) quality = '1080p';
                        else if (height >= 720) quality = '720p';
                        else if (height >= 480) quality = '480p';
                        else if (height >= 360) quality = '360p';
                    } else if (text.includes('1080p')) quality = '1080p';
                    else if (text.includes('720p')) quality = '720p';
                    else if (text.includes('hd')) quality = '720p';
                    
                    qualities.push({ quality, url: new URL(href, typePageUrl).toString() });
                }
            }
        });

        if (qualities.length === 0) {
            $type('a[href*="-movie/"], a[href*="-moviesda/"]').each((i, el) => {
                const href = $(el).attr('href');
                const text = $(el).text().trim().toLowerCase();

                if (href && !href.includes('../') && href.endsWith('/')) {
                    let quality = 'Unknown';
                    const resMatch = text.match(/(\d+)x(\d+)/);
                    if (resMatch) {
                        const height = parseInt(resMatch[2]);
                        if (height >= 1080) quality = '1080p';
                        else if (height >= 720) quality = '720p';
                        else if (height >= 480) quality = '480p';
                        else if (height >= 360) quality = '360p';
                    } else if (text.includes('1080p')) quality = '1080p';
                    else if (text.includes('720p')) quality = '720p';
                    else if (text.includes('hd')) quality = '720p';
                    else return;

                    qualities.push({ quality, url: new URL(href, typePageUrl).toString() });
                }
            });
        }

        if (qualities.length === 0) {
            const pageTitle = $type('title').text().toLowerCase();
            if (pageTitle.includes('1080p')) {
                qualities.push({ quality: '1080p', url: typePageUrl });
            } else if (pageTitle.includes('720p')) {
                qualities.push({ quality: '720p', url: typePageUrl });
            } else if (pageTitle.includes('360p') || pageTitle.includes('640')) {
                qualities.push({ quality: '360p', url: typePageUrl });
            } else if (pageTitle.includes('hd')) {
                qualities.push({ quality: '720p', url: typePageUrl });
            }
        }
    } catch (e) {
        console.log('Error fetching type page:', e.message);
    }

    return qualities;
}

async function getDownloadLinks(qualityPageUrl) {
    if (!qualityPageUrl) return { download_url_1: '', download_url_2: '', watch_url_1: '', watch_url_2: '', file_size: null, duration: null };

    try {
        const html = await fetchHtml(qualityPageUrl);
        const $ = cheerio.load(html);

        let downloadUrl = '', watchUrl = '', downloadServer2 = '', watchServer2 = '', fileSize = null, duration = null;
        let movieServer1 = '', movieServer2 = '';

        $('a[href*="/download/"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href) downloadUrl = new URL(href, qualityPageUrl).toString();
        });

        if (downloadUrl && downloadUrl.includes('/download/')) {
            try {
                const dlPageHtml = await fetchHtml(downloadUrl);
                const $dl = cheerio.load(dlPageHtml);

                $dl('.details, li, div').each((i, el) => {
                    const text = $(el).text();
                    if (text.includes('File Size:')) {
                        const match = text.match(/File Size:\s*(.+)/i);
                        if (match) fileSize = match[1].trim();
                    }
                    if (text.includes('Duration:')) {
                        const match = text.match(/Duration:\s*(.+)/i);
                        if (match) duration = match[1].trim();
                    }
                });

                const jsonLd = $dl('script[type="application/ld+json"]').html();
                if (jsonLd) {
                    try {
                        const data = JSON.parse(jsonLd);
                        if (data.duration) duration = data.duration.replace('PT', '').toLowerCase();
                    } catch (e) {}
                }

                if (!duration) {
                    $dl('body').each((i, el) => {
                        const text = $(el).text();
                        const match = text.match(/(\d+)\s*(minutes?|mins?|hours?|hrs?)/i);
                        if (match) {
                            const num = parseInt(match[1]);
                            const unit = match[2].toLowerCase();
                            if (unit.startsWith('h')) {
                                duration = num + 'h';
                            } else {
                                duration = num + 'm';
                            }
                        }
                    });
                }

                $dl('.dlink a').each((i, el) => {
                    const href = $(el).attr('href');
                    const text = $(el).text().toLowerCase();
                    if (text.includes('server 1') && href) movieServer1 = href;
                    if (text.includes('server 2') && href) movieServer2 = href;
                });

                if (movieServer1 || movieServer2) {
                    if (movieServer1) {
                        const server1Html = await fetchHtml(movieServer1);
                        const $srv1 = cheerio.load(server1Html);

                        let dlServer1FinalUrl = '';
                        let watchServer1Url = '';

                        $srv1('.dlink a').each((i, el) => {
                            const href = $(el).attr('href');
                            const text = $(el).text().toLowerCase();
                            if (text.includes('download server 1') && href) dlServer1FinalUrl = href;
                            if (text.includes('watch online server 1') && href) watchServer1Url = href;
                        });

                        if (dlServer1FinalUrl) {
                            const server2Html = await fetchHtml(dlServer1FinalUrl);
                            const $srv2 = cheerio.load(server2Html);

                            $srv2('.dlink a').each((i, el) => {
                                const href = $(el).attr('href');
                                const text = $(el).text().toLowerCase();
                                if (text.includes('download server 1') && href && !downloadUrl) downloadUrl = href;
                                else if (text.includes('watch online server 1') && href && !watchServer1Url) watchServer1Url = href;
                            });
                        }

                        if (watchServer1Url) {
                            try {
                                const watch1Html = await fetchHtml(watchServer1Url);
                                const $w1 = cheerio.load(watch1Html);
                                $w1('source[src]').each((i, el) => {
                                    const src = $w1(el).attr('src');
                                    if (src && !watchUrl) watchUrl = src;
                                });
                            } catch (e) {}
                        }
                    }

                    if (movieServer2) {
                        const server2Html = await fetchHtml(movieServer2);
                        const $srv2 = cheerio.load(server2Html);

                        let dlServer2FinalUrl = '';
                        let watchServer2Url = '';

                        $srv2('.dlink a').each((i, el) => {
                            const href = $(el).attr('href');
                            const text = $(el).text().toLowerCase();
                            if (text.includes('download server 2') && href) dlServer2FinalUrl = href;
                            if (text.includes('watch online server 2') && href) watchServer2Url = href;
                        });

                        if (dlServer2FinalUrl) {
                            const server3Html = await fetchHtml(dlServer2FinalUrl);
                            const $srv3 = cheerio.load(server3Html);

                            $srv3('.dlink a').each((i, el) => {
                                const href = $(el).attr('href');
                                const text = $(el).text().toLowerCase();
                                if (text.includes('download server 2') && href && !downloadServer2) downloadServer2 = href;
                                else if (text.includes('watch online server 2') && href && !watchServer2Url) watchServer2Url = href;
                            });
                        }

                        if (watchServer2Url) {
                            try {
                                const watch2Html = await fetchHtml(watchServer2Url);
                                const $w2 = cheerio.load(watch2Html);
                                $w2('source[src]').each((i, el) => {
                                    const src = $w2(el).attr('src');
                                    if (src && !watchServer2) watchServer2 = src;
                                });
                            } catch (e) {}
                        }
                    }
                }
            } catch (e) {}
        }

        return { download_url_1: downloadUrl, download_url_2: downloadServer2, watch_url_1: watchUrl, watch_url_2: watchServer2, file_size: fileSize, duration: duration };
    } catch (e) {
        return { download_url_1: '', download_url_2: '', watch_url_1: '', watch_url_2: '', file_size: null, duration: null };
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
        const firstQualityLinks = await findQualityLinks(html, item.url);
        if (firstQualityLinks.length > 0) {
            const dl = await getDownloadLinks(firstQualityLinks[0].url);
            if (dl.duration) movieDetails.duration = dl.duration;
        }
        await supabase.from('movies').update(movieDetails).eq('id', existingMovie.id);
        movieId = existingMovie.id;
    } else {
        const { data: newMovie, error } = await supabase.from('movies').insert(movieDetails).select('id').single();
        if (error) throw error;
        movieId = newMovie.id;

        const firstQualityLinks = await findQualityLinks(html, item.url);
        if (firstQualityLinks.length > 0) {
            const dl = await getDownloadLinks(firstQualityLinks[0].url);
            if (dl.duration) {
                await supabase.from('movies').update({ duration: dl.duration }).eq('id', movieId);
            }
        }
    }

    await supabase.from('media').delete().eq('movie_id', movieId);

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
            const mediaDuration = downloadLinks.duration || movieDetails.duration || null;
            await supabase.from('media').insert({
                movie_id: movieId,
                quality: q.quality,
                file_size: downloadLinks.file_size || null,
                duration: mediaDuration,
                download_url_1: downloadLinks.download_url_1 || q.url,
                download_url_2: downloadLinks.download_url_2 || null,
                watch_url_1: downloadLinks.watch_url_1 || null,
                watch_url_2: downloadLinks.watch_url_2 || null
            });
            await delay(MOVIE_DELAY_MS);
        }
    }

    await updateQueueStatus(item.id, 'done');
    return movieDetails.movie_name;
}

// Worker function - processes a batch of items
async function runWorker(items, workerId) {
    console.log(`[${workerId}] Starting with ${items.length} items`);
    
    let processed = 0;
    let errors = 0;
    
    for (const item of items) {
        try {
            const title = await scrapeMovieDetails(item);
            console.log(`[${workerId}] Done: ${title}`);
            processed++;
        } catch (err) {
            console.error(`[${workerId}] Error: ${item.url} - ${err.message}`);
            await updateQueueStatus(item.id, 'error', err.message);
            errors++;
        }
    }
    
    console.log(`[${workerId}] Completed: ${processed} success, ${errors} errors`);
    return { processed, errors };
}

// Main function - orchestrates workers
async function runDistributed() {
    console.log('Starting Distributed Scraper...');
    console.log(`Workers: ${NUM_WORKERS}, Batch size: ${BATCH_SIZE}`);
    
    await supabase.from('scrape_queue').delete().neq('status', 'pending');
    console.log('Cleaned old queue items');
    
    let totalProcessed = 0;
    let batchNum = 0;
    
    while (true) {
        const queueItems = await getQueueItems(BATCH_SIZE * NUM_WORKERS);
        if (queueItems.length === 0) {
            console.log('No more pending items.');
            break;
        }
        
        batchNum++;
        console.log(`\n=== Batch ${batchNum}: ${queueItems.length} items ===`);
        
        // Distribute to workers
        const itemsPerWorker = Math.ceil(queueItems.length / NUM_WORKERS);
        const workerPromises = [];
        
        for (let w = 0; w < NUM_WORKERS; w++) {
            const start = w * itemsPerWorker;
            const end = Math.min(start + itemsPerWorker, queueItems.length);
            const workerItems = queueItems.slice(start, end);
            
            if (workerItems.length === 0) continue;
            
            const workerPromise = (async () => {
                const worker = fork(join(__dirname, 'detail-scraper.js'), [], {
                    env: { 
                        ...process.env, 
                        WORKER_MODE: 'true', 
                        WORKER_ID: `worker-${w}`,
                        WORKER_ITEMS: JSON.stringify(workerItems)
                    },
                    stdio: ['pipe', 'pipe', 'pipe', 'ipc']
                });
                
                return new Promise((resolve) => {
                    worker.on('message', (msg) => {
                        totalProcessed += msg.processed;
                    });
                    
                    worker.on('exit', (code) => {
                        if (code === 0) {
                            console.log(`[worker-${w}] Completed batch`);
                        } else {
                            console.error(`[worker-${w}] Failed with code ${code}`);
                        }
                        resolve(code);
                    });
                });
            })();
            
            workerPromises.push(workerPromise);
        }
        
        await Promise.all(workerPromises);
        
        // Memory cleanup
        if (global.gc) global.gc();
        
        if (queueItems.length < BATCH_SIZE * NUM_WORKERS) {
            console.log('All items processed.');
            break;
        }
        
        await delay(5000);
    }
    
    console.log(`\n✓ Total processed: ${totalProcessed}`);
    await finishRefresh('completed');
}

// Entry point
if (isWorker) {
    const workerId = process.env.WORKER_ID || 'worker';
    const workerItems = JSON.parse(process.env.WORKER_ITEMS || '[]');
    runWorker(workerItems, workerId).then((result) => {
        if (process.send) {
            process.send(result);
        }
        setTimeout(() => process.exit(0), 1000);
    });
} else {
    runDistributed().catch(console.error);
}