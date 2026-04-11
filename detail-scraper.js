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

    // First check for quality links directly on movie page
    let qualityLinksOnPage = [];
    $('a[href*="-movie/"]').each((i, el) => {
        const href = $(el).attr('href');
        const text = $(el).text().trim().toLowerCase();
        if (href && !href.includes('../') && href.endsWith('/') && !text.includes('(original)')) {
            let quality = 'Unknown';
            if (text.includes('1080p')) quality = '1080p';
            else if (text.includes('720p')) quality = '720p';
            else if (text.includes('360p')) quality = '360p';
            if (quality !== 'Unknown') {
                qualityLinksOnPage.push({ quality, url: new URL(href, baseUrl).toString() });
            }
        }
    });

    // If no quality links on movie page directly, need to go to Original page first
    if (qualityLinksOnPage.length === 0) {
        let originalUrl = '';
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().toLowerCase();
            if (href && text.includes('(original)')) {
                originalUrl = new URL(href, baseUrl).toString();
            }
        });

        if (originalUrl) {
            try {
                const origHtml = await fetchHtml(originalUrl);
                const $orig = cheerio.load(origHtml);

                $orig('a[href*="-movie/"]').each((i, el) => {
                    const href = $(el).attr('href');
                    const text = $(el).text().trim().toLowerCase();
                    if (href && !href.includes('../') && href.endsWith('/') && !text.includes('(original)')) {
                        let quality = 'Unknown';
                        if (text.includes('1080p')) quality = '1080p';
                        else if (text.includes('720p')) quality = '720p';
                        else if (text.includes('360p')) quality = '360p';
                        if (quality !== 'Unknown') {
                            qualities.push({
                                quality,
                                url: new URL(href, originalUrl).toString()
                            });
                        }
                    }
                });
            } catch (e) {
                console.log('Error fetching Original page:', e.message);
            }
        }
    } else {
        qualities.push(...qualityLinksOnPage);
    }

    return qualities;
}

