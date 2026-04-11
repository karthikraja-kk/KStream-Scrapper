# Flow Map - How Fields Are Extracted

## Example Movie: "Konja Naal Poru Thalaiva (2025)"

---

## STEP 1: INDEX CRAWLER

**URL**: https://moviesda18.com/tamil-2025-movies/

Discovers links matching: `-tamil-movie/` or `-tamil-web-series/`

Queued URL: `https://moviesda18.com/konja-naal-poru-thalaiva-2025-tamil-movie/`

---

## STEP 2: DETAIL SCRAPER

### 2.1 Movie Page (Detail Page)

**URL**: https://moviesda18.com/konja-naal-poru-thalaiva-2025-tamil-movie/

HTML Structure:
```html
<h1>Konja Naal Poru Thalaiva (2025) Tamil Movie</h1>

<picture>
  <source srcset="/uploads/posters/konja-naal-poru-thalaiva-2025.webp" type="image/webp">
  <source srcset="/uploads/posters/konja-naal-poru-thalaiva-2025.jpg" type="image/jpeg">
  <img src="/uploads/posters/konja-naal-poru-thalaiva-2025.jpg" alt="...">
</picture>

<ul class="movie-info">
  <li><strong>Movie:</strong> <span>Konja Naal Poru Thalaiva (2025)</span></li>
  <li><strong>Director:</strong> <span>Vignesh Pandiyan</span></li>
  <li><strong>Starring:</strong> <span>Nishanth Russo, Gayathri Shan, Mottai Rajendran</span></li>
  <li><strong>Genres:</strong> <span>Horror, Romantic</span></li>
  <li><strong>Quality:</strong> <span>Original HD</span></li>
  <li><strong>Language:</strong> <span>Tamil</span></li>
  <li><strong>Movie Rating:</strong> <span>7.1/10</span></li>
  <li><strong>Last Updated:</strong> <span>01 April 2026</span></li>
</ul>

<div class="movie-synopsis">
  <span>Synopsis:</span> A young man working in a private company...
</div>
```

### 2.2 Field Extraction Mapping

| Field | Code | Actual Value from Page |
|-------|------|-------------------|
| movie_name | $('h1').text().replace(...) | "Konja Naal Poru Thalaiva" |
| year | title.match(/\(\d{4}\)/) | 2025 |
| poster_url | $('picture img').attr('src') or $('picture source').attr('srcset') | "/uploads/posters/konja-naal-poru-thalaiva-2025.jpg" → prepend base |
| synopsis | $('.movie-synopsis').text().replace(/Synopsis:/) | "A young man working in a private company..." |
| director | iterate $('ul.movie-info li') → find 'strong' | "Vignesh Pandiyan" |
| cast_members | iterate + split(',') | ["Nishanth Russo", "Gayathri Shan", "Mottai Rajendran"] |
| genres | iterate + split(',') | ["Horror", "Romantic"] |
| type | iterate: strong.includes('Quality') | "Original HD" |
| language | iterate: strong.includes('Language') | "Tamil" |
| rating | iterate + .replace('/10','') | "7.1" |
| duration | iterate: strong.includes('Run Time') | null (may be missing) |

### 2.3 Quality Links Navigation

Movie page contains links to quality folders:
```html
<a href="/konja-naal-poru-thalaiva-original-movie/">Konja Naal Poru Thalaiva (Original)</a>
```

**Code**: $('a[href*="-movie/"]')

Finds links and maps text to quality:
- "Original" → "Original"
- "720p HD" → "720p"
- "1080p HD" → "1080p"
- "360p HD" → "360p"

---

### 2.4 Quality Page (e.g., 1080p HD)

**URL**: https://moviesda18.com/konja-naal-poru-thalaiva-1080p-hd-movie/

HTML Structure:
```html
<div class="folder">
  <div class="mv-content">
    <ul>
      <li><a href="/download/konja-naal-poru-thalaiva-2025-original-1080p-hd/" class="coral">
        Moviesda.Mobi - Konja Naal Poru Thalaiva 2025 Original 1080p HD.mp4
      </a></li>
      <li>File Size: 1.48 GB</li>
      <li>Download Format: Mp4</li>
    </ul>
  </div>
</div>
```

### 2.5 Media Table Extraction

| Field | Code | Actual Value |
|-------|------|-------------|
| quality | from folder link text | "1080p" |
| download_url_1 | $('a[href*="/download/"]').attr('href') | "/download/konja-naal-poru-thalaiva-2025-original-1080p-hd/" |
| watch_url_1 | NOT FOUND (no stream links on this page) | "" |

---

## Current Code Issues

### Issues Found:

1. **duration** - NOT EXTRACTED (missing from code)
   - Should extract from `<li><strong>Run Time:</strong> <span>2h 15m</span></li>` or similar

2. **cast_members selector** - Uses comma split but some pages may use "|" or "&"
   - Current: `.split(',')`
   - Should handle: `.split(/[,|&]/)`

3. **Director selector** - Uses `li > strong:contains("Director:") span`
   - Should be: `li strong:contains("Director:") + span` or `li:has(strong:contains("Director:")) span`

4. **watch_url_1, watch_url_2** - Not being extracted from quality pages
   - No stream URLs found on 1080p page

5. **download_url_2** - Not being extracted
   - Only extracts first download link

6. **Poster URL** - Uses `$('picture img').attr('src')` which returns the img src, not source srcset
   - Should check `<source>` elements first

---

## Complete Flow Diagram

```
CRAWLER
  │
  ├── discoverFolders() 
  │     └─> /tamil-2025-movies/, /tamil-2024-movies/, etc.
  │
  ├── discoverMoviesInFolder()
  │     └─> Finds URLs matching: /-tamil-movie/, /-tamil-web-series/
  │
  └── queueMovies()
        └─> Insert to scrape_queue table

SCRAPER
  │
  ├── getQueueItems()
  │     └─> Fetch pending items ordered by priority
  │
  ├── fetchHtml(movie_url)
  │
  ├── extractMovieDetails()
  │     ├── movie_name → $('h1').text()
  │     ├── year → title.match(/\(\d{4}\)/)
  │     ├── poster_url → $('picture img').attr('src')
  │     ├── synopsis → $('.movie-synopsis span').last().text()
  │     ├── director → $('li strong:contains("Director:") span').text()
  │     ├── cast_members → $('li strong:contains("Starring:") span').text().split(',')
  │     ├── genres → $('li strong:contains("Genres:") span').text().split(',')
  │     ├── type → $('li strong:contains("Quality:") span').text()
  │     ├── language → $('li strong:contains("Language:") span').text()
  │     ├── rating → $('li strong:contains("Movie Rating:") span').text().replace('/10','')
  │     └── duration → NOT EXTRACTED ⚠️
  │
  ├── findQualityLinks()
  │     └─> $('a[href*="-movie/"]').each() → map text to quality
  │
  ├── getDownloadLinks(quality_page_url)
  │     ├── download_url_1 → $('a[href*="download"]').attr('href')
  │     ├── download_url_2 → NOT EXTRACTED ⚠️
  │     ├── watch_url_1 → $('a[href*="stream"]').attr('href') (if exists)
  │     └── watch_url_2 → NOT EXTRACTED ⚠️
  │
  └── save to movies + media tables
```