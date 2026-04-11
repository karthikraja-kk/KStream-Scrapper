-- Movies table
CREATE TABLE IF NOT EXISTS movies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
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
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Media table (multiple qualities per movie)
CREATE TABLE IF NOT EXISTS media (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    movie_id UUID REFERENCES movies(id) ON DELETE CASCADE,
    quality TEXT NOT NULL,
    file_size TEXT,
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
    trigger_by TEXT CHECK (trigger_by IN ('user', 'scheduler'))
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
CREATE INDEX IF NOT EXISTS idx_scrape_queue_status ON scrape_queue(status);
CREATE INDEX IF NOT EXISTS idx_scrape_queue_folder ON scrape_queue(folder);
CREATE INDEX IF NOT EXISTS idx_scrape_queue_priority ON scrape_queue(priority);