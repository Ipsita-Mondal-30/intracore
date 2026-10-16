import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Avoid missing vendor-chunk errors for Supabase in dev/server bundles
  serverExternalPackages: ["@supabase/supabase-js", "@supabase/ssr"],
  experimental: {
    // Client router cache: a page visited in the last 30 s renders instantly on back/forward
    // or a repeat click. Any mutation calls router.refresh(), which discards it.
    staleTimes: { dynamic: 30, static: 300 },
  },
};

export default nextConfig;
