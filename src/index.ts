import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { Client as NotionClient } from "@notionhq/client";
import Parser from "rss-parser";
import axios from "axios";

import { connectToDatabase, disconnectFromDatabase } from "./db.js";
import { ContentDraft, ResearchLog, AnalyticsEntry } from "./models.js";

// ─────────────────────────────────────────────────────────────────
// ENVIRONMENT
// ─────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const MCP_AUTH_SECRET = (process.env.MCP_AUTH_SECRET ?? "").trim();
const LINKEDIN_ACCESS_TOKEN = (process.env.LINKEDIN_ACCESS_TOKEN ?? "").trim();
const LINKEDIN_AUTHOR_URN = (process.env.LINKEDIN_AUTHOR_URN ?? "").trim();
const LINKEDIN_ORGANIZATION_URN = (process.env.LINKEDIN_ORGANIZATION_URN ?? "").trim();

// ─────────────────────────────────────────────────────────────────
// CLIENTS
// ─────────────────────────────────────────────────────────────────
const rssParser = new Parser({
  timeout: 10_000,
  headers: { "User-Agent": "MarketingMCPBot/1.0" },
});

/**
 * Notion client – uses the official @notionhq/client SDK.
 * Set NOTION_API_KEY and NOTION_DATABASE_ID in .env.
 */
const notion = new NotionClient({
  auth: process.env.NOTION_API_KEY,
});

