/**
 * Cloud sync settings.
 *
 * Leave both values empty to run in local-only mode (data stays in the browser).
 * The publishable key is designed to be public: Row Level Security in the
 * database (see supabase/schema.sql) only lets a signed-in owner touch their
 * own rows. NEVER put a "secret" or "service_role" key here.
 */
window.FUEL_CONFIG = {
  supabaseUrl: "https://wwamnfffckfdrgwgicyg.supabase.co",
  supabaseKey: "sb_publishable_dFiapEI-oKHVgz29UG6dAQ_24V7qylZ",
};
