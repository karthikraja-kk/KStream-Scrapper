import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing environment variables: SUPABASE_URL, SUPABASE_SERVICE_KEY');
    process.exit(1);
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

export async function getSourceUrl() {
    const { data, error } = await supabase
        .from('source')
        .select('url')
        .eq('key', 'base_url')
        .single();
    
    if (error) throw new Error(`Failed to get source URL: ${error.message}`);
    return data.url;
}

export async function checkRateLimit(minutes = 15) {
    const cutoff = new Date(Date.now() - minutes * 60 * 1000).toISOString();
    
    const { data, error } = await supabase
        .from('refresh_status')
        .select('refresh_time, status')
        .gte('refresh_time', cutoff)
        .eq('status', 'completed')
        .order('refresh_time', { ascending: false })
        .limit(1);
    
    if (error) {
        console.warn('Rate limit check failed, proceeding:', error.message);
        return false;
    }
    
    if (data && data.length > 0) {
        const lastRefresh = new Date(data[0].refresh_time);
        const minutesAgo = Math.floor((Date.now() - lastRefresh.getTime()) / 60000);
        console.log(`Rate limited: Last refresh ${minutesAgo} minutes ago. Skipping.`);
        return true;
    }
    
    return false;
}

export async function startRefresh(triggerBy) {
    const { error } = await supabase
        .from('refresh_status')
        .insert({
            status: 'inprogress',
            trigger_by: triggerBy
        });
    
    if (error) console.warn('Failed to log refresh start:', error.message);
    return !error;
}

export async function finishRefresh(status) {
    const { data, error } = await supabase
        .from('refresh_status')
        .select('id')
        .eq('status', 'inprogress')
        .order('refresh_time', { ascending: false })
        .limit(1)
        .single();
    
    if (error || !data) {
        console.warn('No inprogress refresh found to update');
        return;
    }
    
    await supabase
        .from('refresh_status')
        .update({ status })
        .eq('id', data.id);
}

export async function getFolderState(folderName) {
    const { data } = await supabase
        .from('folder_state')
        .select('last_known_count')
        .eq('folder', folderName)
        .single();
    
    return data;
}

export async function updateFolderState(folderName, count) {
    await supabase
        .from('folder_state')
        .upsert({
            folder: folderName,
            last_scraped_at: new Date().toISOString(),
            last_known_count: count
        }, { onConflict: 'folder' });
}