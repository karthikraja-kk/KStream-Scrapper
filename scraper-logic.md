# Scraper Logic Documentation

## Overview

This scraper has two main components:

1. **Index Crawler** (`index-crawler.js`) - Discovers movie URLs from year folders and adds them to the queue
2. **Detail Scraper** (`detail-scraper.js`) - Scrapes each movie's details and media links

---

## Index Crawler Flow

```
1. Get base URL from source table in database
2. Fetch home page
3. Discover year folders (e.g., /tamil-2026-movies/, /tamil-2025-movies/)
4. For each year folder:
   a. Fetch the folder page
   b. Discover movie URLs (links matching /-tamil-movie/ or /-tamil-web-series/)
   c. Add movies to scrape_queue table with status='pending'
5. Mark refresh as completed
```

### Queue Priority
- Year 2026: priority 1 (highest)
- Year 2025: priority 2
- All other years: priority 3

---

## Detail Scraper Flow

```
1. Get pending items from scrape_queue
2. For each item:
   a. Fetch movie page → extractMovieDetails()
   b. Find quality links → findQualityLinks()
   c. For each quality link:
      - Fetch quality page → getDownloadLinks()
      - Insert into media table
3. Update queue item status to 'done'
```

---

## Movie Details Extraction

Function: `extractMovieDetails(html, url)`

The movie page URL format: `https://moviesda18.com/{movie-name}-2025-tamil-movie/`

### Extracted Fields

| Field | Source | Example |
|-------|--------|---------|
| movie_url | Input URL | https://moviesda18.com/naangal-2025-tamil-movie/ |
| movie_name | H1 title | "Naangal (2025) Tamil Movie" → "Naangal" |
| year | Title match ((\d{4})) | 2025 |
| duration | li with "Run Time" or "Duration" span | "2h 30m" or null |
| synopsis | .movie-synopsis text | "Synopsis: ..." |
| director | li with "Director" span | ["Avinash Prakash"] |
| cast_members | li with "Starring" span | ["Abdul Rafe", "Mithun Vasudevan"] |
| genres | li with "Genres" span | ["Drama"] |
| type | li with "Quality" span | "Original HD" |
| language | li with "Language" span | "Tamil" |
| rating | li with "Movie Rating" span | "8.9" |
| poster_url | picture img src | https://.../uploads/...jpg |

---

## Quality Links Extraction

Function: `findQualityLinks(html, baseUrl)`

The scraper needs to find multiple quality options (1080p, 720p, 360p, etc.) from the movie page.

### Flow

```
1. Check movie page for quality links directly (a[href*="-movie/"])
2. If none found, check for "(Original)" link
3. Fetch Original page
4. Find quality links on Original page
```

### Quality Detection Logic

| Link Text Contains | Quality Value |
|-----------------|---------------|
| "1080p" | "1080p" |
| "720p" | "720p" |
| "480p" | "480p" |
| "360p" | "360p" |
| "hd" | "720p" |
| (other) | "Unknown" |

### Example URLs

```
Movie page: https://moviesda18.com/naangal-2025-tamil-movie/
  ↓ (click "Vadam (Original)")
Original page: https://moviesda18.com/naangal-original-movie/
  ↓ (click quality links)
  - /naangal-1080p-hd-movie/ → quality: "1080p"
  - /naangal-720p-hd-movie/ → quality: "720p"
  - /naangal-360p-hd-movie/ → quality: "360p"
```

---

## Download Links Extraction (Most Complex)

Function: `getDownloadLinks(qualityPageUrl)`

This is the core function that follows the redirect chain to get final download and watch URLs.

### Complete Flow Diagram

```
Quality page (e.g., /naangal-1080p-hd-movie/)
    ↓ (click movie link, e.g., /download/naangal-2025-original-1080p-hd/)
Download details page
    ├─ File Size: 3.33 GB (from .details or JSON-LD)
    ├─ Duration: 2h30m29s (from JSON-LD "duration": "PT2H30M29S")
    ├─ Download Server 1 → /download/file/97927
    └─ Download Server 2 → /download/file/97927
            ↓
    Server 1 page (download.moviespage.xyz/download/file/97927)
            ├─ Download Server 1 → /download/page/97927
            └─ Watch Online Server 1 → /stream/page/97927
                    ↓
    Server 1 redirect page (movies.downloadpage.xyz/download/page/97927)
            ├─ Download Server 1 → https://s33.cdnserver04.xyz/Moviesda.Mobi_...mp4  (FINAL download_url_1)
            └─ Watch Online Server 1 → https://play.onestream.today/stream/page/97927
                    ↓
    Watch page (play.onestream.today/stream/page/97927)
            └─ <source src="https://s13.cdnserver02.xyz/...mp4?stream=1">  (FINAL watch_url_1)
```

