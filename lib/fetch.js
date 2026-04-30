export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Random delay between min and max (inclusive)
export const randomDelay = (min = 2000, max = 8000) => 
    delay(Math.floor(Math.random() * (max - min + 1) + min));

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0'
];

export async function fetchWithRetry(url, options = {}, retries = 3, delayMs = 3000) {
    const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    const headers = {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        ...options.headers
    };

    for (let i = 0; i < retries; i++) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 15000);
            
            const response = await fetch(url, { ...options, headers, signal: controller.signal });
            clearTimeout(timeout);
            
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response;
        } catch (err) {
            if (i === retries - 1) throw err;
            console.log(`  - Fetch failed (${err.message}), retrying...`);
            await delay(delayMs * (i + 1));
        }
    }
}

export async function fetchHtml(url, options = {}) {
    const response = await fetchWithRetry(url, options);
    return response.text();
}

export async function fetchJson(url, options = {}) {
    const response = await fetchWithRetry(url, { ...options, headers: { ...options.headers, 'Accept': 'application/json' } });
    return response.json();
}
