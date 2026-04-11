-- Clear all data except source table
-- Run this in Supabase SQL Editor

TRUNCATE TABLE media, movies, scrape_queue, refresh_status, folder_state RESTART IDENTITY CASCADE;