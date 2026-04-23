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

    const synopsisText = $('.movie-synopsis').text().replace(/Synopsis:/i, '').trim();
    const synopsis = synopsisText || null;

    const director = directorText ? [directorText] : [];
    const cast = castText ? castText.split(/[,|&]/).map(c => c.trim()).filter(c => c) : [];
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
    let qualityLinks = [];
    const seenQualities = new Set();

    const getQualityFromText = (text) => {
        text = text.toLowerCase();
        let q = null;
        if (text.includes('1080p')) q = '1080p';
        else if (text.includes('720p')) q = '720p';
        else if (text.includes('480p')) q = '480p';
        else if (text.includes('360p')) q = '360p';
        else if (text.includes('hd')) q = '720p';
        else if (text.includes('original')) q = 'Original';
        
        if (q && text.includes('hevc')) q += ' (HEVC)';
        return q;
    };

    // 1. Try to find quality folders directly on the page
    $('div.f').each((i, el) => {
        const link = $(el).find('a').first();
        const href = link.attr('href');
        const text = link.text().trim();
        if (href) {
            let quality = getQualityFromText(text);
            if (quality && quality !== 'Original') {
                if (!seenQualities.has(quality)) {
                    qualityLinks.push({ quality, url: new URL(href, baseUrl).toString() });
                    seenQualities.add(quality);
                }
            }
        }
    });

    // 2. If no explicit qualities (other than Original) found, check for the "(Original)" folder to find more
    if (qualityLinks.length === 0) {
        let originalPageUrl = '';
        $('div.f').each((i, el) => {
            const link = $(el).find('a').first();
            const href = link.attr('href');
            const text = link.text().trim().toLowerCase();
            if (href && text.includes('original')) {
                originalPageUrl = new URL(href, baseUrl).toString();
                return false;
            }
        });

        if (originalPageUrl) {
            try {
                const originalHtml = await fetchHtml(originalPageUrl);
                const $orig = cheerio.load(originalHtml);
                $orig('div.f').each((i, el) => {
                    const link = $orig(el).find('a').first();
                    const href = link.attr('href');
                    const text = link.text().trim();
                    if (href) {
                        let quality = getQualityFromText(text);
                        if (quality) {
                            if (!seenQualities.has(quality)) {
                                qualityLinks.push({ quality, url: new URL(href, originalPageUrl).toString() });
                                seenQualities.add(quality);
                            }
                        }
                    }
                });
            } catch (e) {
                console.log('Error fetching original page:', e.message);
            }
        }
    }

    // 3. Fallback: If still empty, check for any folder that might be a quality link
    if (qualityLinks.length === 0) {
        $('div.f').each((i, el) => {
            const link = $(el).find('a').first();
            const href = link.attr('href');
            const text = link.text().trim();
            if (href && (text.includes('movie') || text.includes('hd') || text.includes('original'))) {
                let quality = getQualityFromText(text) || 'Unknown';
                if (!seenQualities.has(quality)) {
                    qualityLinks.push({ quality, url: new URL(href, baseUrl).toString() });
                    seenQualities.add(quality);
                    return false; // Just take the first one as fallback
                }
            }
        });
    }

    return qualityLinks;
}

