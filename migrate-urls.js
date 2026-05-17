/**
 * One-time migration: Convert existing full poster URLs to relative paths.
 * 
 * Before: poster_url = "https://moviesda19.com/uploads/posters/movie.webp"
 * After:  poster_url = "/uploads/posters/movie.webp"
 * 
 * Also resolves the current base URL redirect and updates the source table.
 * 
 * Usage: node migrate-urls.js
 */

import { supabase, resolveBaseUrl } from './lib/supabase.js';

async function migrateUrls() {
    console.log('=== Poster URL Migration ===\n');

    // Step 1: Resolve and update the base URL
    console.log('Step 1: Resolving current base URL...');
    const resolvedBaseUrl = await resolveBaseUrl();
    console.log(`  Resolved base URL: ${resolvedBaseUrl}\n`);

    // Step 2: Fetch all movies with full poster URLs
    console.log('Step 2: Fetching movies with full poster URLs...');
    const { data: movies, error } = await supabase
        .from('movies')
        .select('id, poster_url, movie_name')
        .not('poster_url', 'is', null);

    if (error) {
        console.error(`Failed to fetch movies: ${error.message}`);
        process.exit(1);
    }

    const moviesToMigrate = movies.filter(m => 
        m.poster_url && m.poster_url.startsWith('http')
    );

    console.log(`  Total movies: ${movies.length}`);
    console.log(`  Movies with full URLs to migrate: ${moviesToMigrate.length}\n`);

    if (moviesToMigrate.length === 0) {
        console.log('Nothing to migrate. All poster URLs are already relative.');
        return;
    }

    // Step 3: Convert to relative paths
    console.log('Step 3: Converting to relative paths...');
    let successCount = 0;
    let failCount = 0;

    for (const movie of moviesToMigrate) {
        try {
            const relativePath = new URL(movie.poster_url).pathname;
            const { error: updateError } = await supabase
                .from('movies')
                .update({ poster_url: relativePath })
                .eq('id', movie.id);

            if (updateError) {
                console.error(`  ✗ ${movie.movie_name}: ${updateError.message}`);
                failCount++;
            } else {
                successCount++;
            }
        } catch (e) {
            console.error(`  ✗ ${movie.movie_name}: Invalid URL "${movie.poster_url}"`);
            failCount++;
        }
    }

    console.log(`\n=== Migration Complete ===`);
    console.log(`  ✓ Migrated: ${successCount}`);
    console.log(`  ✗ Failed: ${failCount}`);
    console.log(`  Base URL: ${resolvedBaseUrl}`);
    console.log(`\nPoster URLs are now relative paths. The app will construct full URLs using the base URL from the source table.`);
}

migrateUrls().catch(err => {
    console.error('Migration failed:', err.message);
    process.exit(1);
});