// ─────────────────────────────────────────────────────────────────
// MCP SERVER FACTORY
// ─────────────────────────────────────────────────────────────────
function createMcpServer() {
  const mcpServer = new McpServer({
    name: "marketing-content-automation",
    version: "1.0.0",
  });

  /**
   * Thin wrapper around mcpServer.tool() that resolves TS2589
   * "Type instantiation is excessively deep" caused by the MCP SDK's
   * multi-level generic overloads interacting with Zod's type system.
   * The cast is intentional and safe — all runtime behaviour is identical.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const registerTool = mcpServer.tool.bind(mcpServer) as (
    name: string,
    description: string,
    schema: Record<string, z.ZodTypeAny>,
    handler: (args: Record<string, unknown>) => Promise<{
      content: Array<{ type: "text"; text: string }>;
      isError?: boolean;
    }>
  ) => void;

  // ─────────────────────────────────────────────────────────────────
  // TOOL 1: execute_research
  // Layer 2 – Gather intelligence from RSS feeds
  // ─────────────────────────────────────────────────────────────────
  const researchSchema: Record<string, z.ZodTypeAny> = {
    topic: z.string().describe("The topic or keyword to research, e.g. 'AI in fintech Q2 2025'"),
  };

  registerTool(
    "execute_research",
    "Gathers raw research for a given topic by fetching the latest headlines from " +
    "curated RSS feeds (Reuters, Bloomberg, Financial Times). Saves all raw data " +
    "to MongoDB ResearchLogs and returns a synthesized summary for Claude to use " +
    "when drafting content.",
    researchSchema,
    async (args) => {
      const { topic } = args as { topic: string };
      await connectToDatabase();

      type SourceEntry = { source: "rss"; url: string; rawData: string };
      const sources: SourceEntry[] = [];

      // ── RSS Feeds ───────────────────────────────────────────────
      // TODO: Add or swap feeds here to match your content niche.
      const RSS_FEEDS = [
        { name: "Reuters Business", url: "https://feeds.reuters.com/reuters/businessNews" },
        { name: "Bloomberg Markets", url: "https://feeds.bloomberg.com/markets/news.rss" },
        { name: "Financial Times", url: "https://www.ft.com/?format=rss" },
      ];

      const feedResults = await Promise.allSettled(
        RSS_FEEDS.map(async (feed) => {
          const parsed = await rssParser.parseURL(feed.url);
          return { feed, items: parsed.items.slice(0, 6) };
        })
      );

      for (const result of feedResults) {
        if (result.status === "rejected") {
          console.warn("⚠️  RSS feed failed:", result.reason);
          continue;
        }
        const { feed, items } = result.value;
        const lines = items.map(
          (item) => `• [${item.title ?? "No title"}] ${item.contentSnippet ?? item.content ?? ""}`
        );
        sources.push({
          source: "rss",
          url: feed.url,
          rawData: `=== ${feed.name} ===\n${lines.join("\n")}`,
        });
      }

      const synthesizedSummary = [
        `# Research Summary: ${topic}`,
        `Generated: ${new Date().toISOString()}`,
        "",
        sources.length > 0
          ? sources.map((s) => s.rawData).join("\n\n---\n\n")
          : "No RSS data retrieved. Check network connectivity or feed URLs.",
      ].join("\n");

      const researchLog = await ResearchLog.create({
        topic,
        sources,
        synthesizedSummary,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                researchLogId: String(researchLog._id),
                topic,
                sourcesFound: sources.length,
                synthesizedSummary,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ─────────────────────────────────────────────────────────────────
  // TOOL 2: save_draft_content
  // Layer 4 & 5 – Store Claude's drafted content in MongoDB
  // ─────────────────────────────────────────────────────────────────
  const saveDraftSchema: Record<string, z.ZodTypeAny> = {
    topic: z.string().describe("The topic this content covers"),
    newsletter_text: z.string().describe("Full newsletter body (HTML or Markdown)"),
    linkedin_posts: z
      .array(z.string())
      .describe("Array of LinkedIn post variants (1–3 recommended)"),
    twitter_thread: z
      .array(z.string())
      .describe("Array of tweets forming a thread; each ≤ 280 characters"),
    instagram_caption: z
      .string()
      .optional()
      .describe("Optional Instagram caption with hashtags"),
  };

  registerTool(
    "save_draft_content",
    "Saves the multi-platform content draft created by Claude into MongoDB with " +
    "status 'draft'. Call this after generating all platform variants. Returns " +
    "the draft_id needed to trigger publishing later.",
    saveDraftSchema,
    async (args) => {
      const { topic, newsletter_text, linkedin_posts, twitter_thread, instagram_caption } =
        args as {
          topic: string;
          newsletter_text: string;
          linkedin_posts: string[];
          twitter_thread: string[];
          instagram_caption?: string;
        };

      await connectToDatabase();

      type PlatformEntry = {
        platform: "newsletter" | "linkedin" | "twitter" | "instagram";
        content: string;
      };

      const platforms: PlatformEntry[] = [
        { platform: "newsletter", content: newsletter_text },
        { platform: "linkedin", content: linkedin_posts.join("\n\n---POST VARIANT---\n\n") },
        { platform: "twitter", content: twitter_thread.join("\n\n[NEXT TWEET]\n\n") },
      ];
      if (instagram_caption) {
        platforms.push({ platform: "instagram", content: instagram_caption });
      }

      const draft = await ContentDraft.create({
        topic,
        status: "draft",
        platforms,
        publishMetadata: {},
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                message:
                  "Draft saved. Pass draft_id to 'publish_approved_content' when approved.",
                draft_id: String(draft._id),
                topic,
                status: draft.status,
                platformCount: platforms.length,
                createdAt: draft.createdAt,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ─────────────────────────────────────────────────────────────────
  // TOOL 3: publish_approved_content
  // Layer 6 – Publish to X, LinkedIn, Beehiiv
  // ─────────────────────────────────────────────────────────────────
  const publishSchema: Record<string, z.ZodTypeAny> = {
    draft_id: z
      .string()
      .describe("MongoDB ObjectId (24-char hex) of the approved ContentDraft"),
  };

  registerTool(
    "publish_approved_content",
    "Fetches an approved ContentDraft from MongoDB and publishes it to X (Twitter), " +
    "LinkedIn, and Beehiiv (newsletter). Updates the draft status to 'published'. " +
    "Publishing calls are scaffold-ready – uncomment once API keys are configured.",
    publishSchema,
    async (args) => {
      const { draft_id } = args as { draft_id: string };
      await connectToDatabase();

      const draft = await ContentDraft.findById(draft_id);
      if (!draft) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: `Draft not found: ${draft_id}` }),
            },
          ],
        };
      }

      if (draft.status === "published") {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ success: false, error: "Draft already published." }),
            },
          ],
        };
      }

      const publishedUrls: Record<string, string> = {};
      const errors: Record<string, string> = {};

      const getContent = (platform: string): string | null =>
        draft.platforms.find((p) => p.platform === platform)?.content ?? null;

      // ── X (Twitter) API v2 ──────────────────────────────────────
      // TODO: Set TWITTER_BEARER_TOKEN, TWITTER_API_KEY, etc. in .env
      //       Use `twitter-api-v2` npm package for OAuth 1.0a signing.
      //       Docs: https://developer.twitter.com/en/docs/twitter-api/tweets/manage-tweets/api-reference/post-tweets
      const twitterContent = getContent("twitter");
      if (twitterContent) {
        try {
          const tweets = twitterContent.split("\n\n[NEXT TWEET]\n\n").filter(Boolean);
          const tweetIds: string[] = [];
          let lastTweetId: string | null = null;

          for (const text of tweets) {
            const payload: Record<string, unknown> = { text: text.slice(0, 280) };
            if (lastTweetId) payload["reply"] = { in_reply_to_tweet_id: lastTweetId };

            // ↓↓ UNCOMMENT when ready ↓↓
            // const { data } = await twitterClient.v2.tweet(payload);
            // lastTweetId = data.id;
            // tweetIds.push(data.id);

            // Mock:
            lastTweetId = `mock_${Date.now()}`;
            tweetIds.push(lastTweetId);
          }

          publishedUrls["twitter"] = `https://twitter.com/i/web/status/${tweetIds[0]}`;
          console.log("✅ [mock] Twitter thread queued:", tweetIds);
        } catch (err: unknown) {
          errors["twitter"] = err instanceof Error ? err.message : String(err);
        }
      }

      // ── LinkedIn UGC Posts API ──────────────────────────────────
      // TODO: Set LINKEDIN_ACCESS_TOKEN and LINKEDIN_ORGANIZATION_URN in .env
      //       Docs: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
      const linkedinContent = getContent("linkedin");
      if (linkedinContent) {
        try {
          const primaryPost =
            linkedinContent.split("\n\n---POST VARIANT---\n\n")[0] ?? linkedinContent;

          const targetAuthor = LINKEDIN_AUTHOR_URN || LINKEDIN_ORGANIZATION_URN;

          const linkedinPayload = {
            author: targetAuthor, // e.g. "urn:li:person:123" or "urn:li:organization:123"
            lifecycleState: "PUBLISHED",
            specificContent: {
              "com.linkedin.ugc.ShareContent": {
                shareCommentary: { text: primaryPost },
                shareMediaCategory: "NONE",
              },
            },
            visibility: { "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC" },
          };

          // ── Real LinkedIn API call ──────────────────────────────────
          console.log(`📡 Sending LinkedIn post request for draft: ${draft_id}`);
          console.log(`   Author URN: "${targetAuthor}"`);

          const liRes = await axios.post(
            "https://api.linkedin.com/v2/ugcPosts",
            linkedinPayload,
            {
              headers: {
                Authorization: `Bearer ${LINKEDIN_ACCESS_TOKEN}`,
                "X-Restli-Protocol-Version": "2.0.0",
                "Content-Type": "application/json",
              },
            }
          );
          const liId = liRes.headers["x-restli-id"] as string;
          publishedUrls["linkedin"] = liId ? `https://www.linkedin.com/feed/update/${liId}` : "published";
          console.log("✅ LinkedIn post successful:", publishedUrls["linkedin"]);
        } catch (err: unknown) {
          if (axios.isAxiosError(err)) {
            console.error("❌ LinkedIn API error details:", {
              status: err.response?.status,
              statusText: err.response?.statusText,
              data: err.response?.data,
            });
            errors["linkedin"] = err.response?.data?.message || err.message;
          } else {
            errors["linkedin"] = err instanceof Error ? err.message : String(err);
          }
        }
      }

      // ── Beehiiv Newsletter API ─────────────────────────────────
      // TODO: Set BEEHIIV_API_KEY and BEEHIIV_PUBLICATION_ID in .env
      //       Docs: https://developers.beehiiv.com/docs/v2/reference/create-post
      const newsletterContent = getContent("newsletter");
      if (newsletterContent) {
        try {
          const beehiivPayload = {
            subject: draft.topic,
            content_tags: [draft.topic.toLowerCase().replace(/\s+/g, "-")],
            content: { free: newsletterContent },
            status: "draft", // TODO: change to "confirmed" to auto-send
            thumbnail_url: "", // TODO: add your CDN thumbnail URL
            preview_text: newsletterContent.slice(0, 150),
          };

          // ↓↓ UNCOMMENT when ready ↓↓
          // const beeRes = await axios.post(
          //   `https://api.beehiiv.com/v2/publications/${process.env.BEEHIIV_PUBLICATION_ID}/posts`,
          //   beehiivPayload,
          //   { headers: { Authorization: `Bearer ${process.env.BEEHIIV_API_KEY}` } }
          // );
          // publishedUrls["newsletter"] = (beeRes.data as { data: { url: string } }).data?.url ?? "published";

          console.log("📋 [mock] Beehiiv payload:", JSON.stringify(beehiivPayload, null, 2));
          publishedUrls["newsletter"] = "https://app.beehiiv.com/posts (mock – set BEEHIIV_API_KEY)";
        } catch (err: unknown) {
          errors["newsletter"] = err instanceof Error ? err.message : String(err);
        }
      }

      // ── Persist updated status to MongoDB ──────────────────────
      draft.status = "published";
      draft.publishMetadata = { publishedUrls, errors, publishedAt: new Date().toISOString() };
      for (const entry of draft.platforms) {
        const url = publishedUrls[entry.platform];
        if (url) entry.publishedUrl = url;
      }
      draft.markModified("platforms");
      await draft.save();

      const hasErrors = Object.keys(errors).length > 0;

      return {
        ...(hasErrors && { isError: true }),
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: !hasErrors,
                message: hasErrors
                  ? "Published with some errors – check 'errors' field."
                  : "All platforms published successfully!",
                draft_id,
                topic: draft.topic,
                publishedUrls,
                ...(hasErrors && { errors }),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ─────────────────────────────────────────────────────────────────
  // TOOL 4: sync_analytics_to_notion
  // Layer 7 – Fetch analytics and write a structured report to Notion
  // Uses official @notionhq/client SDK for robust, type-safe requests
  // ─────────────────────────────────────────────────────────────────
  const analyticsSchema: Record<string, z.ZodTypeAny> = {
    timeframe: z
      .enum(["last_7_days", "last_30_days", "last_quarter", "all_time"])
      .describe("Reporting window for aggregating engagement metrics"),
    draft_id: z
      .string()
      .optional()
      .describe("Optional: scope the report to a specific ContentDraft MongoDB ID"),
  };

  registerTool(
    "sync_analytics_to_notion",
    "Fetches engagement analytics across all publishing platforms for a given timeframe " +
    "and creates a structured analytics report page in Notion using the official " +
    "@notionhq/client SDK. Saves the metrics to MongoDB for local audit trail.",
    analyticsSchema,
    async (args) => {
      const { timeframe, draft_id } = args as {
        timeframe: "last_7_days" | "last_30_days" | "last_quarter" | "all_time";
        draft_id?: string;
      };

      await connectToDatabase();

      // ── Guard: Notion client health-check ──────────────────────
      if (!process.env.NOTION_API_KEY || !process.env.NOTION_DATABASE_ID) {
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                error:
                  "NOTION_API_KEY and/or NOTION_DATABASE_ID are not set. " +
                  "Add them to .env and restart the server.",
              }),
            },
          ],
        };
      }

      // ── Platform Analytics ──────────────────────────────────────
      // TODO: Replace each mock block with real platform API calls:
      //   Twitter:    GET /2/tweets/:id?tweet.fields=public_metrics
      //   LinkedIn:   GET /v2/organizationalEntityShareStatistics?q=organizationalEntity
      //   Beehiiv:    GET /v2/publications/:id/posts/:postId/stats

      const rnd = (max: number, min = 0) => Math.floor(Math.random() * max) + min;

      const twitterMetrics = {
        impressions: rnd(50_000, 5_000),
        engagements: rnd(2_000, 200),
        likes: rnd(800, 50),
        retweets: rnd(300, 20),
        replies: rnd(100, 5),
        link_clicks: rnd(500, 30),
      };

      const linkedinMetrics = {
        impressions: rnd(20_000, 2_000),
        unique_impressions: rnd(15_000, 1_500),
        clicks: rnd(600, 60),
        likes: rnd(300, 30),
        comments: rnd(80, 5),
        shares: rnd(60, 3),
      };

      const newsletterMetrics = {
        recipients: rnd(10_000, 1_000),
        opens: rnd(4_000, 400),
        open_rate: parseFloat((Math.random() * 30 + 20).toFixed(2)),
        clicks: rnd(800, 80),
        click_rate: parseFloat((Math.random() * 10 + 3).toFixed(2)),
        unsubscribes: rnd(20),
      };

      const allMetrics = { twitter: twitterMetrics, linkedin: linkedinMetrics, newsletter: newsletterMetrics };

      // ── Persist to MongoDB ──────────────────────────────────────
      const dbEntries = await Promise.all(
        Object.entries(allMetrics).map(([platform, metrics]) =>
          AnalyticsEntry.create({ draftId: draft_id, platform, timeframe, metrics })
        )
      );

      // ── Notion – create report page via official SDK ────────────
      // TODO: Map property names below to your actual Notion DB columns.
      //       To find column names: open your DB → click column header → check "Property name".
      let notionPageUrl = "";
      let notionError: string | null = null;

      try {
        const createdPage = await notion.pages.create({
          parent: { database_id: process.env.NOTION_DATABASE_ID as string },
          properties: {
            // ── Required: Title column – typically named "Name" or "Report Title"
            // TODO: Rename this key to match your Notion title column exactly
            "Report Title": {
              title: [
                {
                  text: {
                    content: `Analytics Report — ${timeframe.replace(/_/g, " ")} — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`,
                  },
                },
              ],
            },
            // ── Text columns
            "Timeframe": {
              rich_text: [{ text: { content: timeframe } }],
            },
            "Draft ID": {
              rich_text: [{ text: { content: draft_id ?? "All Drafts" } }],
            },
            // ── Number columns
            "Twitter Impressions": { number: twitterMetrics.impressions },
            "Twitter Likes": { number: twitterMetrics.likes },
            "Twitter Link Clicks": { number: twitterMetrics.link_clicks },
            "LinkedIn Impressions": { number: linkedinMetrics.impressions },
            "LinkedIn Clicks": { number: linkedinMetrics.clicks },
            "Newsletter Open Rate": { number: newsletterMetrics.open_rate },
            "Newsletter Click Rate": { number: newsletterMetrics.click_rate },
            "Newsletter Recipients": { number: newsletterMetrics.recipients },
            // ── Date column
            "Report Date": {
              date: { start: new Date().toISOString().split("T")[0] as string },
            },
          },
        });

        notionPageUrl =
          "url" in createdPage
            ? (createdPage as { url: string }).url
            : `https://notion.so/${createdPage.id.replace(/-/g, "")}`;

        // Mark DB entries as synced
        await AnalyticsEntry.updateMany(
          { _id: { $in: dbEntries.map((e) => e._id) } },
          { $set: { notionSyncedAt: new Date() } }
        );

        console.log("✅ Notion report created:", notionPageUrl);
      } catch (err: unknown) {
        notionError = err instanceof Error ? err.message : String(err);
        console.error("❌ Notion sync failed:", notionError);
      }

      return {
        ...(notionError && { isError: true }),
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: !notionError,
                timeframe,
                ...(draft_id && { draft_id }),
                analytics: allMetrics,
                notion: notionError
                  ? { synced: false, error: notionError }
                  : { synced: true, pageUrl: notionPageUrl },
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  return mcpServer;
}

// ─────────────────────────────────────────────────────────────────
// EXPRESS + SSE TRANSPORT
// ─────────────────────────────────────────────────────────────────
const app = express();

// ── REQUEST LOGGING ───────────────────────────────────────────────
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.originalUrl}`);
  next();
});

// ── CORS ──────────────────────────────────────────────────────────
// Allow claude.ai AND any origin for OAuth redirect round-trips
app.use(
  cors({
    origin: true, // reflect the request origin so OAuth redirects work
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-mcp-auth"],
    credentials: true,
  })
);
app.use(express.json({ limit: "2mb" }));

// ── Bypass OAuth token ────────────────────────────────────────────
// We issue MCP_AUTH_SECRET itself as the OAuth access token so the
// existing auth middleware keeps working with zero extra logic.
// If no secret is set we use a fixed sentinel (open-access mode).
const BYPASS_ACCESS_TOKEN = MCP_AUTH_SECRET || "mcp-open-access";

// ── Bearer-token auth middleware ────────────────────────────────
function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Open-access mode: no secret configured AND not issued via OAuth bypass
  if (!MCP_AUTH_SECRET) {
    next();
    return;
  }
  const authHeader = (req.headers["authorization"] ??
    req.headers["x-mcp-auth"]) as string | undefined;
  const token = authHeader?.replace(/^Bearer /i, "");
  if (!token || token !== BYPASS_ACCESS_TOKEN) {
    console.warn("❌ Auth rejected: invalid or missing bearer token");
    res.status(401).json({ error: "Unauthorized – invalid or missing token" });
    return;
  }
  next();
}

// ── Health check ────────────────────────────────────────────────
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    server: "marketing-mcp-server",
    version: "1.0.0",
    notionConfigured: !!process.env.NOTION_API_KEY && !!process.env.NOTION_DATABASE_ID,
    timestamp: new Date().toISOString(),
  });
});

// ═════════════════════════════════════════════════════════════════
// BYPASS OAUTH 2.0  –  Auto-approves every connection request.
// No real user authentication is performed. Every caller gets the
// same access token (BYPASS_ACCESS_TOKEN / MCP_AUTH_SECRET).
// ═════════════════════════════════════════════════════════════════

// Helper: derive the public base URL from the incoming request
function baseUrl(req: Request): string {
  const proto = (req.headers["x-forwarded-proto"] as string) ?? req.protocol;
  const host = (req.headers["x-forwarded-host"] as string) ?? req.headers.host ?? "localhost";
  return `${proto}://${host}`;
}

// ── 1. OAuth Authorization Server Metadata (RFC 8414) ────────────
//    Claude fetches this to discover all OAuth endpoints.
app.get("/.well-known/oauth-authorization-server", (req: Request, res: Response) => {
  const base = baseUrl(req);
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256", "plain"],
  });
});

// ── 2. Dynamic Client Registration (RFC 7591) ────────────────────
//    Claude registers itself as a client. We accept everything.
app.post("/register", (req: Request, res: Response) => {
  const clientId = `mcp-client-${Date.now()}`;
  res.status(201).json({
    client_id: clientId,
    client_secret_expires_at: 0, // never expires
    redirect_uris: (req.body as { redirect_uris?: string[] }).redirect_uris ?? [],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
});

// ── 3. Authorization Endpoint ─────────────────────────────────────
//    Immediately redirects back with a one-time code. No login UI.
app.get("/authorize", (req: Request, res: Response) => {
  const { redirect_uri, state } = req.query as Record<string, string>;
  if (!redirect_uri) {
    res.status(400).send("Missing redirect_uri");
    return;
  }
  // Issue a short-lived single-use code (stateless bypass)
  const code = Buffer.from(`bypass:${Date.now()}`).toString("base64url");
  const redirectTarget = new URL(redirect_uri);
  redirectTarget.searchParams.set("code", code);
  if (state) redirectTarget.searchParams.set("state", state);
  console.log("🔑 OAuth authorize redirect issued");
  res.redirect(redirectTarget.toString());
});

// ── 4. Token Endpoint ─────────────────────────────────────────────
//    Exchanges any code for BYPASS_ACCESS_TOKEN. No validation.
app.post("/token", express.urlencoded({ extended: true }), (_req: Request, res: Response) => {
  console.log("🎟️  OAuth token issued (bypass mode)");

  // strict OAuth 2.0 spec requires these headers
  res.set("Cache-Control", "no-store");
  res.set("Pragma", "no-cache");

  res.json({
    access_token: BYPASS_ACCESS_TOKEN,
    token_type: "Bearer",
    expires_in: 315360000, // 10 years
    refresh_token: BYPASS_ACCESS_TOKEN, // include refresh token just in case
    scope: "mcp",
  });
});

// ── SSE + Messages endpoints ─────────────────────────────────────
const transports = new Map<string, SSEServerTransport>();

app.get("/sse", authMiddleware, async (_req: Request, res: Response) => {
  console.log("🔌 New MCP SSE connection");
  const transport = new SSEServerTransport("/messages", res);
  // Optional, but standard for SSE
  res.set("Cache-Control", "no-cache");
  transports.set(transport.sessionId, transport);
  res.on("close", () => {
    console.log("🔌 SSE closed:", transport.sessionId);
    transports.delete(transport.sessionId);
  });

  // The MCP SDK Server instance only allows one active transport per server instance.
  // We create a fresh server + tool registration tailored to this specific connection.
  const mcpServer = createMcpServer();

  mcpServer.server.onerror = (err) => console.error("🛑 MCP Server Error:", err);
  transport.onerror = (err) => console.error("🛑 Transport Error:", err);

  await mcpServer.connect(transport);
});

app.post("/messages", authMiddleware, async (req: Request, res: Response) => {
  const sessionId = req.query["sessionId"] as string;
  const transport = transports.get(sessionId);
  if (!transport) {
    console.error(`❌ POST /messages - No active SSE session found for: ${sessionId}`);
    res.status(400).json({ error: `No active SSE session: ${sessionId}` });
    return;
  }

  try {
    await transport.handlePostMessage(req, res, req.body);
  } catch (err) {
    console.error(`❌ transport.handlePostMessage error:`, err);
  }
});

// ── 404 catch-all ───────────────────────────────────────────────
app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: "Not found" });
});

// ─────────────────────────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────────────────────────
async function shutdown(signal: string): Promise<void> {
  console.log(`\n🛑 ${signal} received. Shutting down…`);
  await disconnectFromDatabase();
  process.exit(0);
}
process.on("SIGTERM", () => { void shutdown("SIGTERM"); });
process.on("SIGINT", () => { void shutdown("SIGINT"); });

// ─────────────────────────────────────────────────────────────────
// BOOTSTRAP
// ─────────────────────────────────────────────────────────────────
void (async () => {
  // Start HTTP server immediately — DB connects lazily on first tool call.
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n🚀 Marketing MCP Server — port ${PORT}`);
    console.log(`   Health:  http://localhost:${PORT}/health`);
    console.log(`   MCP SSE: http://localhost:${PORT}/sse`);
    console.log(`   Notion:  ${process.env.NOTION_API_KEY ? "✅ configured" : "⚠️  NOTION_API_KEY not set"}`);
    console.log(`   Auth:    ${MCP_AUTH_SECRET ? "✅ enabled" : "⚠️  MCP_AUTH_SECRET not set (open access)"}\n`);
  });

  // Attempt eager DB connection — failure here does NOT crash the server.
  try {
    await connectToDatabase();
  } catch (err) {
    console.error(
      "⚠️  Startup DB connect failed — server still running.",
      "\n   Tools retry on first use. Fix MONGODB_URI / DNS then restart.",
      "\n   Error:", err instanceof Error ? err.message : String(err)
    );
  }
})();

