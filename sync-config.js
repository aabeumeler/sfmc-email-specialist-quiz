window.SFMC_SYNC_CONFIG = Object.freeze({
  // These are public browser connection values, not passwords or secret keys.
  // Fill them in after the Supabase setup is complete.
  supabaseUrl: "",
  supabasePublishableKey: "",

  // Fill this in after deploying the included Cloudflare region worker.
  // It is called only after a user opts in to anonymous analytics.
  regionEndpoint: "",

  adminPage: "admin.html"
});
