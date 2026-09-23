import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json; charset=utf-8",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing Supabase service configuration");
}

const supabase = createClient(
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  },
);

function safeHttpStatus(value: unknown, fallback = 500): number {
  const status = typeof value === "number" ? value : Number(value);

  if (Number.isInteger(status) && status >= 200 && status <= 599) {
    return status;
  }

  return fallback;
}

function jsonResponse(body: unknown, status = 200): Response {
  const safeStatus = safeHttpStatus(status, 200);
  console.log("[lesson-explanation] RESPONSE", { status: safeStatus });

  return new Response(JSON.stringify(body), {
    status: safeStatus,
    headers: corsHeaders,
  });
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      status: 200,
      headers: corsHeaders,
    });
  }

  if (req.method !== "POST") {
    return jsonResponse(
      {
        success: false,
        error: "Method not allowed",
      },
      405,
    );
  }

  try {
    const body = await req.json() as {
      document_id?: unknown;
      section_id?: unknown;
    };

    const documentId = readString(body.document_id);
    const sectionId = readString(body.section_id);

    console.log("[lesson-explanation] REQUEST", {
      documentId,
      sectionId,
    });

    if (!documentId || !sectionId) {
      return jsonResponse(
        {
          success: false,
          error: "document_id and section_id are required",
        },
        400,
      );
    }

    const { data, error } = await supabase
      .from("lesson_explanation_cache")
      .select(
        "id, answer_markdown, answer_hash, cache_key, source_hash, model, cache_version, source_count, document_id, section_id, status, created_at, updated_at",
      )
      .eq("document_id", documentId)
      .eq("section_id", sectionId)
      .eq("status", "ready")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.error("[lesson-explanation] QUERY ERROR", error.message);
      return jsonResponse(
        {
          success: false,
          error: "تعذر تحميل الشرح المحفوظ لهذا الدرس.",
        },
        500,
      );
    }

    if (!data || typeof data.answer_markdown !== "string" || !data.answer_markdown.trim()) {
      console.log("[lesson-explanation] CACHE MISS", {
        documentId,
        sectionId,
      });

      return jsonResponse({
        success: true,
        cached: false,
        explanation_cache_id: null,
        answer: null,
      });
    }

    console.log("[lesson-explanation] CACHE HIT", {
      documentId,
      sectionId,
      explanationCacheId: data.id,
      answerHash: data.answer_hash,
    });

    return jsonResponse({
      success: true,
      cached: true,
      explanation_cache_id: data.id,
      answer: data.answer_markdown,
      answer_hash: data.answer_hash,
      cache_key: data.cache_key,
      source_hash: data.source_hash,
      model: data.model,
      cache_version: data.cache_version,
      source_count: data.source_count,
      created_at: data.created_at,
      updated_at: data.updated_at,
    });
  } catch (error) {
    console.error("[lesson-explanation] ERROR", error);

    return jsonResponse(
      {
        success: false,
        error: "تعذر تحميل الشرح المحفوظ لهذا الدرس.",
      },
      500,
    );
  }
});
