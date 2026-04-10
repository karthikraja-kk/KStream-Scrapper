-- Create movies table
CREATE TABLE IF NOT EXISTS movies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url TEXT UNIQUE NOT NULL,
    title TEXT,
    year INTEGER,
    genre TEXT[], -- Array of strings
    poster_url TEXT,
    stream_url TEXT,
    folder TEXT,
    scraped_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create scrape_queue table
CREATE TABLE IF NOT EXISTS scrape_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    url TEXT UNIQUE NOT NULL,
    folder TEXT,
    status TEXT DEFAULT 'pending', -- pending, done, error
    priority INTEGER DEFAULT 2,    -- 1 is high priority
    error_msg TEXT,
    queued_at TIMESTAMPTZ DEFAULT NOW(),
    processed_at TIMESTAMPTZ
);

-- Create folder_state table
CREATE TABLE IF NOT EXISTS folder_state (
    folder TEXT PRIMARY KEY,
    last_scraped_at TIMESTAMPTZ DEFAULT NOW(),
    last_known_count INTEGER DEFAULT 0
);

-- Trigger for auto-updating updated_at on movies table
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_movies_updated_at
BEFORE UPDATE ON movies
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
