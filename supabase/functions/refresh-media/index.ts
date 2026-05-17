import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as cheerio from "https://esm.sh/cheerio@1.0.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_ANON_KEY = Deno.env.get("APP_ANON_KEY")!;

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
];

function randomUA(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

async function fetchHtml(url: string, retries = 3): Promise<string> {
  for (let i = 0; i < retries; i++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const res = await fetch(url, {
        headers: {
          "User-Agent": randomUA(),
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        signal: controller.signal,
        redirect: "follow",
      });
      clearTimeout(timeout);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
    }
  }
  throw new Error("fetchHtml: unreachable");
}

function parseSize(text: string): number {
  const match = text.match(/File Size:\s*([\d.]+)\s*(MB|GB)/i);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  return match[2].toUpperCase() === "GB" ? value * 1024 : value;
}

interface MediaLinks {
  download1: string | null;
  stream1: string | null;
  download2: string | null;
  stream2: string | null;
  duration: string | null;
  size: string | null;
}

async function extractFinalLinks(qualityPageUrl: string): Promise<MediaLinks> {
  const empty: MediaLinks = { download1: null, stream1: null, download2: null, stream2: null, duration: null, size: null };
  try {
    const html = await fetchHtml(qualityPageUrl);
    const $ = cheerio.load(html);
    let largestPage: string | null = null;
    let maxMB = -1;

    $("div.folder").each((_i: number, el: cheerio.Element) => {
      const link = $(el).find('a[href*="/download/"]').first();
      let sizeMB = 0;
      $(el).find("li").each((_j: number, li: cheerio.Element) => {
        if ($(li).text().includes("File Size:")) sizeMB = parseSize($(li).text());
      });
      const href = link.attr("href");
      if (href && sizeMB > maxMB) {
        maxMB = sizeMB;
        largestPage = new URL(href, qualityPageUrl).toString();
      }
    });

    if (!largestPage) return empty;

    const html1 = await fetchHtml(largestPage);
    const $1 = cheerio.load(html1);
    let duration: string | null = null;
    $1(".details, li, div").each((_i: number, el: cheerio.Element) => {
      const text = $1(el).text();
      if (text.includes("Duration:")) {
        const m = text.match(/Duration:\s*(.+)/i);
        if (m) duration = m[1].trim();
      }
    });

    async function followChain(serverNum: number): Promise<{ dl: string | null; watch: string | null }> {
      try {
        const srvNode = $1(`.dlink a:contains("Server ${serverNum}")`);
        if (srvNode.length === 0) return { dl: null, watch: null };

        const srvUrl = new URL(srvNode.attr("href")!, largestPage!).toString();
        const html2 = await fetchHtml(srvUrl);
        const $2 = cheerio.load(html2);
        const finalNode = $2(`.dlink a:contains("Download Server ${serverNum}")`);
        if (finalNode.length === 0) return { dl: null, watch: null };

        const finalUrl = new URL(finalNode.attr("href")!, srvUrl).toString();
        const html3 = await fetchHtml(finalUrl);
        const $3 = cheerio.load(html3);

        const dl = $3(`.dlink a:contains("Download Server ${serverNum}")`).attr("href") || null;
        let watch: string | null = null;
        const watchNode = $3(`.dlink a:contains("Watch Online Server ${serverNum}")`);
        if (watchNode.length > 0) {
          const wHtml = await fetchHtml(new URL(watchNode.attr("href")!, finalUrl).toString());
          const $w = cheerio.load(wHtml);
          watch = $w("source").attr("src") || $w("video").attr("src") || null;
        }
        return { dl, watch };
      } catch {
        return { dl: null, watch: null };
      }
    }

    const s1 = await followChain(1);
    const s2 = await followChain(2);
    return {
      download1: s1.dl,
      stream1: s1.watch,
      download2: s2.dl,
      stream2: s2.watch,
      duration,
      size: maxMB > 0 ? `${maxMB.toFixed(2)} MB` : null,
    };
  } catch {
    return empty;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey",
      },
    });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  // Verify request has valid API key
  const apikey = req.headers.get("apikey");
  if (!apikey || apikey !== APP_ANON_KEY) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json",
      },
    });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    const { movie_id } = await req.json();
    if (!movie_id) {
      return new Response(JSON.stringify({ error: "movie_id is required" }), { status: 400 });
    }

    // 1. Get movie info
    const { data: movie, error: movieErr } = await supabase
      .from("movies")
      .select("id, slug, movie_url")
      .eq("id", movie_id)
      .single();

    if (movieErr || !movie) {
      return new Response(JSON.stringify({ error: "Movie not found" }), { status: 404 });
    }

    // 2. Dedup: check for recently completed refresh (within 5 minutes)
    const { data: recentDone } = await supabase
      .from("adhoc_queue")
      .select("fresh_media, completed_at")
      .eq("movie_id", movie_id)
      .eq("status", "done")
      .gte("completed_at", new Date(Date.now() - 5 * 60 * 1000).toISOString())
      .order("completed_at", { ascending: false })
      .limit(1);

    if (recentDone && recentDone.length > 0 && recentDone[0].fresh_media) {
      return new Response(JSON.stringify({
        status: "cached",
        media: recentDone[0].fresh_media,
      }), { headers: { "Content-Type": "application/json" } });
    }

    // 3. Dedup: try to insert a processing row (partial unique index prevents duplicates)
    const { data: inserted, error: insertErr } = await supabase
      .from("adhoc_queue")
      .insert({
        movie_id: movie.id,
        slug: movie.slug,
        movie_url: movie.movie_url,
        status: "processing",
      })
      .select("id")
      .single();

    if (insertErr) {
      // Another request is already processing this movie — poll for result
      for (let attempt = 0; attempt < 30; attempt++) {
        await delay(2000);
        const { data: check } = await supabase
          .from("adhoc_queue")
          .select("status, fresh_media, error_msg")
          .eq("movie_id", movie_id)
          .in("status", ["processing", "done", "failed"])
          .order("requested_at", { ascending: false })
          .limit(1)
          .single();

        if (check?.status === "done" && check.fresh_media) {
          return new Response(JSON.stringify({
            status: "done",
            media: check.fresh_media,
          }), { headers: { "Content-Type": "application/json" } });
        }
        if (check?.status === "failed") {
          return new Response(JSON.stringify({
            status: "failed",
            error: check.error_msg || "Refresh failed",
          }), { status: 502 });
        }
      }
      return new Response(JSON.stringify({ error: "Timeout waiting for refresh" }), { status: 504 });
    }

    // 4. We own this request — scrape the movie
    const queueId = inserted.id;

    try {
      const html = await fetchHtml(movie.movie_url);
      const $ = cheerio.load(html);

      // Find quality folders
      let qUrl: string | null = null;
      $("div.f").each((_i: number, el: cheerio.Element) => {
        if ($(el).find('img[src*="folder.svg"]').length > 0) {
          const href = $(el).find("a").first().attr("href");
          if (href) {
            qUrl = new URL(href, movie.movie_url).toString();
            return false; // break
          }
        }
      });

      const qualities: { label: string; url: string }[] = [];
      if (qUrl) {
        const qHtml = await fetchHtml(qUrl);
        const $q = cheerio.load(qHtml);
        $q("div.f").each((_i: number, el: cheerio.Element) => {
          if ($q(el).find('img[src*="folder.svg"]').length > 0) {
            const name = $q(el).find("a").text().trim();
            const match = name.match(/\(([^)]+)\)/);
            const href = $q(el).find("a").attr("href");
            if (match && href) {
              qualities.push({ label: match[1], url: new URL(href, qUrl!).toString() });
            }
          }
        });
      }

      if (qualities.length === 0) {
        await supabase.from("adhoc_queue").update({
          status: "failed",
          error_msg: "No quality links found",
          completed_at: new Date().toISOString(),
        }).eq("id", queueId);

        return new Response(JSON.stringify({ status: "failed", error: "No quality links found" }), { status: 502 });
      }

      // Extract media links for each quality
      const freshMedia: Record<string, unknown>[] = [];
      for (const q of qualities) {
        const links = await extractFinalLinks(q.url);
        freshMedia.push({
          quality: q.label,
          file_size: links.size,
          download_url_1: links.download1,
          download_url_2: links.download2,
          watch_url_1: links.stream1,
          watch_url_2: links.stream2,
        });
      }

      // 5. Update media table directly (bypass staging)
      for (const m of freshMedia) {
        await supabase.from("media").update({
          download_url_1: m.download_url_1,
          download_url_2: m.download_url_2,
          watch_url_1: m.watch_url_1,
          watch_url_2: m.watch_url_2,
          file_size: m.file_size,
        }).eq("movie_id", movie_id).eq("quality", m.quality);
      }

      // 6. Mark done with cached result
      await supabase.from("adhoc_queue").update({
        status: "done",
        fresh_media: freshMedia,
        completed_at: new Date().toISOString(),
      }).eq("id", queueId);

      return new Response(JSON.stringify({
        status: "done",
        media: freshMedia,
      }), { headers: { "Content-Type": "application/json" } });

    } catch (scrapeErr) {
      const errMsg = scrapeErr instanceof Error ? scrapeErr.message : "Unknown scrape error";
      await supabase.from("adhoc_queue").update({
        status: "failed",
        error_msg: errMsg,
        completed_at: new Date().toISOString(),
      }).eq("id", queueId);

      return new Response(JSON.stringify({ status: "failed", error: errMsg }), { status: 502 });
    }

  } catch (err) {
    const msg = err instanceof Error ? err.message : "Internal error";
    return new Response(JSON.stringify({ error: msg }), { status: 500 });
  }
});
