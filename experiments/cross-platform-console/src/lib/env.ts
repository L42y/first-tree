/**
 * Runtime configuration for the Expo app.
 *
 * Use EXPO_PUBLIC_* variables so they are inlined by Metro at build time.
 * Never commit secrets here; the First Tree API base URL is the only
 * configurable runtime value needed for the experiment.
 *
 * The experiment targets the dev/staging channel by default (the same
 * deployment as https://dev.cloud.first-tree.ai) — production is never
 * touched from this app. Override with EXPO_PUBLIC_API_BASE_URL.
 */

const DEFAULT_API_BASE_URL = "https://dev.cloud.first-tree.ai";

export const API_BASE_URL = (process.env.EXPO_PUBLIC_API_BASE_URL as string | undefined) ?? DEFAULT_API_BASE_URL;

export const API_BASE = `${API_BASE_URL}/api/v1`;

export const TOKEN_KEY = "first-tree:tokens";
export const SELECTED_ORG_KEY = "first-tree:selectedOrganizationId";