### Same chain is followed for Server 2 to get:
- `download_url_2` - different CDN URL
- `watch_url_2` - different CDN URL

### Extracted Fields

| Field | Description | Source |
|------|-------------|--------|
| download_url_1 | Direct file URL from Server 1 chain | `.mp4` link |
| download_url_2 | Direct file URL from Server 2 chain | `.mp4` link |
| watch_url_1 | Stream URL from Server 1 chain | `source[src]` |
| watch_url_2 | Stream URL from Server 2 chain | `source[src]` |
| file_size | File size from details | "File Size: 3.33 GB" |
| duration | Duration from JSON-LD | "PT2H30M29S" → "2h30m29s" |

### Code Flow (Server 1 Chain)

```javascript
// 1. Get initial server links from download page
$dl('.dlink a').each((i, el) => {
    if (text.includes('server 1')) movieServer1 = href;
});

// 2. Fetch server 1 page
const server1Html = await fetchHtml(movieServer1);

// 3. Get second redirect link
$srv1('.dlink a').each((i, el) => {
    if (text.includes('download server 1')) dlServer1FinalUrl = href;
});

// 4. Follow second redirect to get final download URL
const server2Html = await fetchHtml(dlServer1FinalUrl);
$srv2('.dlink a').each((i, el) => {
    if (text.includes('download server 1')) downloadUrl = href; // .mp4 file
});

// 5. Get watch URL
$srv1('.dlink a').each((i, el) => {
    if (text.includes('watch online server 1')) watchServer1Url = href;
});

// 6. Fetch watch page to get stream URL
const watch1Html = await fetchHtml(watchServer1Url);
$watch1('source[src]').each((i, el) => {
    watchUrl = $(el).attr('src'); // stream URL
});
```

### Same process for Server 2 chain to get:
- `download_url_2` and `watch_url_2`

---

## Database Schema

### movies Table

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| movie_url | text | Source URL |
| movie_name | text | Movie title |
| year | integer | Release year |
| duration | text | Runtime (e.g., "2h 30m") |
| synopsis | text | Plot summary |
| director | jsonb | Array of directors |
| cast_members | jsonb | Array of cast |
| genres | jsonb | Array of genres |
| type | text | Quality type |
| language | text | Language |
| rating | text | Rating |
| poster_url | text | Poster image |
| created_at | timestamp | |
| updated_at | timestamp | |

### media Table

| Column | Type | Description |
|--------|------|-------------|
| id | uuid | Primary key |
| movie_id | uuid | Foreign key to movies |
| quality | text | "1080p", "720p", "360p", "Unknown" |
| file_size | text | "3.33 GB", etc. |
| duration | text | "2h30m29s", etc. |
| download_url_1 | text | Direct download link |
| download_url_2 | text | Backup download link |
| watch_url_1 | text | Streaming link |
| watch_url_2 | text | Backup streaming link |
| created_at | timestamp | |

---

## Important Notes

1. **Duration**: Movie page doesn't have runtime. It's extracted from the download page's JSON-LD (`"duration": "PT2H30M29S"`)

2. **File Size**: Available on download details page with multiple quality options

3. **Server Redirection**: The download chain has 3 levels:
   - Level 1: Download page → Server 1/Server 2 links
   - Level 2: Server redirect page → Another Server 1/Server 2
   - Level 3: Final page → Direct file URLs (.mp4)

4. **Different URLs**: Server 1 and Server 2 provide different CDN URLs, both should be captured for redundancy

5. **Watch URLs**: Come from "Watch Online Server" links, need to fetch the watch page to get `source[src]`

---

## Testing

To test the scraper manually:

```javascript
// Test quality links
const movieUrl = 'https://moviesda18.com/naangal-2025-tamil-movie/';
// ... fetch and parse quality links ...

// Test download links for a quality
const qualityUrl = 'https://moviesda18.com/naangal-1080p-hd-movie/';
// ... getDownloadLinks(qualityUrl) returns:
{
  download_url_1: 'https://s33.cdnserver04.xyz/Moviesda.Mobi_...mp4',
  download_url_2: 'https://s13.cdnserver02.xyz/Moviesda.Mobi_...mp4',
  watch_url_1: 'https://s13.cdnserver02.xyz/...mp4?stream=1',
  watch_url_2: 'https://s35.cdnserver04.xyz/...mp4?stream=1',
  file_size: '3.33 GB',
  duration: '2h30m29s'
}
```