async function getDownloadLinks(qualityPageUrl) {
    if (!qualityPageUrl) return { download_url_1: '', download_url_2: '', watch_url_1: '', watch_url_2: '', file_size: null, duration: null };

    try {
        const html = await fetchHtml(qualityPageUrl);
        const $ = cheerio.load(html);

        let initialDownloadPageUrl = '';
        let fileSize = null, duration = null;

        // Find link to download details page
        $('a[href*="/download/"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href && !initialDownloadPageUrl) initialDownloadPageUrl = new URL(href, qualityPageUrl).toString();
        });

        if (!initialDownloadPageUrl) {
            $('a[href*="/dl/"]').each((i, el) => {
                const href = $(el).attr('href');
                if (href && !initialDownloadPageUrl) initialDownloadPageUrl = new URL(href, qualityPageUrl).toString();
            });
        }

        if (!initialDownloadPageUrl) return { download_url_1: '', download_url_2: '', watch_url_1: '', watch_url_2: '', file_size: null, duration: null };

        // Fetch download details page
        const dlPageHtml = await fetchHtml(initialDownloadPageUrl);
        const $dl = cheerio.load(dlPageHtml);

        // Extract metadata
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
                if (data.duration) {
                    duration = data.duration.replace('PT', '').toLowerCase();
                }
            } catch (e) {}
        }

        let movieServer1PageUrl = '', movieServer2PageUrl = '';
        $dl('.dlink a').each((i, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().toLowerCase();
            if (text.includes('server 1') && href) movieServer1PageUrl = new URL(href, initialDownloadPageUrl).toString();
            if (text.includes('server 2') && href) movieServer2PageUrl = new URL(href, initialDownloadPageUrl).toString();
        });

        let finalDownloadUrl1 = '', finalWatchUrl1 = '';
        let finalDownloadUrl2 = '', finalWatchUrl2 = '';

        // Server 1 Chain
        if (movieServer1PageUrl) {
            try {
                const srv1Html = await fetchHtml(movieServer1PageUrl);
                const $srv1 = cheerio.load(srv1Html);

                let dlSrv1RedirectUrl = '', watchSrv1PageUrl = '';
                $srv1('.dlink a').each((i, el) => {
                    const href = $(el).attr('href');
                    const text = $(el).text().toLowerCase();
                    if (text.includes('download server 1') && href) dlSrv1RedirectUrl = new URL(href, movieServer1PageUrl).toString();
                    if (text.includes('watch online server 1') && href) watchSrv1PageUrl = new URL(href, movieServer1PageUrl).toString();
                });

                if (dlSrv1RedirectUrl) {
                    const srv1FinalHtml = await fetchHtml(dlSrv1RedirectUrl);
                    const $srv1F = cheerio.load(srv1FinalHtml);
                    $srv1F('.dlink a').each((i, el) => {
                        const href = $(el).attr('href');
                        const text = $(el).text().toLowerCase();
                        if (text.includes('download server 1') && href) finalDownloadUrl1 = href;
                    });
                }

                if (watchSrv1PageUrl) {
                    const watch1Html = await fetchHtml(watchSrv1PageUrl);
                    const $w1 = cheerio.load(watch1Html);
                    const src = $w1('source[src]').attr('src');
                    if (src) finalWatchUrl1 = src;
                }
            } catch (e) {
                console.log('Error in Server 1 chain:', e.message);
            }
        }

        // Server 2 Chain
        if (movieServer2PageUrl) {
            try {
                const srv2Html = await fetchHtml(movieServer2PageUrl);
                const $srv2 = cheerio.load(srv2Html);

                let dlSrv2RedirectUrl = '', watchSrv2PageUrl = '';
                $srv2('.dlink a').each((i, el) => {
                    const href = $(el).attr('href');
                    const text = $(el).text().toLowerCase();
                    if (text.includes('download server 2') && href) dlSrv2RedirectUrl = new URL(href, movieServer2PageUrl).toString();
                    if (text.includes('watch online server 2') && href) watchSrv2PageUrl = new URL(href, movieServer2PageUrl).toString();
                });

                if (dlSrv2RedirectUrl) {
                    const srv2FinalHtml = await fetchHtml(dlSrv2RedirectUrl);
                    const $srv2F = cheerio.load(srv2FinalHtml);
                    $srv2F('.dlink a').each((i, el) => {
                        const href = $(el).attr('href');
                        const text = $(el).text().toLowerCase();
                        if (text.includes('download server 2') && href) finalDownloadUrl2 = href;
                    });
                }

                if (watchSrv2PageUrl) {
                    const watch2Html = await fetchHtml(watchSrv2PageUrl);
                    const $w2 = cheerio.load(watch2Html);
                    const src = $w2('source[src]').attr('src');
                    if (src) finalWatchUrl2 = src;
                }
            } catch (e) {
                console.log('Error in Server 2 chain:', e.message);
            }
        }

        return { 
            download_url_1: finalDownloadUrl1 || initialDownloadPageUrl, 
            download_url_2: finalDownloadUrl2, 
            watch_url_1: finalWatchUrl1, 
            watch_url_2: finalWatchUrl2, 
            file_size: fileSize, 
            duration: duration 
        };
    } catch (e) {
        console.log('Error in getDownloadLinks:', e.message);
        return { download_url_1: '', download_url_2: '', watch_url_1: '', watch_url_2: '', file_size: null, duration: null };
    }
}

async function scrapeMovieDetails(item) {
    console.log(`Scraping: ${item.url}`);
    const html = await fetchHtml(item.url);
    const movieDetails = extractMovieDetails(html, item.url);
    console.log(`  Extracted: name=${movieDetails.movie_name}, year=${movieDetails.year}, duration=${movieDetails.duration}, type=${movieDetails.type}`);

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

    for (const q of qualityLinks) {
        const downloadLinks = await getDownloadLinks(q.url);
        await supabase.from('media').insert({
            movie_id: movieId,
            quality: q.quality,
            file_size: downloadLinks.file_size || null,
            duration: downloadLinks.duration || movieDetails.duration || null,
            download_url_1: downloadLinks.download_url_1 || q.url,
            download_url_2: downloadLinks.download_url_2 || null,
            watch_url_1: downloadLinks.watch_url_1 || null,
            watch_url_2: downloadLinks.watch_url_2 || null
        });
        await delay(MOVIE_DELAY_MS);
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
} else if (process.argv[2]) {
    // Single URL test mode: node detail-scraper.js <url>
    const testUrl = process.argv[2];
    console.log(`Testing single URL: ${testUrl}`);
    const testItem = { id: 0, url: testUrl, folder: 'test', priority: 1 };
    scrapeMovieDetails(testItem)
        .then((title) => {
            console.log(`✓ Test completed: ${title}`);
            process.exit(0);
        })
        .catch((err) => {
            console.error(`✗ Test failed: ${err.message}`);
            process.exit(1);
        });
} else {
    runDistributed().catch(console.error);
}