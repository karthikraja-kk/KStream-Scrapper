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

    // Get movie name from title - remove year, Tamil Movie, and numbers
    let title = $('h1').first().text().trim();
    let movieName = title.replace(/\s*\(\d{4}\)/, '').replace(/\s+Tamil\s*Movie.*$/i, '').trim().toLowerCase();
    movieName = movieName.replace(/\d+/g, '').replace(/\s+/g, ' ').trim();

    if (!movieName) return [];

    // Find type page link containing movie name (e.g., "Bhairathi Ranagal (Original)" or "TN (HQ PreDVD)")
    let typePageUrl = '';
    $('a[href*="-movie/"]').each((i, el) => {
        const href = $(el).attr('href');
        const text = $(el).text().trim().toLowerCase();

        // Match movie name but NOT quality indicators
        if (text.includes(movieName) && !text.includes('1080p') && !text.includes('720p') && !text.includes('360p') && !text.includes('hd')) {
            typePageUrl = new URL(href, baseUrl).toString();
            return false;
        }
    });

    if (!typePageUrl) return [];

    // Fetch type page to get quality links
    try {
        const typeHtml = await fetchHtml(typePageUrl);
        const $type = cheerio.load(typeHtml);

        $type('a[href*="-movie/"]').each((i, el) => {
            const href = $(el).attr('href');
            const text = $(el).text().trim().toLowerCase();

            // Look for quality links
            if (href && !href.includes('../') && href.endsWith('/')) {
                let quality = 'Unknown';
                if (text.includes('1080p')) quality = '1080p';
                else if (text.includes('720p')) quality = '720p';
                else if (text.includes('480p')) quality = '480p';
                else if (text.includes('360p')) quality = '360p';
                else if (text.includes('hd')) quality = '720p';
                else return;

                qualities.push({ quality, url: new URL(href, typePageUrl).toString() });
            }
        });
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

        let downloadUrl = '';
        let watchUrl = '';
        let downloadServer2 = '';
        let watchServer2 = '';
        let fileSize = null;
        let duration = null;

        // Get the download link from quality page - check multiple patterns
        $('a[href*="/download/"], a[href*="/dl/"]').each((i, el) => {
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

        // Try to extract duration from quality page itself
        $('li, span, div').each((i, el) => {
            const text = $(el).text();
            if (text.match(/\d+\s*(min|hour|hr)/i)) {
                const match = text.match(/(\d+)\s*(min|hour|hr)s?/i);
                if (match) {
                    duration = match[1] + (match[2].startsWith('h') ? 'h' : 'm');
                }
            }
        });

        // Extract file_size if available on quality page
        if (!fileSize) {
            $('li, span, div').each((i, el) => {
                const text = $(el).text();
                if (text.match(/(\d+(?:\.\d+)?\s*(?:GB|MB|KB))/i)) {
                    const match = text.match(/(\d+(?:\.\d+)?\s*(?:GB|MB|KB))/i);
                    if (match) fileSize = match[1].trim();
                }
            });
        }

        // Fetch the download page to get file_size, duration, and server links
        if (downloadUrl && downloadUrl.includes('/download/')) {
            try {
                const dlPageHtml = await fetchHtml(downloadUrl);
                const $dl = cheerio.load(dlPageHtml);

                // Try multiple selectors for details
                $dl('.details, .info, .movie-info, li, span').each((i, el) => {
                    const text = $(el).text();
                    if (text.includes('File Size:') || text.includes('Size:')) {
                        const match = text.match(/File Size:\s*(.+)/i) || text.match(/Size:\s*(.+)/i);
                        if (match) fileSize = match[1].trim();
                    }
                    if (text.includes('Duration:')) {
                        const match = text.match(/Duration:\s*(.+)/i);
                        if (match) duration = match[1].trim();
                    }
                });

                // Try to find duration in any text containing time info
                if (!duration) {
                    $dl('body').each((i, el) => {
                        const text = $(el).text();
                        const match = text.match(/(\d+)\s*(minutes?|mins?|hours?|hrs?)/i);
                        if (match) {
                            duration = match[1] + (match[2].startsWith('h') ? 'h' : 'm');
                        }
                    });
                }

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

                // Follow both Server 1 and Server 2 chains to get final URLs
                if (movieServer1 || movieServer2) {
                    try {
                        // Get Server 1 chain (for download_url_1 and watch_url_1)
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

                            // Follow second redirect for Server 1
                            if (dlServer1FinalUrl) {
                                const server2Html = await fetchHtml(dlServer1FinalUrl);
                                const $srv2 = cheerio.load(server2Html);

                                $srv2('.dlink a').each((i, el) => {
                                    const href = $(el).attr('href');
                                    const text = $(el).text().toLowerCase();
                                    if (text.includes('download server 1') && href && !downloadUrl) {
                                        downloadUrl = href;
                                    } else if (text.includes('watch online server 1') && href && !watchServer1Url) {
                                        watchServer1Url = href;
                                    }
                                });
                            }

                            // Get final watch stream URL for Server 1
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

                        // Get Server 2 chain (for download_url_2 and watch_url_2)
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

                            // Follow second redirect for Server 2
                            if (dlServer2FinalUrl) {
                                const server3Html = await fetchHtml(dlServer2FinalUrl);
                                const $srv3 = cheerio.load(server3Html);

                                $srv3('.dlink a').each((i, el) => {
                                    const href = $(el).attr('href');
                                    const text = $(el).text().toLowerCase();
                                    if (text.includes('download server 2') && href && !downloadServer2) {
                                        downloadServer2 = href;
                                    } else if (text.includes('watch online server 2') && href && !watchServer2Url) {
                                        watchServer2Url = href;
                                    }
                                });
                            }

                            // Get final watch stream URL for Server 2
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
                    } catch (e) {
                        console.log('Error following redirect chain:', e.message);
                    }
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
        // Get duration from first quality's download page
        const firstQualityLinks = await findQualityLinks(html, item.url);
        if (firstQualityLinks.length > 0) {
            const dl = await getDownloadLinks(firstQualityLinks[0].url);
            if (dl.duration) {
                movieDetails.duration = dl.duration;
            }
        }
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

        // Get duration from first quality's download page
        const firstQualityLinks = await findQualityLinks(html, item.url);
        if (firstQualityLinks.length > 0) {
            const dl = await getDownloadLinks(firstQualityLinks[0].url);
            if (dl.duration) {
                await supabase
                    .from('movies')
                    .update({ duration: dl.duration })
                    .eq('id', movieId);
            }
        }
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