async function getDownloadLinks(qualityPageUrl) {
    if (!qualityPageUrl) return { download_url_1: '', download_url_2: '', watch_url_1: '', watch_url_2: '', file_size: null, duration: null };

    try {
        const html = await fetchHtml(qualityPageUrl);
        const $ = cheerio.load(html);

        let downloadUrl = '';
        let watchUrl = '';
        let downloadServer2 = '';
        let watchServer2 = '';
        let fileSize = null;
        let duration = null;

        // Get the download link from quality page
        $('a[href*="/download/"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href) {
                const fullUrl = new URL(href, qualityPageUrl).toString();
                if (!downloadUrl) downloadUrl = fullUrl;
            }
        });

        // If no download URL found, try other pattern
        if (!downloadUrl) {
            $('a[href*="download"]').each((i, el) => {
                const href = $(el).attr('href');
                if (href && href.startsWith('http') && !downloadUrl) {
                    downloadUrl = href;
                } else if (href && href.startsWith('http') && href.includes('stream') && !watchUrl) {
                    watchUrl = href;
                }
            });
        }

        // Fetch the download page to get file_size, duration, and server links
        if (downloadUrl && downloadUrl.includes('/download/')) {
            try {
                const dlPageHtml = await fetchHtml(downloadUrl);
                const $dl = cheerio.load(dlPageHtml);

                $dl('.details').each((i, el) => {
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

                // Also try JSON-LD
                const jsonLd = $dl('script[type="application/ld+json"]').html();
                if (jsonLd) {
                    try {
                        const data = JSON.parse(jsonLd);
                        if (data.duration) {
                            duration = data.duration.replace('PT', '').toLowerCase();
                        }
                    } catch (e) {}
                }

                // Get download server links (server 1 and server 2)
                let movieServer1 = '';
                let movieServer2 = '';

                $dl('.dlink a').each((i, el) => {
                    const href = $(el).attr('href');
                    const text = $(el).text().toLowerCase();
                    if (text.includes('server 1') && href) movieServer1 = href;
                    if (text.includes('server 2') && href) movieServer2 = href;
                });

                // Fetch server 1 page - this may redirect to another page with Download Server 1/2
                if (movieServer1) {
                    try {
                        const server1Html = await fetchHtml(movieServer1);
                        const $srv1 = cheerio.load(server1Html);

                        // Get links for both download server 1 and download server 2 from this page
                        let downloadServer1Url = '';
                        let downloadServer2Url = '';
                        let watchServer1Url = '';
                        let watchServer2Url = '';

                        $srv1('.dlink a').each((i, el) => {
                            const href = $(el).attr('href');
                            const text = $(el).text().toLowerCase();
                            if (text.includes('download server 1') && href) downloadServer1Url = href;
                            if (text.includes('download server 2') && href) downloadServer2Url = href;
                            if (text.includes('watch online server 1') && href) watchServer1Url = href;
                            if (text.includes('watch online server 2') && href) watchServer2Url = href;
                        });

                        // Follow Download Server 1 to get final download_url_1 and watch_url_1
                        if (downloadServer1Url) {
                            try {
                                const dl1Html = await fetchHtml(downloadServer1Url);
                                const $dl1 = cheerio.load(dl1Html);

                                $dl1('.dlink a').each((i, el) => {
                                    const href = $(el).attr('href');
                                    const text = $(el).text().toLowerCase();
                                    if (text.includes('download') && !text.includes('watch') && href && !downloadUrl) {
                                        downloadUrl = href;
                                    }
                                });

                                // Get watch URL from this page
                                let watchServer1Final = '';
                                $dl1('.dlink a').each((i, el) => {
                                    const href = $(el).attr('href');
                                    const text = $(el).text().toLowerCase();
                                    if (text.includes('watch online server 1') && href) {
                                        watchServer1Final = href;
                                    }
                                    if (text.includes('watch online server 2') && href) {
                                        downloadServer2 = href;
                                    }
                                });

                                // Follow watch page to get actual video URL
                                if (watchServer1Final) {
                                    try {
                                        const watch1Html = await fetchHtml(watchServer1Final);
                                        const $w1 = cheerio.load(watch1Html);
                                        $w1('source').each((i, el) => {
                                            const src = $w1(el).attr('src');
                                            if (src && !watchUrl) watchUrl = src;
                                        });
                                    } catch (e) {}
                                }
                            } catch (e) {}
                        }

                        // Follow Download Server 2 to get final download_url_2
                        if (downloadServer2Url) {
                            try {
                                const dl2Html = await fetchHtml(downloadServer2Url);
                                const $dl2 = cheerio.load(dl2Html);

                                $dl2('.dlink a').each((i, el) => {
                                    const href = $(el).attr('href');
                                    const text = $(el).text().toLowerCase();
                                    if (text.includes('download') && !text.includes('watch') && href) {
                                        downloadServer2 = href;
                                    }
                                });

                                // Get watch URL 2 from this page
                                let watchServer2Final = '';
                                if (!watchServer2) {
                                    $dl2('.dlink a').each((i, el) => {
                                        const href = $(el).attr('href');
                                        const text = $(el).text().toLowerCase();
                                        if (text.includes('watch online server 2') && href) {
                                            watchServer2Final = href;
                                        }
                                    });

                                    // Follow watch page 2 to get actual video URL
                                    if (watchServer2Final) {
                                        try {
                                            const watch2Html = await fetchHtml(watchServer2Final);
                                            const $w2 = cheerio.load(watch2Html);
                                            $w2('source').each((i, el) => {
                                                const src = $w2(el).attr('src');
                                                if (src) watchServer2 = src;
                                            });
                                        } catch (e) {}
                                    }
                                }
                            } catch (e) {}
                        }

                        // Fallback to watch URLs from redirect page if not found
                        if (!watchUrl && watchServer1Url) watchUrl = watchServer1Url;
                    } catch (e) {}
                }
            } catch (e) {
                // Continue even if download page fails
            }
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
                file_size: downloadLinks.file_size,
                duration: downloadLinks.duration,
                download_url_1: downloadLinks.download_url_1 || q.url,
                download_url_2: downloadLinks.download_url_2 || null,
                watch_url_1: downloadLinks.watch_url_1 || null,
                watch_url_2: downloadLinks.watch_url_2 || null
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

        let totalProcessed = 0;
        let batchNum = 0;

        while (true) {
            const queueItems = await getQueueItems(BATCH_SIZE);
            if (queueItems.length === 0) {
                console.log('No more pending items.');
                break;
            }

            batchNum++;
            console.log(`Batch ${batchNum}: Processing ${queueItems.length} items...`);

            for (const item of queueItems) {
                try {
                    console.log(`Scraping: ${item.url}...`);
                    const title = await scrapeMovieDetails(item);
                    console.log(`Done: ${title}`);

                    await updateQueueStatus(item.id, 'done');
                    totalProcessed++;
                    await delay(MOVIE_DELAY_MS);
                } catch (err) {
                    console.error(`Error: ${item.url}: ${err.message}`);
                    await updateQueueStatus(item.id, 'error', err.message);
                }
            }

            if (queueItems.length < BATCH_SIZE) {
                console.log('All items processed.');
                break;
            }

            console.log(`Batch ${batchNum} complete, pausing ${BATCH_DELAY_MS / 1000}s...`);
            await delay(BATCH_DELAY_MS);
        }

        console.log(`Detail Scraper finished. Processed ${totalProcessed} movies total.`);
        await finishRefresh('completed');
    } catch (err) {
        console.error('Scraper Error:', err.message);
        await finishRefresh('failed');
    }
}

scrapeDetails();