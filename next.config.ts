import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Avoid missing vendor-chunk errors for Supabase in dev/server bundles
  serverExternalPackages: ["@supabase/supabase-js", "@supabase/ssr"],
};

export default nextConfig;
