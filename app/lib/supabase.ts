import { createClient } from "@supabase/supabase-js";

export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
export const supabaseKey =
  (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined) ||
  (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined);

const hasUsableConfig =
  Boolean(supabaseUrl && supabaseKey) &&
  !supabaseUrl?.includes("YOUR_PROJECT") &&
  !supabaseKey?.startsWith("YOUR_");

export const supabase =
  hasUsableConfig ? createClient(supabaseUrl!, supabaseKey!) : null;
