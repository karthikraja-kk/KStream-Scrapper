export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function fetchWithRetry(url, options = {}, retries = 3, delayMs = 2000) {
    const defaultHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
    };

    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, {
                ...options,
                headers: { ...defaultHeaders, ...options.headers }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            return response;
        } catch (err) {
            if (i === retries - 1) throw err;
            console.warn(`Retry ${i + 1}/${retries} for ${url}: ${err.message}`);
            await delay(delayMs);
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