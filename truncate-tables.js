import { supabase } from './lib/supabase.js';

async function truncate() {
    await supabase.from('media').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await supabase.from('movies').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await supabase.from('scrape_queue').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await supabase.from('refresh_status').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await supabase.from('folder_state').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    console.log('Tables truncated');
}

truncate();
