require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

const YOUTUBE_CHANNEL_USERNAME = process.env.YOUTUBE_CHANNEL_USERNAME;
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_INSTAGRAM_DATASET = process.env.APIFY_INSTAGRAM_DATASET;
const APIFY_FACEBOOK_DATASET = process.env.APIFY_FACEBOOK_DATASET;
const TIKTOK_ACCESS_TOKEN = process.env.TIKTOK_ACCESS_TOKEN;
const TIKTOK_ADVERTISER_ID = process.env.TIKTOK_ADVERTISER_ID;
const PORT = process.env.PORT || 3000;

async function apifyUrl(datasetId) {
    return `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}`;
}

app.get("/api/instagram", async (req, res) => {
    try {
        const url = await apifyUrl(APIFY_INSTAGRAM_DATASET);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Apify Instagram error: ${response.status}`);
        const data = await response.json();
        if (!Array.isArray(data)) return res.json([]);

        const posts = data.map((p) => {
            const caption = (p.caption || "").trim();
            const hook = caption.length > 80 ? caption.substring(0, 77) + "..." : caption;
            const views =
                parseInt(p.videoViewCount, 10) || parseInt(p.videoPlayCount, 10) || 0;
            return {
                hook,
                postedDate: p.timestamp || "",
                url: p.url || "",
                views,
                likes: parseInt(p.likesCount, 10) || 0,
                comments: parseInt(p.commentsCount, 10) || 0,
                saves: 0,
                shares: 0,
            };
        });

        res.json(posts);
    } catch (err) {
        console.error("Instagram fetch error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/facebook", async (req, res) => {
    try {
        const url = await apifyUrl(APIFY_FACEBOOK_DATASET);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Apify Facebook error: ${response.status}`);
        const data = await response.json();
        if (!Array.isArray(data)) return res.json([]);

        const posts = data
            .filter((p) => p.isVideo)
            .map((p) => {
                const text = (p.text || "").trim();
                const hook = text.length > 80 ? text.substring(0, 77) + "..." : text;
                return {
                    hook,
                    postedDate: p.time || "",
                    url: p.url || p.topLevelUrl || "",
                    views: parseInt(p.viewsCount, 10) || 0,
                    likes: parseInt(p.likes, 10) || 0,
                    comments: 0,
                    shares: parseInt(p.shares, 10) || 0,
                    saves: 0,
                };
            });

        res.json(posts);
    } catch (err) {
        console.error("Facebook fetch error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/tiktok", async (req, res) => {
    if (!TIKTOK_ACCESS_TOKEN || !TIKTOK_ADVERTISER_ID) {
        return res.status(500).json({ error: "TIKTOK_ACCESS_TOKEN or TIKTOK_ADVERTISER_ID not set in .env" });
    }

    try {
        const today = new Date();
        const endDate = today.toISOString().slice(0, 10);
        const startDate = new Date(today - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

        const params = new URLSearchParams({
            advertiser_id: TIKTOK_ADVERTISER_ID,
            report_type: "BASIC",
            data_level: "AUCTION_AD",
            dimensions: JSON.stringify(["ad_id", "stat_time_day"]),
            metrics: JSON.stringify([
                "ad_name",
                "spend",
                "impressions",
                "video_play_actions",
                "likes",
                "comments",
                "shares",
                "follows",
            ]),
            start_date: startDate,
            end_date: endDate,
            page: 1,
            page_size: 50,
        });

        const response = await fetch(
            `https://business-api.tiktok.com/open_api/v1.3/report/integrated/get/?${params.toString()}`,
            {
                method: "GET",
                headers: {
                    "Access-Token": TIKTOK_ACCESS_TOKEN,
                    "Content-Type": "application/json",
                },
            }
        );

        const json = await response.json();
        console.log(JSON.stringify(json));
        console.log("TikTok API raw response code:", json.code, json.message);

        if (json.code !== 0) {
            throw new Error(`TikTok API error ${json.code}: ${json.message}`);
        }

        const rows = (json.data && json.data.list) || [];

        const posts = rows.map((row) => {
            const m = row.metrics || {};
            const d = row.dimensions || {};
            const adName = (m.ad_name || d.ad_id || "TikTok Ad").trim();
            const hook = adName.length > 80 ? adName.substring(0, 77) + "..." : adName;
            return {
                hook,
                // stat_time_day comes as "2026-01-20 00:00:00" — replace space with T to make it valid ISO 8601
                postedDate: d.stat_time_day ? d.stat_time_day.trim().replace(" ", "T") : "",
                url: "",
                views: parseInt(m.video_play_actions, 10) || 0,
                likes: parseInt(m.likes, 10) || 0,
                comments: parseInt(m.comments, 10) || 0,
                saves: 0,
                shares: parseInt(m.shares, 10) || 0,
                spend: parseFloat(m.spend) || 0,
                impressions: parseInt(m.impressions, 10) || 0,
                follows: parseInt(m.follows, 10) || 0,
            };
        });

        res.json(posts);
    } catch (err) {
        console.error("TikTok Business API error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get("/api/youtube", async (req, res) => {
    if (!YOUTUBE_API_KEY) {
        return res.status(500).json({ error: "YOUTUBE_API_KEY not set in .env" });
    }

    try {
        let uploadsId = null;

        const channelRes = await fetch(
            `https://www.googleapis.com/youtube/v3/channels?part=contentDetails,snippet&forUsername=${encodeURIComponent(YOUTUBE_CHANNEL_USERNAME)}&key=${encodeURIComponent(YOUTUBE_API_KEY)}`
        );
        const channelJson = await channelRes.json();
        if (channelJson.error) throw new Error(channelJson.error.message || "Channel request failed");

        const items = channelJson.items || [];
        if (items.length > 0) {
            uploadsId = items[0].contentDetails.relatedPlaylists.uploads;
        } else {
            const searchRes = await fetch(
                `https://www.googleapis.com/youtube/v3/search?part=snippet&type=channel&q=${encodeURIComponent(YOUTUBE_CHANNEL_USERNAME)}&maxResults=5&key=${encodeURIComponent(YOUTUBE_API_KEY)}`
            );
            const searchJson = await searchRes.json();
            if (searchJson.error) throw new Error(searchJson.error.message || "Search failed");

            const searchItems = searchJson.items || [];
            let channelId = null;
            for (const s of searchItems) {
                if (s.snippet && s.snippet.channelId) {
                    channelId = s.snippet.channelId;
                    break;
                }
            }
            if (!channelId) throw new Error("Channel not found: " + YOUTUBE_CHANNEL_USERNAME);

            const channelByIdRes = await fetch(
                `https://www.googleapis.com/youtube/v3/channels?part=contentDetails&id=${encodeURIComponent(channelId)}&key=${encodeURIComponent(YOUTUBE_API_KEY)}`
            );
            const channelByIdJson = await channelByIdRes.json();
            if (channelByIdJson.error || !channelByIdJson.items || channelByIdJson.items.length === 0)
                throw new Error("Channel not found: " + YOUTUBE_CHANNEL_USERNAME);

            uploadsId = channelByIdJson.items[0].contentDetails.relatedPlaylists.uploads;
        }

        const playlistRes = await fetch(
            `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet,contentDetails&maxResults=50&playlistId=${encodeURIComponent(uploadsId)}&key=${encodeURIComponent(YOUTUBE_API_KEY)}`
        );
        const playlistJson = await playlistRes.json();
        if (playlistJson.error) throw new Error(playlistJson.error.message || "Playlist request failed");

        const playlistItems = playlistJson.items || [];
        const videoIds = playlistItems
            .map((i) =>
                (i.contentDetails && i.contentDetails.videoId) ||
                (i.snippet && i.snippet.resourceId && i.snippet.resourceId.videoId) ||
                ""
            )
            .filter(Boolean);

        if (videoIds.length === 0) return res.json([]);

        const videos = [];
        for (let i = 0; i < videoIds.length; i += 50) {
            const batch = videoIds.slice(i, i + 50);
            const videosRes = await fetch(
                `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${batch.join(",")}&key=${encodeURIComponent(YOUTUBE_API_KEY)}`
            );
            const videosJson = await videosRes.json();
            if (videosJson.error) throw new Error(videosJson.error.message || "Videos request failed");

            for (const v of videosJson.items || []) {
                const sn = v.snippet || {};
                const stat = v.statistics || {};
                videos.push({
                    videoId: v.id,
                    title: sn.title || "Untitled",
                    publishedAt: sn.publishedAt || "",
                    viewCount: parseInt(stat.viewCount, 10) || 0,
                    likeCount: parseInt(stat.likeCount, 10) || 0,
                    commentCount: parseInt(stat.commentCount, 10) || 0,
                });
            }
        }

        res.json(videos);
    } catch (err) {
        console.error("YouTube fetch error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

// ─── /api/all ────────────────────────────────────────────────────────────────
// Fetches all 4 platforms in parallel, merges them by date, and returns a
// single liveContent[] array that the frontend can render directly.
// The frontend calls ONLY this endpoint — no merging logic needed in the HTML.
app.get("/api/all", async (req, res) => {
    try {
        // Fetch all 4 platforms at the same time
        const [ytRes, igRes, fbRes, ttRes] = await Promise.allSettled([
            fetch(`http://localhost:${PORT}/api/youtube`).then((r) => r.json()),
            fetch(`http://localhost:${PORT}/api/instagram`).then((r) => r.json()),
            fetch(`http://localhost:${PORT}/api/facebook`).then((r) => r.json()),
            fetch(`http://localhost:${PORT}/api/tiktok`).then((r) => r.json()),
        ]);

        const youtubeVideos = ytRes.status === "fulfilled" && Array.isArray(ytRes.value) ? ytRes.value : [];
        const instagramPosts = igRes.status === "fulfilled" && Array.isArray(igRes.value) ? igRes.value : [];
        const facebookPosts = fbRes.status === "fulfilled" && Array.isArray(fbRes.value) ? fbRes.value : [];
        const tiktokPosts = ttRes.status === "fulfilled" && Array.isArray(ttRes.value) ? ttRes.value : [];

        // ── buildLiveContent (server-side) ───────────────────────────────────────
        // Groups posts from all platforms by date, then creates one row per day.
        function dateKey(s) {
            if (!s) return null;
            const d = new Date(s);
            if (isNaN(d.getTime())) return null;
            return (
                d.getFullYear() +
                "-" +
                String(d.getMonth() + 1).padStart(2, "0") +
                "-" +
                String(d.getDate()).padStart(2, "0")
            );
        }

        const byDate = {};
        const addToDate = (key, platform, item) => {
            if (!key) return;
            if (!byDate[key]) byDate[key] = { yt: [], ig: [], fb: [], tt: [] };
            byDate[key][platform].push(item);
        };

        youtubeVideos.forEach((v) => addToDate(dateKey(v.publishedAt), "yt", v));
        instagramPosts.forEach((p) => addToDate(dateKey(p.postedDate), "ig", p));
        facebookPosts.forEach((p) => addToDate(dateKey(p.postedDate), "fb", p));
        tiktokPosts.forEach((p) => addToDate(dateKey(p.postedDate), "tt", p));

        const sortedDates = Object.keys(byDate).sort((a, b) => b.localeCompare(a));
        const liveContent = [];

        sortedDates.forEach((k) => {
            const day = byDate[k];
            const numRows = Math.max(day.yt.length, day.ig.length, day.fb.length, day.tt.length, 1);

            for (let i = 0; i < numRows; i++) {
                const y = day.yt[i] || null;
                const insta = day.ig[i] || null;
                const face = day.fb[i] || null;
                const tik = day.tt[i] || null;

                const viewsYt = y ? parseInt(y.viewCount, 10) || 0 : 0;
                const viewsIg = insta ? insta.views || 0 : 0;
                const viewsFb = face ? face.views || 0 : 0;
                const viewsTt = tik ? tik.views || 0 : 0;

                const likes = (y ? parseInt(y.likeCount, 10) || 0 : 0) + (insta ? insta.likes || 0 : 0) + (face ? face.likes || 0 : 0) + (tik ? tik.likes || 0 : 0);
                const comments = (y ? parseInt(y.commentCount, 10) || 0 : 0) + (insta ? insta.comments || 0 : 0) + (face ? face.comments || 0 : 0) + (tik ? tik.comments || 0 : 0);
                const saves = (insta ? insta.saves || 0 : 0) + (tik ? tik.saves || 0 : 0);
                const shares = (face ? face.shares || 0 : 0) + (tik ? tik.shares || 0 : 0);

                const hook = (y && y.title) || (insta && insta.hook) || (face && face.hook) || (tik && tik.hook) || "Content";
                const postedDate = (y && y.publishedAt) || (insta && insta.postedDate) || (face && face.postedDate) || (tik && tik.postedDate) || k;
                const url = (y && "https://www.youtube.com/watch?v=" + (y.videoId || "")) || (insta && insta.url) || (face && face.url) || (tik && tik.url) || "#";

                liveContent.push({ postedDate, hook, url, views: { ig: viewsIg, fb: viewsFb, tt: viewsTt, yt: viewsYt }, likes, comments, saves, shares });
            }
        });

        res.json(liveContent);
    } catch (err) {
        console.error("/api/all error:", err.message);
        res.status(500).json({ error: err.message });
    }
});

const server = app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`   Dashboard → http://localhost:${PORT}`);
    console.log(`   YouTube   → http://localhost:${PORT}/api/youtube`);
    console.log(`   Instagram → http://localhost:${PORT}/api/instagram`);
    console.log(`   Facebook  → http://localhost:${PORT}/api/facebook`);
    console.log(`   TikTok    → http://localhost:${PORT}/api/tiktok`);
});

// If port is already in use, show a clear message instead of crashing
server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
        console.error(`\n❌ Port ${PORT} is already in use.`);
        console.error(`   Run this to free it: Stop-Process -Id (Get-NetTCPConnection -LocalPort ${PORT} -State Listen).OwningProcess -Force`);
        console.error(`   Then run: node server.js\n`);
        process.exit(1);
    } else {
        throw err;
    }
});

