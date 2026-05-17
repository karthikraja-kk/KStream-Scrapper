import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP_ANON_KEY = Deno.env.get("APP_ANON_KEY")!;
const GITHUB_PAT = Deno.env.get("GITHUB_PAT")!;

const GITHUB_OWNER = "karthikraja-kk";
const GITHUB_REPO = "KStream-Scrapper";
const GITHUB_WORKFLOW = "scrape.yml";
const GITHUB_BRANCH = "main";

const COOLDOWN_MINUTES = 15;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey, x-client-info",
};

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ status: "error", error: "Method not allowed" }, 405);
  }

  // Verify request has valid API key
  const apikey = req.headers.get("apikey");
  if (!apikey || apikey !== APP_ANON_KEY) {
    return jsonResponse({ status: "error", error: "Unauthorized" }, 401);
  }

  try {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // 1. Check for active runs (lock check)
    const { data: activeRuns, error: lockErr } = await supabase
      .from("refresh_status")
      .select("id, status, refresh_time")
      .eq("status", "inprogress")
      .limit(1);

    if (lockErr) throw new Error(`Lock check failed: ${lockErr.message}`);

    if (activeRuns && activeRuns.length > 0) {
      return jsonResponse({
        status: "already_running",
        message: "A scan is already in progress",
        run_id: activeRuns[0].id,
      });
    }

    // 2. Check cooldown — last completed run within 15 minutes
    const cooldownThreshold = new Date(
      Date.now() - COOLDOWN_MINUTES * 60 * 1000
    ).toISOString();

    const { data: recentRuns, error: cooldownErr } = await supabase
      .from("refresh_status")
      .select("id, status, refresh_time")
      .eq("status", "completed")
      .gte("refresh_time", cooldownThreshold)
      .order("refresh_time", { ascending: false })
      .limit(1);

    if (cooldownErr) throw new Error(`Cooldown check failed: ${cooldownErr.message}`);

    if (recentRuns && recentRuns.length > 0) {
      return jsonResponse({
        status: "too_recent",
        message: `A scan completed recently. Try again after ${COOLDOWN_MINUTES} minutes.`,
        last_run: recentRuns[0].refresh_time,
      });
    }

    // 3. Trigger GitHub Actions workflow_dispatch
    const triggeredAt = new Date().toISOString();

    const ghResponse = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${GITHUB_WORKFLOW}/dispatches`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${GITHUB_PAT}`,
          Accept: "application/vnd.github.v3+json",
          "Content-Type": "application/json",
          "User-Agent": "KStream-TriggerScan",
        },
        body: JSON.stringify({
          ref: GITHUB_BRANCH,
          inputs: {
            refresh_type: "quick",
          },
        }),
      }
    );

    // GitHub returns 204 No Content on success
    if (ghResponse.status !== 204) {
      const errBody = await ghResponse.text();
      console.error("GitHub API error:", ghResponse.status, errBody);
      return jsonResponse(
        {
          status: "error",
          error: `GitHub API returned ${ghResponse.status}`,
          details: errBody,
        },
        500
      );
    }

    console.log(`Scan triggered at ${triggeredAt}`);

    return jsonResponse({
      status: "started",
      triggered_at: triggeredAt,
      message: "Quick scan triggered successfully",
    });
  } catch (err) {
    console.error("trigger-scan error:", err);
    return jsonResponse(
      { status: "error", error: (err as Error).message },
      500
    );
  }
});
