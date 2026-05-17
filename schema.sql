-- Movies table
CREATE TABLE IF NOT EXISTS movies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE,
    movie_url TEXT UNIQUE NOT NULL,
    movie_name TEXT NOT NULL,
    year INTEGER,
    duration TEXT,
    synopsis TEXT,
    director TEXT[],
    cast_members TEXT[],
    genres TEXT[],
    type TEXT,
    language TEXT,
    rating TEXT,
    poster_url TEXT,
    last_updated TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Media table (multiple qualities per movie)
CREATE TABLE IF NOT EXISTS media (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    movie_id UUID REFERENCES movies(id) ON DELETE CASCADE,
    quality TEXT NOT NULL,
    file_size TEXT,
    duration TEXT,
    watch_url_1 TEXT,
    watch_url_2 TEXT,
    download_url_1 TEXT,
    download_url_2 TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(movie_id, quality)
);

-- Refresh status tracking
CREATE TABLE IF NOT EXISTS refresh_status (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    refresh_time TIMESTAMPTZ DEFAULT NOW(),
    status TEXT CHECK (status IN ('completed', 'inprogress', 'failed')),
    trigger_by TEXT
);

-- Source table (single row, always overwritten)
CREATE TABLE IF NOT EXISTS source (
    key TEXT PRIMARY KEY DEFAULT 'base_url',
    url TEXT NOT NULL
);

-- Initialize default source URL
INSERT INTO source (key, url) VALUES ('base_url', 'https://moviesda18.com')
ON CONFLICT (key) DO UPDATE SET url = EXCLUDED.url;

-- Trigger for auto-updating updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_movies_updated_at
BEFORE UPDATE ON movies
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_media_updated_at
BEFORE UPDATE ON media
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Scrape queue for pending movie URLs
CREATE TABLE IF NOT EXISTS scrape_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url TEXT UNIQUE NOT NULL,
    folder TEXT,
    status TEXT DEFAULT 'pending',
    priority INTEGER DEFAULT 2,
    error_msg TEXT,
    queued_at TIMESTAMPTZ DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

-- Folder state for tracking last known counts
CREATE TABLE IF NOT EXISTS folder_state (
    folder TEXT PRIMARY KEY,
    last_scraped_at TIMESTAMPTZ DEFAULT NOW(),
    last_known_count INTEGER DEFAULT 0
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_media_movie_id ON media(movie_id);
CREATE INDEX IF NOT EXISTS idx_movies_year ON movies(year);
CREATE INDEX IF NOT EXISTS idx_refresh_status_refresh_time ON refresh_status(refresh_time);
CREATE INDEX IF NOT EXISTS idx_refresh_status_status ON refresh_status(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_refresh_status_single_inprogress
    ON refresh_status(status)
    WHERE status = 'inprogress';
CREATE INDEX IF NOT EXISTS idx_scrape_queue_status ON scrape_queue(status);
CREATE INDEX IF NOT EXISTS idx_scrape_queue_folder ON scrape_queue(folder);
CREATE INDEX IF NOT EXISTS idx_scrape_queue_priority ON scrape_queue(priority);

-- Adhoc refresh queue for on-demand media URL refresh (expired URL recovery)
CREATE TABLE IF NOT EXISTS adhoc_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    movie_id UUID NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    movie_url TEXT NOT NULL,
    status TEXT DEFAULT 'processing'
        CHECK (status IN ('processing', 'done', 'failed')),
    fresh_media JSONB,
    error_msg TEXT,
    requested_at TIMESTAMPTZ DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '5 minutes'
);

-- Only one active (processing) request per movie at a time
CREATE UNIQUE INDEX IF NOT EXISTS idx_adhoc_active_movie
    ON adhoc_queue (movie_id)
    WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_adhoc_expires ON adhoc_queue (expires_at);
CREATE INDEX IF NOT EXISTS idx_adhoc_movie_status ON adhoc_queue (movie_id, status);

-- Staging table for movies (used during scraping, synced to production via RPC)
CREATE TABLE IF NOT EXISTS movies_stage (
    slug TEXT PRIMARY KEY,
    movie_url TEXT NOT NULL,
    movie_name TEXT NOT NULL,
    year INTEGER,
    duration TEXT,
    synopsis TEXT,
    director TEXT[],
    cast_members TEXT[],
    genres TEXT[],
    type TEXT,
    language TEXT,
    rating TEXT,
    poster_url TEXT,
    last_updated TEXT
);

-- Staging table for media (used during scraping, synced to production via RPC)
CREATE TABLE IF NOT EXISTS media_stage (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    movie_url TEXT NOT NULL,
    quality TEXT NOT NULL,
    file_size TEXT,
    download_url_1 TEXT,
    download_url_2 TEXT,
    watch_url_1 TEXT,
    watch_url_2 TEXT
);

-- RPC to sync staging tables into production (called by detail-scraper after scraping)
CREATE OR REPLACE FUNCTION sync_movies_and_media()
RETURNS void AS $$
BEGIN
    -- 1. Sync Movies (match on slug)
    INSERT INTO movies (slug, movie_url, movie_name, year, duration, synopsis, director, cast_members, genres, type, language, rating, poster_url, last_updated)
    SELECT s.slug, s.movie_url, s.movie_name, s.year, s.duration, s.synopsis, s.director, s.cast_members, s.genres, s.type, s.language, s.rating, s.poster_url, s.last_updated
    FROM movies_stage s
    ON CONFLICT (slug) DO UPDATE SET
        movie_url = EXCLUDED.movie_url,
        movie_name = COALESCE(EXCLUDED.movie_name, movies.movie_name),
        year = COALESCE(EXCLUDED.year, movies.year),
        duration = COALESCE(EXCLUDED.duration, movies.duration),
        synopsis = COALESCE(EXCLUDED.synopsis, movies.synopsis),
        director = COALESCE(EXCLUDED.director, movies.director),
        cast_members = COALESCE(EXCLUDED.cast_members, movies.cast_members),
        genres = COALESCE(EXCLUDED.genres, movies.genres),
        type = COALESCE(EXCLUDED.type, movies.type),
        language = COALESCE(EXCLUDED.language, movies.language),
        rating = COALESCE(EXCLUDED.rating, movies.rating),
        poster_url = COALESCE(EXCLUDED.poster_url, movies.poster_url),
        last_updated = COALESCE(EXCLUDED.last_updated, movies.last_updated),
        updated_at = NOW();

    -- 2. Sync Media (replace media for staged movies)
    DELETE FROM media
    WHERE movie_id IN (SELECT id FROM movies WHERE slug IN (SELECT slug FROM movies_stage));

    INSERT INTO media (movie_id, quality, file_size, watch_url_1, watch_url_2, download_url_1, download_url_2)
    SELECT m.id, ms.quality, ms.file_size, ms.watch_url_1, ms.watch_url_2, ms.download_url_1, ms.download_url_2
    FROM media_stage ms
    JOIN movies m ON ms.movie_url = m.movie_url;

    -- 3. Cleanup staging
    TRUNCATE movies_stage;
    TRUNCATE media_stage;
END;
$$ LANGUAGE plpgsql;