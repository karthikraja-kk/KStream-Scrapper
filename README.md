# KStream-Scrapper

Movie scraper for Moviesda website. Scrapes movie metadata and download/watch URLs into Supabase.

## What This Does

1. **Discovers movies** from year folders (2026, 2025, etc.)
2. **Extracts movie details**: title, year, director, cast, genres, synopsis, rating, poster
3. **Navigates quality pages**: finds download links for 720p, 1080p, etc.
4. **Saves to Supabase**: movies table + media table

## Running the Scraper

### GitHub Actions (Auto)
- Runs every 6 hours automatically
- Or manually: GitHub → Actions → Scrape → Run workflow → select "user"

### Local
```bash
# Set env vars
export SUPABASE_URL="https://xxxx.supabase.co"
export SUPABASE_SERVICE_KEY="your-service-key"

# Run
node index-crawler.js   # Discovers movies
node detail-scraper.js # Scrapes details
```

## Database Tables

### movies
| Column | Description |
|-------|------------|
| id | UUID |
| movie_url | Full URL to movie page (unique) |
| movie_name | Movie title |
| year | Release year |
| duration | Runtime |
| synopsis | Plot summary |
| director | Array of directors |
| cast_members | Array of cast |
| genres | Array of genres |
| type | Quality type (HQ PreDVD, etc.) |
| language | Tamil |
| rating | 9.3/10 → 9.3 |
| poster_url | Full poster URL |
| created_at | Timestamp |
| updated_at | Timestamp |

### media
| Column | Description |
|-------|------------|
| id | UUID |
| movie_id | FK to movies.id |
| quality | 720p, 1080p, HQ PreDVD, etc. |
| watch_url_1 | Watch online URL |
| watch_url_2 | Backup watch URL |
| download_url_1 | Download URL |
| download_url_2 | Backup download URL |
| created_at | Timestamp |
| updated_at | Timestamp |

### refresh_status
| Column | Description |
|-------|------------|
| id | UUID |
| refresh_time | When refresh started |
| status | completed, inprogress, failed |
| trigger_by | user or scheduler |

### source
| Column | Description |
|-------|------------|
| key | 'base_url' |
| url | https://moviesda18.com |

### scrape_queue (internal)
| Column | Description |
|-------|------------|
| id | UUID |
| url | Movie URL to scrape |
| folder | Year folder (2026, etc.) |
| status | pending, done, error |
| priority | 1=current year, 2=last year, 3=older |
| queued_at | Timestamp |
| processed_at | Timestamp |

## Workflow

```
index-crawler.js          detail-scraper.js
       │                      │
       ▼                      ▼
discoverFolders()    ───►  getQueueItems()
       │                      │
       ▼                      ▼
discoverMovies()    ────►  extractMovieDetails()
       │                      │ (title, director, synopsis, rating)
       ▼                      ▼
queueMovies()      ─────►  findQualityLinks()
       │                      │ (720p, 1080p pages)
       ▼                      ▼
                       getDownloadLinks()
                       (final URLs)
       │                      │
       ▼                      ▼
                  save to movies + media
                           │
                           ▼
                    finishRefresh('completed')
```

## Troubleshooting

### No movies in database after run
- Check GitHub Actions logs for errors
- Verify SUPABASE_URL and SUPABASE_SERVICE_KEY secrets

### Partial data (movies but no media)
- Quality navigation may have failed
- Check selectors in detail-scraper.js

### Rate limited
- 15-min cooldown between runs
- Check refresh_status table

## Files

```
KStream-Scrapper/
├── schema.sql           # Database schema
├── index-crawler.js     # Discovers & queues movies
├── detail-scraper.js  # Scrapes details + URLs
├── lib/
│   ├── supabase.js   # Supabase client + helpers
│   └── fetch.js    # HTTP fetcher with retry
├── .github/
│   └── workflows/
│       └── scrape.yml
└── README.md
```

## Key Decisions Made

1. **Two-step scraping**: index-crawler finds URLs, detail-scraper processes them. This allows batching and pausing to avoid rate limits.

2. **Queue-based**: movies are queued with priority (newest first). This ensures latest movies are scraped first.

3. **Auto-clean queue**: old queue items are deleted before each crawl starts.

4. **Full URL storage**: storing absolute URLs in queue, not relative paths.

5. **Status after detail-scraper**: refresh_status is marked "completed" only AFTER detail-scraper finishes, not after index-crawler.

## For Future Development

- Add pagination support for folders with many pages
- Add streaming URL resolution (currently only downloads)
- Add proxy support to avoid IP blocks
- Consider adding web series support (currently includes -tamil-web-series)